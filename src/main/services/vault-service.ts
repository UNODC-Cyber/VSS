/**
 * `vault.*` part of VssApi over src/main/crypto. The encrypted database itself is driven through the injected
 * DbController (WP-04). Every method resolves to a Result; error messages are fixed strings without secrets.
 *
 * Scope (owner decision 2026-11-03): single password slot only. FIDO2 enrolment and slot removal answer
 * NOT_SUPPORTED ("deferred"); a PRF output passed to unlock is refused the same way.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type {
  Ack,
  Result,
  VaultBackupRequest,
  VaultBackupResult,
  VaultChangePasswordRequest,
  VaultCreateRequest,
  VaultOpenRequest,
  VaultRestoreRequest,
  VaultStatus,
  VaultUnlockRequest,
  VaultWipeRequest,
  VssApi,
  VssErrorCode,
} from '@shared/ipc/contract';
import { err, ok } from '@shared/ipc/result';
import { bytesSource, concatSources, fileSource, openStream, sealToFile } from '../crypto/envelope';
import type { ByteSink } from '../crypto/envelope';
import { CryptoError, isCryptoError } from '../crypto/errors';
import type { CryptoErrorCode } from '../crypto/errors';
import type { Argon2idParams } from '../crypto/kdf';
import {
  createVault,
  DB_FILE,
  dbFilePath,
  lockoutStatus,
  parseHeader,
  pendingRotationPath,
  readHeader,
  recoverRotation,
  rotateDek,
  rotationPending,
  rotationRecordPath,
  unlock,
  VAULT_FILE,
  vaultFilePath,
} from '../crypto/vault';
import type { KeyMaterial } from '../crypto/vault';
import { isDbError } from '../db/errors';

/** Encrypted database lifecycle, implemented by WP-04. */
export interface DbController {
  /**
   * Open `vss.db` with the raw key `x'<keyHex>'`; must throw if the key does not open the DB. `create` is true only
   * for vault.create (otherwise the file must exist); `vaultId` binds the DB to its header (F-04).
   */
  open(keyHex: string, opts?: { create: boolean; vaultId: string }): void;
  /** Re-encrypt the OPEN database under a new raw key (SQLite3MC `PRAGMA rekey`); F-03. */
  rekey(newKeyHex: string): void;
  /** While closed: true when `keyHex` opens the database file and it reads cleanly (rotation recovery). */
  probe(keyHex: string): boolean;
  /** Close the connection; must be safe to call when not open. */
  close(): void;
  /** `VACUUM INTO path` of the open DB (output encrypted with the same key). */
  vacuumInto(path: string): void;
}

export interface VaultServiceOptions {
  db: DbController;
  /**
   * The only directory a vault may live in (the app data folder). When set, create / open / restore refuse every
   * other directory, so the header and the DB the controller opens always sit side by side (F-04).
   */
  dataDir?: string;
  /** Argon2id params for new password slots (default DEFAULT_KDF). */
  kdf?: Argon2idParams;
  /** Argon2id params for backup envelopes (default DEFAULT_KDF). */
  backupKdf?: Argon2idParams;
  /** Seconds until auto-lock while unlocked (WP-05 provides it); default null. */
  autoLockInSeconds?: () => number | null;
  /** Called on vault.touch() (WP-05 idle timer). */
  onActivity?: () => void;
  onLocked?: (reason: 'manual' | 'error') => void;
  onUnlocked?: (status: VaultStatus) => void;
  now?: () => number;
  /** Restore size cap (default MAX_BACKUP_BYTES; tests lower it). */
  maxBackupBytes?: number;
}

export type VaultApi = VssApi['vault'];
export type VaultCreateInput = VaultCreateRequest & { directory: string };

const BUNDLE_MAGIC = Buffer.from('VSSBNDL1', 'latin1');
const MAX_HEADER_BYTES = 1024 * 1024;
/**
 * Largest backup VSS restores (F-09). The database holds the stored workbooks, so it grows with use, but a pilot
 * office stays far below this; anything larger is refused before any key derivation or disk write.
 */
