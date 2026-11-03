/**
 * Backup service (WP-20): scheduled / on-lock encrypted backups to a user-chosen folder, retention of the N most
 * recent, restore into an empty data directory, and stale-lock safety.
 *
 * The encrypted bundle itself is produced by VaultService.backup (VACUUM INTO copy sealed with XChaCha20-Poly1305
 * under an Argon2id-derived key); this service decides when and where.
 *
 * The backup passphrase is stored INSIDE the encrypted database (meta `backup.config`) so unattended backups can run
 * while the vault is unlocked. It is only readable while unlocked; the user must remember it for restores.
 *
 * Stale-lock safety: a `.vss-backup.lock` file in the target folder (pid + time) prevents two instances writing at
 * once; it is ignored (and removed) when older than 15 minutes or when its pid is gone. Half-written `.partial`
 * files are never listed as backups and are swept when older than one hour.
 *
 * File names are `vss-backup-YYYYMMDD-HHMMSS[-N].vssbak`; a second backup within the same second gets `-2`, `-3`...
 * instead of replacing the first (lane J gap). Listing and pruning order by (time, N), not by string.
 *
 * Recovery passphrase generations (lane J gap): regenerating the passphrase keeps the older ones (newest first, up
 * to MAX_PREVIOUS) inside the encrypted DB and writes `vss-backup-keyring.vsskeys` next to the backups: the older
 * passphrases sealed under the CURRENT one (same envelope as a backup). A restore that fails with the passphrase the
 * user typed opens the keyring in the backup's folder with it and retries with each older passphrase, so the newest
 * passphrase restores every backup in the folder, including those made before a regeneration. Without the keyring
 * file (deleted, other folder) an old backup still needs the passphrase it was made with.
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import type {
  Result,
  VaultBackupRequest,
  VaultBackupResult,
  VaultRestoreRequest,
  VaultStatus,
} from '@shared/ipc/contract';
import { err, ok } from '@shared/ipc/result';
import { openBackup, sealBackup } from '../crypto/envelope';
import type { Argon2idParams } from '../crypto/kdf';
import type { MetaRepo } from '../db/repos';

export const BACKUP_EXT = '.vssbak';
export const BACKUP_NAME = /^vss-backup-(\d{8})-(\d{6})(?:-(\d{1,3}))?\.vssbak$/;
export const KEYRING_NAME = 'vss-backup-keyring.vsskeys';
/** Older recovery passphrases kept (newest first). */
export const MAX_PREVIOUS = 20;
const KEYRING_FORMAT = 'vss-backup-keyring';
const KEYRING_META = 'backup.keyring';
const MAX_KEYRING_BYTES = 64 * 1024;

/** Sort key of a backup file name: time stamp, then same-second sequence (1 for no suffix). */
function nameKey(name: string): [string, number] {
  const m = BACKUP_NAME.exec(name);
  return m ? [`${m[1]}${m[2]}`, m[3] ? Number(m[3]) : 1] : ['', 0];
}
const newestFirst = (a: string, b: string): number => {
  const [ta, sa] = nameKey(a);
  const [tb, sb] = nameKey(b);
  return ta !== tb ? (ta < tb ? 1 : -1) : sb - sa;
};
export const LOCK_NAME = '.vss-backup.lock';
export const LOCK_STALE_MS = 15 * 60 * 1000;
export const PARTIAL_STALE_MS = 60 * 60 * 1000;
const CONFIG_KEY = 'backup.config';
/** Epoch ms of the last successful backup (read by the dashboard: services/vetting.ts BACKUP_LAST_META_KEY). */
export const LAST_KEY = 'backup.last';

export interface BackupConfig {
  /** Absolute folder chosen by the user. */
  dir: string;
  /** Number of most recent backups to keep (1..100). */
  keep: number;
  /** Back up when the vault locks (manual / idle). */
  onLock: boolean;
  /** Also back up every N hours while unlocked; null = off. */
  everyHours: number | null;
  passphrase: string;
  /** Earlier recovery passphrases, newest first (kept so older backups stay restorable). */
  previous?: string[];
}
export type PublicBackupConfig = Omit<BackupConfig, 'passphrase' | 'previous'> & { hasPassphrase: true };

