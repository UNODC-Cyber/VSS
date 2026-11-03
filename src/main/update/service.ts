/**
 * Update service: implements `VssApi.updates` on top of electron-updater (injected as `UpdaterPort`).
 *
 * - Never auto-downloads, never auto-installs (autoDownload=false, autoInstallOnAppQuit=false, allowDowngrade=false).
 * - Automatic check at most once per 24 h, only after unlock, only if `updateCheckEnabled`. With checks disabled the
 *   service makes ZERO network calls (not even enabling the gate).
 * - The NetGate is enabled only for the duration of a check or a download + manifest fetch, and disabled again in a
 *   `finally` block.
 * - After download: fetch release-manifest.json + both signatures through NetGate, verify Ed25519 AND ML-DSA-65, check
 *   version (anti-downgrade / anti-replay), then compare size + SHA-512 of the downloaded installer. Only then is the
 *   phase `verified` and `install()` allowed (it re-hashes the file right before handing over to the installer).
 * - Any download or verification failure deletes the downloaded files and returns a typed VssError.
 *
 * Fully dependency-injected (clock, fs, net, updater) so it runs in tests without Electron.
 */
import type { Ack, Result, UpdateState, VssErrorCode } from '@shared/ipc/contract';
import { err, ok } from '@shared/ipc/result';
import {
  checkManifestFreshness,
  checkManifestVersion,
  findManifestFile,
  isUpgrade,
  MANIFEST_FILE,
  MANIFEST_MAX_BYTES,
  parseSemver,
  SIG_ED25519_FILE,
  SIG_MLDSA65_FILE,
  SIGNATURE_MAX_BYTES,
  verifyFileHash,
  verifyManifest,
} from './verify';
import type { ManifestFile, TrustedUpdateKeys, VerifyFailure } from './verify';

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Subset of electron-updater's UpdateInfo the service relies on. */
export interface UpdateInfoLike {
  version: string;
  files: ReadonlyArray<{ url: string; sha512?: string; size?: number }>;
  path?: string;
  releaseNotes?: string | ReadonlyArray<{ version?: string; note: string | null }> | null;
}

/** Subset of electron-updater's AppUpdater (adapter in ./electron.ts). */
export interface UpdaterPort {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  checkForUpdates(): Promise<{ updateInfo: UpdateInfoLike } | null>;
  /** Resolves with the downloaded file paths (installer first). */
  downloadUpdate(): Promise<string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  onDownloadProgress(listener: (p: { transferred: number; total: number }) => void): void;
}

/** Subset of NetGate. */
export interface NetPort {
  setEnabled(enabled: boolean): void;
  fetchBytes(url: string, opts: { maxBytes: number }): Promise<Uint8Array>;
}

export interface FsPort {
  hashFile(path: string): Promise<{ sha512Hex: string; size: number }>;
  remove(path: string): Promise<void>;
}

export interface ClockPort {
  now(): number;
}

/** Persists the time of the last completed check (ms since epoch). */
export interface LastCheckStore {
  load(): Promise<number | null>;
  save(ms: number): Promise<void>;
}

export interface UpdateServiceDeps {
  currentVersion: string;
  updater: UpdaterPort;
  net: NetPort;
  fs: FsPort;
  clock: ClockPort;
  keys: TrustedUpdateKeys;
  /** Reads `settings.updateCheckEnabled` (false when the vault is locked / settings unavailable). */
  isCheckEnabled(): Promise<boolean>;
  /** Accept prerelease versions. Default false. */
  allowPrerelease?: boolean;
  store?: LastCheckStore;
  emit?: (state: UpdateState) => void;
  owner?: string;
  repo?: string;
}

export const memoryLastCheckStore = (): LastCheckStore => {
  let v: number | null = null;
  return {
    load: async () => v,
    save: async (ms) => {
      v = ms;
    },
  };
};

class UpdateFailure extends Error {
  constructor(
    readonly code: VssErrorCode,
    message: string,
    readonly verifyReason?: VerifyFailure,
  ) {
    super(message);
  }
}

const NOTES_MAX = 65536;

function notesOf(info: UpdateInfoLike): string | null {
  const n = info.releaseNotes;
  if (n == null) return null;
  const text = typeof n === 'string' ? n : n.map((x) => x.note ?? '').join('\n\n');
  return text.slice(0, NOTES_MAX);
}

/** Release asset name of the Windows installer announced by the feed. */
export function installerAssetName(info: UpdateInfoLike): string | null {
  const exe = info.files.find((f) => /\.exe$/i.test(f.url))?.url ?? info.path ?? null;
  if (!exe) return null;
  const last = exe.split(/[\\/]/).pop() ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return null;
  }
}

function errorCodeOf(e: unknown): VssErrorCode {
  if (e instanceof UpdateFailure) return e.code;
  if (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'NETWORK_DISABLED') {
    return 'NETWORK_DISABLED';
  }
  return 'INTERNAL';
}