export const MAX_BACKUP_BYTES = 4 * 1024 * 1024 * 1024;

const CODE_MAP: Record<CryptoErrorCode, [VssErrorCode, string]> = {
  BAD_CREDENTIALS: ['BAD_CREDENTIALS', 'Unlock failed'],
  VAULT_TAMPERED: ['VAULT_TAMPERED', 'Vault integrity check failed'],
  VAULT_CORRUPT: ['VAULT_CORRUPT', 'Vault file is invalid'],
  VAULT_NOT_FOUND: ['VAULT_NOT_FOUND', 'Vault not found'],
  VAULT_EXISTS: ['VAULT_EXISTS', 'A vault already exists in this location'],
  RATE_LIMITED: ['RATE_LIMITED', 'Too many failed attempts; try again later'],
  BACKUP_INVALID: ['BACKUP_INVALID', 'Backup could not be opened'],
  BAD_REQUEST: ['BAD_REQUEST', 'Invalid parameters'],
  KEY_DISPOSED: ['VAULT_LOCKED', 'Vault is locked'],
};

function toResult(e: unknown): Result<never> {
  if (isCryptoError(e)) {
    const [code, message] = CODE_MAP[e.code];
    return err(code, message);
  }
  if (isDbError(e, 'SCHEMA_NEWER_THAN_APP'))
    return err('SCHEMA_NEWER_THAN_APP', 'This vault was written by a newer VSS version; update the app first');
  return err('INTERNAL', 'Internal error');
}

const DEFERRED = (): Result<never> => err('NOT_SUPPORTED', 'Additional key slots (FIDO2) are deferred');