export interface BackupDeps {
  meta(): MetaRepo;
  /** VaultService.backup */
  vaultBackup(req: VaultBackupRequest): Promise<Result<VaultBackupResult>>;
  /** VaultService.restore */
  vaultRestore(req: VaultRestoreRequest): Promise<Result<VaultStatus>>;
  /** Folder the vault lives in (never a valid backup target). */
  dataDir: string;
  now?(): number;
  pid?: number;
  isPidAlive?(pid: number): boolean;
  /** Argon2id params for sealing the passphrase keyring (default: the envelope default). */
  keyringKdf?: Argon2idParams;
}

const stamp = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
};

/** Older passphrases from a keyring file, or [] (missing, too large, wrong passphrase, malformed). */
export async function readKeyring(path: string, passphrase: string): Promise<string[]> {
  try {
    const s = await stat(path);
    if (!s.isFile() || s.size > MAX_KEYRING_BYTES) return [];
    const plain = await openBackup(await readFile(path), passphrase);
    const j = JSON.parse(Buffer.from(plain).toString('utf8')) as { format?: unknown; passphrases?: unknown };
    if (j.format !== KEYRING_FORMAT || !Array.isArray(j.passphrases)) return [];
    return j.passphrases
      .filter((p): p is string => typeof p === 'string' && p.length >= 12 && p.length <= 256)
      .slice(0, MAX_PREVIOUS);
  } catch {
    return [];
  }
}

const defaultAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export function validateConfig(c: BackupConfig, dataDir: string): string | null {
  if (!isAbsolute(c.dir)) return 'Backup folder must be an absolute path';
  if (c.dir.replace(/[\\/]+$/, '').toLowerCase() === dataDir.replace(/[\\/]+$/, '').toLowerCase()) {
    return 'Backups must not be written into the vault folder';
  }
  if (!Number.isInteger(c.keep) || c.keep < 1 || c.keep > 100) return 'Keep between 1 and 100 backups';
  if (c.everyHours !== null && (!Number.isInteger(c.everyHours) || c.everyHours < 1 || c.everyHours > 720)) {
    return 'Interval must be 1..720 hours';
  }
  if (c.passphrase.length < 12) return 'Backup passphrase must be at least 12 characters';
  return null;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/**
 * High-entropy recovery passphrase: 160 random bits as 32 Crockford base32 characters in 8 groups of 4
 * (e.g. `7K2M-...`). Generated by VSS, never chosen by the user, shown once.
 */
export function generateRecoveryPassphrase(rand: (n: number) => Uint8Array = (n) => randomBytes(n)): string {
  const bytes = rand(20);
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  return out.match(/.{4}/g)!.join('-');
}

export type BackupSchedule = Omit<BackupConfig, 'passphrase'>;

export class BackupService {
  readonly #d: BackupDeps;
  #running = false;

  constructor(deps: BackupDeps) {
    this.#d = deps;
  }

  #now(): number {
    return (this.#d.now ?? Date.now)();
  }

  #load(): BackupConfig | null {
    const raw = this.#d.meta().get(CONFIG_KEY);
    if (!raw) return null;
    try {
      const c = JSON.parse(raw) as BackupConfig;
      return validateConfig(c, this.#d.dataDir) ? null : c;
    } catch {
      return null;
    }
  }

  configure(c: BackupConfig): Result<PublicBackupConfig> {
    const bad = validateConfig(c, this.#d.dataDir);
    if (bad) return err('BAD_REQUEST', bad);
    this.#d.meta().set(CONFIG_KEY, JSON.stringify(c));
    return ok(this.#public(c));
  }

  /** Epoch ms of the last successful backup, null when never. */
  lastAt(): number | null {
    const v = Number(this.#d.meta().get(LAST_KEY) ?? 0);
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  /** Record a successful backup made outside runNow (e.g. a manual vault.backup to a chosen file). */
  noteSuccess(): void {
    this.#d.meta().set(LAST_KEY, String(this.#now()));
  }

  /**
   * Save the schedule. A recovery passphrase is generated on first setup (or when `regenerate`), stored inside the
   * encrypted DB and returned exactly once; otherwise the stored one is kept and `newPassphrase` is null.
   */
  configureSchedule(
    s: BackupSchedule,
    opts: { regenerate?: boolean; generate?: () => string } = {},
  ): Result<{ config: PublicBackupConfig; newPassphrase: string | null }> {
    const existing = this.#load();
    const fresh = !existing || opts.regenerate === true;
    const passphrase = fresh ? (opts.generate ?? generateRecoveryPassphrase)() : existing.passphrase;
    const previous = !existing
      ? []
      : fresh
        ? [existing.passphrase, ...(existing.previous ?? [])].slice(0, MAX_PREVIOUS)
        : (existing.previous ?? []);
    const r = this.configure({ ...s, passphrase, ...(previous.length ? { previous } : {}) });
    if (!r.ok) return r;
    return ok({ config: r.value, newPassphrase: fresh ? passphrase : null });
  }

  clearConfig(): void {
    this.#d.meta().delete(CONFIG_KEY);
  }

  config(): PublicBackupConfig | null {
    const c = this.#load();
    return c ? this.#public(c) : null;
  }

  #public(c: BackupConfig): PublicBackupConfig {
    return { dir: c.dir, keep: c.keep, onLock: c.onLock, everyHours: c.everyHours, hasPassphrase: true };
  }

  /** True when an on-lock backup is configured. */
  get wantsLockBackup(): boolean {
    try {
      return this.#load()?.onLock === true;
    } catch {
      return false;
    }
  }

  /** Run a backup if the interval has elapsed. Call from a timer while unlocked. */
  async runIfDue(): Promise<Result<VaultBackupResult> | null> {
    const c = this.#load();
    if (!c || c.everyHours === null) return null;
    const last = Number(this.#d.meta().get(LAST_KEY) ?? 0);
    if (last && this.#now() >= last && this.#now() - last < c.everyHours * 3_600_000) return null;
    return this.runNow();
  }

  async runNow(): Promise<Result<VaultBackupResult>> {
    const c = this.#load();
    if (!c) return err('NOT_FOUND', 'No backup folder is configured');
    if (this.#running) return err('CONFLICT', 'A backup is already running');
    this.#running = true;
    let haveLock = false;
    try {
      await mkdir(c.dir, { recursive: true });
      const lock = join(c.dir, LOCK_NAME);
      haveLock = await this.#acquire(lock);
      if (!haveLock) return err('CONFLICT', 'Another backup is writing to this folder');
      await this.#sweepPartials(c.dir);
      const base = `vss-backup-${stamp(this.#now())}`;
      let final = join(c.dir, `${base}${BACKUP_EXT}`);
      // Never replace a backup made within the same second (the folder lock serialises writers).
      for (let n = 2; existsSync(final) || existsSync(`${final}.partial`); n++) {
        if (n > 999) return err('CONFLICT', 'Too many backups within one second');
        final = join(c.dir, `${base}-${n}${BACKUP_EXT}`);
      }
      const partial = `${final}.partial`;
      const res = await this.#d.vaultBackup({ destPath: partial, passphrase: c.passphrase });
      if (!res.ok) {
        await rm(partial, { force: true });
        return res;
      }
      await rename(partial, final);
      this.#d.meta().set(LAST_KEY, String(this.#now()));
      await this.prune(c.dir, c.keep);
      await this.#writeKeyring(c);
      return ok({ ...res.value, path: final });
    } catch {
      return err('INTERNAL', 'Backup failed');
    } finally {
      if (haveLock) await rm(join(c.dir, LOCK_NAME), { force: true });
      this.#running = false;
    }
  }

  async list(dir?: string): Promise<{ name: string; bytes: number; modifiedAt: number }[]> {
    const folder = dir ?? this.#load()?.dir;
    if (!folder) return [];
    let names: string[];
    try {
      names = await readdir(folder);
    } catch {
      return [];
    }
    const out: { name: string; bytes: number; modifiedAt: number }[] = [];
    for (const name of names.filter((n) => BACKUP_NAME.test(n)).sort(newestFirst)) {
      const s = await stat(join(folder, name));
      out.push({ name, bytes: s.size, modifiedAt: s.mtimeMs });
    }
    return out;
  }

  /** Delete everything but the `keep` newest backups (names sort chronologically). Returns deleted names. */
  async prune(dir: string, keep: number): Promise<string[]> {
    const all = await this.list(dir);
    const drop = all.slice(Math.max(1, keep));
    for (const f of drop) await rm(join(dir, f.name), { force: true });
    return drop.map((f) => f.name);
  }

  /**
   * Restore a backup into the (empty) data directory; VaultService refuses when a vault already exists. When the
   * passphrase does not open the backup, the keyring next to it (if any) is opened with it and every older
   * passphrase it holds is tried.
   */
  async restore(srcPath: string, passphrase: string): Promise<Result<VaultStatus>> {
    const first = await this.#d.vaultRestore({ srcPath, passphrase, destDirectory: this.#d.dataDir });
    if (first.ok || first.error.code !== 'BACKUP_INVALID') return first;
    for (const older of await readKeyring(join(dirname(srcPath), KEYRING_NAME), passphrase)) {
      const r = await this.#d.vaultRestore({ srcPath, passphrase: older, destDirectory: this.#d.dataDir });
      if (r.ok || r.error.code !== 'BACKUP_INVALID') return r;
    }
    return first;
  }

  /** (Re)write the keyring when the passphrase generations or the folder changed since the last write. */
  async #writeKeyring(c: BackupConfig): Promise<void> {
    const previous = c.previous ?? [];
    const file = join(c.dir, KEYRING_NAME);
    if (previous.length === 0) return;
    const marker = createHash('sha256')
      .update(JSON.stringify([c.dir, c.passphrase, previous]))
      .digest('hex');
    if (this.#d.meta().get(KEYRING_META) === marker && existsSync(file)) return;
    const body = new TextEncoder().encode(
      JSON.stringify({ format: KEYRING_FORMAT, version: 1, passphrases: previous }),
    );
    const sealed = await sealBackup(body, c.passphrase, this.#d.keyringKdf ? { kdf: this.#d.keyringKdf } : {});
    const tmp = `${file}.${randomBytes(6).toString('hex')}.partial`;
    await writeFile(tmp, sealed, { flag: 'wx' });
    await rename(tmp, file);
    this.#d.meta().set(KEYRING_META, marker);
  }

  async #acquire(lock: string): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await writeFile(lock, JSON.stringify({ pid: this.#d.pid ?? process.pid, at: this.#now() }), { flag: 'wx' });
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        if (!(await this.#isStale(lock))) return false;
        await rm(lock, { force: true });
      }
    }
    return false;
  }

  async #isStale(lock: string): Promise<boolean> {
    try {
      const j = JSON.parse(await readFile(lock, 'utf8')) as { pid?: number; at?: number };
      const age = this.#now() - (typeof j.at === 'number' ? j.at : 0);
      if (age > LOCK_STALE_MS) return true;
      if (typeof j.pid !== 'number') return true;
      // Our own pid: #running already serialises runs inside this process, so a leftover file is stale.
      if (j.pid === (this.#d.pid ?? process.pid)) return true;
      return !(this.#d.isPidAlive ?? defaultAlive)(j.pid);
    } catch {
      return true; // unreadable lock file
    }
  }

  async #sweepPartials(dir: string): Promise<void> {
    for (const n of await readdir(dir)) {
      if (!n.endsWith('.partial')) continue;
      try {
        const s = await stat(join(dir, n));
        if (this.#now() - s.mtimeMs > PARTIAL_STALE_MS) await rm(join(dir, n), { force: true });
      } catch {
        // gone already
      }
    }
  }
}