export class UpdateService {
  readonly #d: UpdateServiceDeps;
  readonly #store: LastCheckStore;
  readonly #owner: string;
  readonly #repo: string;
  #state: UpdateState;
  #busy = false;
  #offered: UpdateInfoLike | null = null;
  #downloaded: string[] = [];
  #verified: { path: string; entry: ManifestFile } | null = null;

  constructor(deps: UpdateServiceDeps) {
    if (!parseSemver(deps.currentVersion)) throw new Error('currentVersion is not SemVer');
    this.#d = deps;
    this.#store = deps.store ?? memoryLastCheckStore();
    this.#owner = deps.owner ?? 'UNODC-Cyber';
    this.#repo = deps.repo ?? 'VSS';
    const u = deps.updater;
    u.autoDownload = false;
    u.autoInstallOnAppQuit = false;
    u.allowDowngrade = false;
    u.allowPrerelease = deps.allowPrerelease ?? false;
    u.onDownloadProgress((p) => {
      if (this.#state.phase !== 'downloading') return;
      this.#set({ downloadedBytes: p.transferred, totalBytes: p.total || this.#state.totalBytes });
    });
    this.#state = {
      phase: 'idle',
      currentVersion: deps.currentVersion,
      availableVersion: null,
      releaseNotes: null,
      downloadedBytes: 0,
      totalBytes: null,
      checkedAt: null,
      message: null,
    };
  }

  get snapshot(): UpdateState {
    return { ...this.#state };
  }

  #set(patch: Partial<UpdateState>): void {
    this.#state = { ...this.#state, ...patch };
    this.#d.emit?.({ ...this.#state });
  }