const sameDir = (a: string, b: string): boolean => {
  const n = (p: string) => resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

function resolveVaultDir(p: string): string {
  if (basename(p).toLowerCase() === VAULT_FILE) return dirname(p);
  try {
    if (statSync(p).isFile()) return dirname(p);
  } catch {
    // not found: treat as a directory path
  }
  return p;
}

export class VaultService implements VaultApi {
  readonly #o: VaultServiceOptions;
  #dir: string | null = null;
  #km: KeyMaterial | null = null;
  #busy: Promise<unknown> = Promise.resolve();

  constructor(opts: VaultServiceOptions) {
    this.#o = opts;
  }

  /** Serialise all state-changing calls. */
  #run<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
    const run = this.#busy.then(fn, fn).catch((e: unknown) => toResult(e));
    this.#busy = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #now(): number {
    return (this.#o.now ?? Date.now)();
  }

  #snapshot(): VaultStatus {
    const dir = this.#dir;
    if (!dir || !existsSync(vaultFilePath(dir))) {
      return {
        state: 'no-vault',
        vaultPath: null,
        slots: [],
        autoLockInSeconds: null,
        failedAttempts: 0,
        lockedOutUntil: null,
      };
    }
    let slots: VaultStatus['slots'] = [];
    let failedAttempts = 0;
    let until: number | null = null;
    try {
      const h = readHeader(dir);
      slots = h.slots.map((s) => ({ id: s.id, kind: s.type, label: s.label, createdAt: s.createdAt }));
      const lo = lockoutStatus(dir, () => this.#now());
      failedAttempts = lo.failedAttempts;
      until = lo.lockedOutUntil;
    } catch {
      // unreadable header: report as locked with no slots; unlock will report VAULT_CORRUPT
    }
    const unlocked = this.#km !== null && !this.#km.disposed;
    return {
      state: unlocked ? 'unlocked' : 'locked',
      vaultPath: vaultFilePath(dir),
      slots,
      autoLockInSeconds: unlocked ? (this.#o.autoLockInSeconds?.() ?? null) : null,
      failedAttempts,
      lockedOutUntil: until === null ? null : new Date(until).toISOString(),
    };
  }

  #lockNow(reason: 'manual' | 'error' = 'manual'): void {
    const wasOpen = this.#km !== null;
    try {
      this.#o.db.close();
    } catch {
      // closing must never keep keys alive
    }
    this.#km?.dispose();
    this.#km = null;
    if (wasOpen) this.#o.onLocked?.(reason);
  }

  /** Throws BAD_REQUEST unless `dir` is the bound data directory (when one is configured). */
  #assertDataDir(dir: string): void {
    if (this.#o.dataDir !== undefined && !sameDir(dir, this.#o.dataDir)) throw new CryptoError('BAD_REQUEST');
  }

  #openDb(km: KeyMaterial, create = false): void {
    try {
      this.#o.db.open(km.dbKeyHex(), { create, vaultId: km.vaultId });
    } catch (e) {
      km.dispose();
      if (isDbError(e, 'SCHEMA_NEWER_THAN_APP')) throw e;
      // A DB of another vault, an empty file or a missing file: never start over silently.
      if (isDbError(e, 'VAULT_MISMATCH')) throw new CryptoError('VAULT_TAMPERED');
      throw new CryptoError('VAULT_CORRUPT');
    }
    this.#km = km;
    this.#o.onUnlocked?.(this.#snapshot());
  }

  #requireUnlocked(): string {
    if (!this.#dir || !this.#km || this.#km.disposed) throw new CryptoError('KEY_DISPOSED');
    return this.#dir;
  }

  // -------------------------------------------------------------------------------------------------------------

  status(): Promise<Result<VaultStatus>> {
    return this.#run(async () => ok(this.#snapshot()));
  }

  /** `directory` is supplied by the composition root (the app data folder); the IPC contract has no such field. */
  create(req: VaultCreateInput): Promise<Result<VaultStatus>> {
    return this.#run(async () => {
      // req.displayName has no field in vault.json v1 (public header); it is intentionally not persisted here.
      this.#assertDataDir(req.directory);
      this.#lockNow();
      const km = await createVault({
        dir: req.directory,
        password: req.password,
        kdf: this.#o.kdf,
        now: () => this.#now(),
      });
      this.#dir = req.directory;
      this.#openDb(km, true);
      return ok(this.#snapshot());
    });
  }

  open(req: VaultOpenRequest): Promise<Result<VaultStatus>> {
    return this.#run(async () => {
      const dir = resolveVaultDir(req.path);
      this.#assertDataDir(dir);
      readHeader(dir); // VAULT_NOT_FOUND / VAULT_CORRUPT
      this.#lockNow();
      this.#dir = dir;
      return ok(this.#snapshot());
    });
  }

  unlock(req: VaultUnlockRequest): Promise<Result<VaultStatus>> {
    return this.#run(async () => {
      if (req.prfOutputB64 !== undefined) return DEFERRED();
      if (!this.#dir) return err('VAULT_NOT_FOUND', 'Vault not found');
      if (this.#km && !this.#km.disposed) return ok(this.#snapshot());
      // An interrupted password change is completed or rolled back first (either password works; F-03).
      let recovered = 'none';
      if (rotationPending(this.#dir)) {
        recovered = await recoverRotation({
          dir: this.#dir,
          password: req.password,
          probe: (k) => this.#o.db.probe(k),
          now: () => this.#now(),
        });
      }
      let km: KeyMaterial;
      try {
        km = await unlock({ dir: this.#dir, password: req.password, now: () => this.#now() });
      } catch (e) {
        if (recovered === 'rolled-back' && isCryptoError(e) && e.code === 'BAD_CREDENTIALS')
          return err('BAD_CREDENTIALS', 'The password change did not complete; unlock with the previous password');
        if (recovered === 'completed' && isCryptoError(e) && e.code === 'BAD_CREDENTIALS')
          return err('BAD_CREDENTIALS', 'The interrupted password change was completed; unlock with the new password');
        throw e;
      }
      this.#openDb(km);
      return ok(this.#snapshot());
    });
  }

  lock(): Promise<Result<VaultStatus>> {
    return this.#run(async () => {
      this.#lockNow('manual');
      return ok(this.#snapshot());
    });
  }

  /**
   * Change the password AND rotate the DEK (security review F-03): a fresh DEK is wrapped under the new password,
   * the open DB is re-keyed to it, and only then does the new header replace vault.json (crash-safe, see rotateDek /
   * recoverRotation). An old copy of vault.json (OneDrive history, a shared folder) plus the old password no longer
   * opens the live database. Backups made earlier still open with the password they were made under.
   */
  changePassword(req: VaultChangePasswordRequest): Promise<Result<Ack>> {
    return this.#run(async () => {
      const dir = this.#requireUnlocked();
      if (typeof req.newPassword !== 'string' || req.newPassword.length === 0) throw new CryptoError('BAD_REQUEST');
      const rotation = await rotateDek({
        dir,
        password: req.currentPassword,
        newPassword: req.newPassword,
        kdf: this.#o.kdf,
        now: () => this.#now(),
      });
      try {
        await rotation.commit((_old, next) => this.#o.db.rekey(next));
      } catch (e) {
        rotation.next.dispose();
        throw e;
      }
      const old = this.#km;
      this.#km = rotation.next;
      old?.dispose();
      return ok({ ok: true as const });
    });
  }

  enrollFido2(): Promise<Result<VaultStatus>> {
    return Promise.resolve(DEFERRED());
  }

  removeSlot(): Promise<Result<VaultStatus>> {
    return Promise.resolve(DEFERRED());
  }

  backup(req: VaultBackupRequest): Promise<Result<VaultBackupResult>> {
    return this.#run(async () => {
      const dir = this.#requireUnlocked();
      const header = await readFile(vaultFilePath(dir));
      if (header.length > MAX_HEADER_BYTES) throw new CryptoError('VAULT_CORRUPT');
      const tmpDb = join(dirname(req.destPath), `.vss-backup-${randomBytes(6).toString('hex')}.db.tmp`);
      try {
        this.#o.db.vacuumInto(tmpDb);
        const dbLen = (await stat(tmpDb)).size;
        const prefix = Buffer.alloc(BUNDLE_MAGIC.length + 4);
        BUNDLE_MAGIC.copy(prefix, 0);
        prefix.writeUInt32BE(header.length, BUNDLE_MAGIC.length);
        const fh = await open(tmpDb, 'r');
        try {
          const hash = createHash('sha256');
          const bytes = await sealToFile(
            concatSources([bytesSource(prefix), bytesSource(header), fileSource(fh, dbLen)]),
            req.destPath,
            req.passphrase,
            { kdf: this.#o.backupKdf, onBytes: (b) => hash.update(b) },
          );
          return ok({ path: req.destPath, bytes, sha256: hash.digest('hex') });
        } finally {
          await fh.close();
        }
      } finally {
        await rm(tmpDb, { force: true });
      }
    });
  }

  restore(req: VaultRestoreRequest): Promise<Result<VaultStatus>> {
    return this.#run(async () => {
      const dest = req.destDirectory;
      this.#assertDataDir(dest);
      await mkdir(dest, { recursive: true });
      if (existsSync(vaultFilePath(dest)) || existsSync(dbFilePath(dest))) throw new CryptoError('VAULT_EXISTS');
      const srcLen = (await stat(req.srcPath)).size;
      const cap = this.#o.maxBackupBytes ?? MAX_BACKUP_BYTES;
      if (srcLen > cap)
        return err('BACKUP_INVALID', `The backup file is larger than ${Math.round(cap / 1024 / 1024)} MiB`);
      const tmpDb = join(dest, `${DB_FILE}.${randomBytes(6).toString('hex')}.tmp`);
      const src = await open(req.srcPath, 'r');
      const out = await open(tmpDb, 'wx');
      try {
        const split = new BundleSplitter(out);
        await openStream(fileSource(src, srcLen), split, req.passphrase);
        const headerBytes = split.finish();
        parseHeader(headerBytes.toString('utf8')); // structurally valid (MAC is checked at unlock)
        await out.sync();
        await out.close();
        await writeFile(vaultFilePath(dest), headerBytes, { flag: 'wx' });
        await rename(tmpDb, dbFilePath(dest));
      } catch (e) {
        await out.close().catch(() => undefined);
        await rm(tmpDb, { force: true });
        throw isCryptoError(e) && e.code !== 'VAULT_EXISTS' ? new CryptoError('BACKUP_INVALID') : e;
      } finally {
        await src.close();
      }
      this.#lockNow();
      this.#dir = dest;
      return ok(this.#snapshot());
    });
  }

  wipe(req: VaultWipeRequest): Promise<Result<VaultStatus>> {
    return this.#run(async () => {
      if (req.confirm !== 'WIPE') throw new CryptoError('BAD_REQUEST');
      if (!this.#dir) return err('VAULT_NOT_FOUND', 'Vault not found');
      const dir = this.#dir;
      // Re-authenticate (counts towards the back-off like any unlock attempt).
      const km = await unlock({ dir, password: req.password, now: () => this.#now() });
      km.dispose();
      this.#lockNow();
      // NOTE: plain deletion; on SSDs/OneDrive the old blocks may survive (the DB is encrypted, so this is the
      // DEK-erasure model: once vault.json is gone the DEK is unrecoverable).
      for (const f of [VAULT_FILE, DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`])
        await rm(join(dir, f), { force: true });
      await rm(pendingRotationPath(dir), { force: true });
      await rm(rotationRecordPath(dir), { force: true });
      this.#dir = null;
      return ok(this.#snapshot());
    });
  }

  touch(): Promise<Result<Ack>> {
    if (!this.#km || this.#km.disposed) return Promise.resolve(err('VAULT_LOCKED', 'Vault is locked'));
    this.#o.onActivity?.();
    return Promise.resolve(ok({ ok: true as const }));
  }

  /** For WP-04/05: current key material while unlocked (do not retain). */
  get keyMaterial(): KeyMaterial | null {
    return this.#km && !this.#km.disposed ? this.#km : null;
  }

  /** Lock because of an external event (idle, suspend...). */
  forceLock(): void {
    this.#lockNow('manual');
  }
}

/** Splits the decrypted bundle: magic | u32 headerLen | vault.json | vss.db (streamed to `out`). */
class BundleSplitter implements ByteSink {
  #pre = Buffer.alloc(BUNDLE_MAGIC.length + 4);
  #preFill = 0;
  #header: Buffer | null = null;
  #headerFill = 0;
  #pos = 0;
  readonly #out: FileHandle;

  constructor(out: FileHandle) {
    this.#out = out;
  }

  async write(chunk: Uint8Array): Promise<void> {
    let c = chunk;
    if (this.#preFill < this.#pre.length) {
      const n = Math.min(c.length, this.#pre.length - this.#preFill);
      this.#pre.set(c.subarray(0, n), this.#preFill);
      this.#preFill += n;
      c = c.subarray(n);
      if (this.#preFill === this.#pre.length) {
        if (!this.#pre.subarray(0, BUNDLE_MAGIC.length).equals(BUNDLE_MAGIC)) throw new CryptoError('BACKUP_INVALID');
        const len = this.#pre.readUInt32BE(BUNDLE_MAGIC.length);
        if (len === 0 || len > MAX_HEADER_BYTES) throw new CryptoError('BACKUP_INVALID');
        this.#header = Buffer.alloc(len);
      }
    }
    if (c.length && this.#header && this.#headerFill < this.#header.length) {
      const n = Math.min(c.length, this.#header.length - this.#headerFill);
      this.#header.set(c.subarray(0, n), this.#headerFill);
      this.#headerFill += n;
      c = c.subarray(n);
    }
    while (c.length) {
      const { bytesWritten } = await this.#out.write(c, 0, c.length, this.#pos);
      this.#pos += bytesWritten;
      c = c.subarray(bytesWritten);
    }
  }

  finish(): Buffer {
    if (!this.#header || this.#headerFill !== this.#header.length) throw new CryptoError('BACKUP_INVALID');
    return this.#header;
  }
}