  /** Enables the gate for the duration of `fn` only. */
  async #withNetwork<T>(fn: () => Promise<T>): Promise<T> {
    this.#d.net.setEnabled(true);
    try {
      return await fn();
    } finally {
      this.#d.net.setEnabled(false);
    }
  }

  async state(): Promise<Result<UpdateState>> {
    return ok(this.snapshot);
  }

  /** Call after every successful unlock. Checks only if enabled and the last check is >= 24 h old. */
  async onUnlocked(): Promise<void> {
    if (this.#busy) return;
    if (!(await this.#d.isCheckEnabled())) {
      if (this.#state.phase === 'idle') this.#set({ phase: 'disabled' });
      return;
    }
    const last = await this.#store.load();
    const now = this.#d.clock.now();
    // A clock that moved backwards (now < last) must not suppress checks forever.
    if (last !== null && now >= last && now - last < CHECK_INTERVAL_MS) return;
    if (['available', 'downloading', 'verifying', 'verified'].includes(this.#state.phase)) return;
    await this.check();
  }

  /** User- or unlock-initiated check. */
  async check(): Promise<Result<UpdateState>> {
    if (this.#busy) return ok(this.snapshot);
    if (!(await this.#d.isCheckEnabled())) {
      this.#set({ phase: 'disabled', message: null });
      return ok(this.snapshot);
    }
    if (this.#state.phase === 'verified' || this.#state.phase === 'downloading' || this.#state.phase === 'verifying') {
      return ok(this.snapshot);
    }
    this.#busy = true;
    this.#offered = null;
    this.#set({ phase: 'checking', message: null, availableVersion: null, releaseNotes: null });
    try {
      const res = await this.#withNetwork(() => this.#d.updater.checkForUpdates());
      const now = this.#d.clock.now();
      await this.#store.save(now);
      const checkedAt = new Date(now).toISOString();
      if (!res) throw new UpdateFailure('NOT_SUPPORTED', 'Updates are not available in this build');
      const info = res.updateInfo;
      if (!isUpgrade(info.version, this.#d.currentVersion, { allowPrerelease: this.#d.allowPrerelease ?? false })) {
        this.#set({ phase: 'up-to-date', checkedAt });
        return ok(this.snapshot);
      }
      this.#offered = info;
      const name = installerAssetName(info);
      const size = info.files.find((f) => name !== null && f.url.endsWith(name))?.size ?? null;
      this.#set({
        phase: 'available',
        checkedAt,
        availableVersion: info.version,
        releaseNotes: notesOf(info),
        downloadedBytes: 0,
        totalBytes: size,
      });
      return ok(this.snapshot);
    } catch (e) {
      const code = errorCodeOf(e);
      const message = e instanceof UpdateFailure ? e.message : 'Update check failed';
      this.#set({ phase: 'error', message });
      return err(code, message);
    } finally {
      this.#busy = false;
    }
  }

  /** User-initiated download, followed by manifest + signature + hash verification. */
  async download(): Promise<Result<UpdateState>> {
    if (this.#busy) return err('CONFLICT', 'An update operation is already running');
    const info = this.#offered;
    if (this.#state.phase !== 'available' || !info) return err('CONFLICT', 'No update is available to download');
    if (!(await this.#d.isCheckEnabled())) {
      this.#set({ phase: 'disabled' });
      return err('NETWORK_DISABLED', 'Update checks are turned off');
    }
    this.#busy = true;
    this.#verified = null;
    this.#set({ phase: 'downloading', downloadedBytes: 0, message: null });
    try {
      const version = info.version;
      if (!parseSemver(version)) throw new UpdateFailure('UPDATE_VERIFY_FAILED', 'Offered version is invalid');
      const assetName = installerAssetName(info);
      if (!assetName) throw new UpdateFailure('UPDATE_VERIFY_FAILED', 'Feed does not name an installer');
      const base = `https://github.com/${this.#owner}/${this.#repo}/releases/download/v${version}/`;
      const fetched = await this.#withNetwork(async () => {
        const paths = await this.#d.updater.downloadUpdate();
        this.#downloaded = [...paths];
        this.#set({ phase: 'verifying' });
        const manifest = await this.#d.net.fetchBytes(base + MANIFEST_FILE, { maxBytes: MANIFEST_MAX_BYTES });
        const sigEd = await this.#d.net.fetchBytes(base + SIG_ED25519_FILE, { maxBytes: SIGNATURE_MAX_BYTES });
        const sigPq = await this.#d.net.fetchBytes(base + SIG_MLDSA65_FILE, { maxBytes: SIGNATURE_MAX_BYTES });
        return { paths, manifest, sigEd, sigPq };
      });
      const installer = fetched.paths.find((p) => /\.exe$/i.test(p)) ?? fetched.paths[0] ?? null;
      if (!installer) throw new UpdateFailure('UPDATE_VERIFY_FAILED', 'Download produced no installer');

      const v = verifyManifest(fetched.manifest, fetched.sigEd, fetched.sigPq, this.#d.keys);
      if (!v.ok) throw new UpdateFailure('UPDATE_VERIFY_FAILED', v.message, v.reason);
      const ver = checkManifestVersion(v.value.manifest, {
        currentVersion: this.#d.currentVersion,
        expectedVersion: version,
        allowPrerelease: this.#d.allowPrerelease ?? false,
      });
      if (!ver.ok) throw new UpdateFailure('UPDATE_VERIFY_FAILED', ver.message, ver.reason);
      const fresh = checkManifestFreshness(v.value.manifest, this.#d.clock.now());
      if (!fresh.ok) throw new UpdateFailure('UPDATE_VERIFY_FAILED', fresh.message, fresh.reason);
      const entry = findManifestFile(v.value.manifest, assetName);
      if (!entry.ok) throw new UpdateFailure('UPDATE_VERIFY_FAILED', entry.message, entry.reason);
      const hash = verifyFileHash(entry.value, await this.#d.fs.hashFile(installer));
      if (!hash.ok) throw new UpdateFailure('UPDATE_VERIFY_FAILED', hash.message, hash.reason);

      this.#verified = { path: installer, entry: entry.value };
      this.#set({ phase: 'verified', downloadedBytes: entry.value.size, totalBytes: entry.value.size });
      return ok(this.snapshot);
    } catch (e) {
      await this.#discardDownload();
      const code = errorCodeOf(e);
      const verifyFailed = code === 'UPDATE_VERIFY_FAILED';
      const message = e instanceof UpdateFailure ? e.message : 'Update download failed';
      this.#set({ phase: verifyFailed ? 'verify-failed' : 'error', message });
      return err(code, message);
    } finally {
      this.#busy = false;
    }
  }

  /** Hands the verified installer to electron-updater. Re-hashes first (the file may have changed on disk). */
  async install(): Promise<Result<Ack>> {
    if (this.#busy) return err('CONFLICT', 'An update operation is already running');
    const v = this.#verified;
    if (this.#state.phase !== 'verified' || !v) return err('CONFLICT', 'No verified update to install');
    this.#busy = true;
    try {
      const again = verifyFileHash(v.entry, await this.#d.fs.hashFile(v.path));
      if (!again.ok) throw new UpdateFailure('UPDATE_VERIFY_FAILED', 'Installer changed after verification');
      this.#d.updater.quitAndInstall(false, true);
      return ok({ ok: true });
    } catch (e) {
      await this.#discardDownload();
      const code = errorCodeOf(e);
      const message = e instanceof UpdateFailure ? e.message : 'Update install failed';
      this.#set({ phase: code === 'UPDATE_VERIFY_FAILED' ? 'verify-failed' : 'error', message });
      return err(code, message);
    } finally {
      this.#busy = false;
    }
  }

  async #discardDownload(): Promise<void> {
    const paths = this.#downloaded;
    this.#downloaded = [];
    this.#verified = null;
    for (const p of paths) {
      try {
        await this.#d.fs.remove(p);
      } catch {
        // best effort; nothing else to do
      }
    }
  }

  /** Handlers for `registerIpc({ updates: service.handlers() })`. */
  handlers(): {
    state: () => Promise<Result<UpdateState>>;
    check: () => Promise<Result<UpdateState>>;
    download: () => Promise<Result<UpdateState>>;
    install: () => Promise<Result<Ack>>;
  } {
    return {
      state: () => this.state(),
      check: () => this.check(),
      download: () => this.download(),
      install: () => this.install(),
    };
  }
}
