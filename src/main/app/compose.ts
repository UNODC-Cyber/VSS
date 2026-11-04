/**
 * Composition root of the main process: wires the vault, encrypted DB, audit chain, settings, lock controller,
 * clipboard, email, files, backup and update services into the handler table passed to `registerIpc`.
 *
 * Everything Electron-specific arrives through `AppPorts`, so the whole graph runs in Vitest with fakes.
 *
 * Handler table status
 *   implemented here : vault.*, settings.*, backup.*, clipboard.*, email.draft/writeEml/mailto, files.*, updates.*,
 *                      audit.*, app.info (app.openFeedback: LANE I SLOT, NOT_SUPPORTED until lane I)
 *   LANE H SLOT      : requests.*, responses.*, persons.*, units.*, review.*, stats.*, templates.* -- default
 *                      `createDomainContribution` (app/domain-wiring.ts: lane H services + lane G exporter);
 *                      tests may pass another factory
 *   not planned (MVP): peer.* (experimental, post-MVP) -> NOT_SUPPORTED
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Settings } from '@shared/domain/types';
import type {
  Ack,
  AppChannel,
  BackupListResult,
  ClipboardCopyRequest,
  Result,
  VaultBackupRequest,
  VaultBackupResult,
  VaultStatus,
  VaultWipeRequest,
  VssEventMap,
  VssEventName,
} from '@shared/ipc/contract';
import { err, ok } from '@shared/ipc/result';
import { unlock as cryptoUnlock, vaultExists } from '../crypto/vault';
import type { Argon2idParams } from '../crypto/kdf';
import { DbError, isDbError } from '../db/errors';
import { SqliteDbController } from '../db/controller';
import { APP_SCHEMA_VERSION } from '../db/migrations';
import type { Db } from '../db/open';
import type { Repos } from '../db/repos';
import type { Handlers } from '../ipc/registry';
import { AuditLog } from '../services/audit';
import { BackupService } from '../services/backup';
import { ClipboardService } from '../services/clipboard';
import type { ClipboardPort } from '../services/clipboard';
import { assertAddress, buildDraft, buildEml, buildMailto, EmailError, openMailto } from '../services/email';
import type { EmailFieldSet, ExportFileSource, RequestStatusSource } from '../services/email';
import { FilesService, isPathToken, PathGrants, withGrant } from '../services/files';
import type { FilesPort } from '../services/files';
import { LockController } from '../services/lock';
import type { LockReason, PowerEvents } from '../services/lock';
import { SettingsService } from '../services/settings';
import { settingsLastCheckStore } from '../services/updates-wiring';
import type { UpdateServiceFactory, UpdateServiceLike } from '../services/updates-wiring';
import { VaultService } from '../services/vault-service';
import { wipeExtras as defaultWipeExtras } from '../services/wipe';
import type { WipeExtrasContext } from '../services/wipe';
import { createDomainContribution } from './domain-wiring';
import { nullLogger } from './logger';
import type { Logger } from './logger';
import type { AppPaths } from './paths';

// ---------------------------------------------------------------------------------------------------------------
// Ports and options
// ---------------------------------------------------------------------------------------------------------------

/** Renderer routes the main process may navigate to (hash routes of vss://app/index.html). */
export type AppRoute = 'create' | 'unlock' | 'lock';

export interface AppPorts {
  files: FilesPort;
  clipboard: ClipboardPort;
  /** shell.openExternal (only ever called with mailto: URLs). */
  openExternal(url: string): Promise<void>;
  emit<E extends VssEventName>(event: E, payload: VssEventMap[E]): void;
  navigate(route: AppRoute): void;
  /** Drop caches / session storage of the renderer session. */
  clearRendererState(): Promise<void>;
  systemIdleSeconds(): number;
  power: PowerEvents | null;
}

/** Data providers owned by lane H; compose reads them lazily so they may be assigned after construction. */
export interface PersonFieldSource {
  field(personId: string, field: ClipboardCopyRequest['field']): string | null;
}
export interface HostSources {
  requestStatus?: RequestStatusSource;
  exportFiles?: ExportFileSource;
  personFields?: PersonFieldSource;
}

/** What lane H's factories can reach. Valid only while the vault is unlocked unless noted. */
export interface ServiceContext {
  db: SqliteDbController;
  repos(): Repos;
  audit(): AuditLog;
  settings(): Settings;
  emit: AppPorts['emit'];
  now(): number;
  logger: Logger;
  /** Mutable: lane H assigns its providers here. */
  sources: HostSources;
  /** Re-entry of the vault password for protected actions (purge, CSV export); counts towards the back-off. */
  verifyPassword(password: string): Promise<boolean>;
  /** Dialog-issued path tokens (F-02): domain handlers resolve `path` / `destPath` arguments through it. */
  grants: PathGrants;
  /** Register a callback that runs on every lock (drop previews and caches holding personal data; F-14). */
  onLock(fn: () => void): void;
}
export interface LaneHContribution {
  handlers?: Handlers;
  sources?: HostSources;
}
export type LaneHFactory = (ctx: ServiceContext) => LaneHContribution;

export interface ComposeOptions {
  paths: AppPaths;
  ports: AppPorts;
  updates: UpdateServiceFactory;
  logger?: Logger;
  /** Argon2id params for new password slots (tests use a cheap profile). */
  kdf?: Argon2idParams;
  backupKdf?: Argon2idParams;
  now?: () => number;
  /** LANE H SLOT: requests/responses/people/review/stats. Default: the real domain services. */
  laneH?: LaneHFactory;
  /** Lock tick period (tests). */
  lockTickMs?: number;
  /** Max time an on-lock backup may delay locking. Default 60 s. */
  lockBackupTimeoutMs?: number;
  /** What app.info reports (main/index.ts passes app.getVersion(); lane I supplies the build channel). */
  appInfo?: { version: string; channel?: AppChannel };
  /** LANE L SLOT: extra wipe clean-up (services/wipe.ts), run after the password check, before the vault goes. */
  wipeExtras?: (req: VaultWipeRequest, ctx: WipeExtrasContext) => Promise<void>;
  /** R16: forget the saved window position and re-centre the window (main/index.ts passes the keeper). */
  resetWindowState?: () => void;
}

export interface ComposedApp {
  handlers: Handlers;
  vault: VaultService;
  db: SqliteDbController;
  lock: LockController;
  clipboard: ClipboardService;
  backup: BackupService;
  settings: SettingsService;
  sources: HostSources;
  /** Opens the existing vault (locked) if one is present and returns the route the window should start on. */
  initialRoute(): Promise<'create' | 'unlock'>;
  /** Lock first, then release timers. `backup:false` skips the on-lock backup. */
  shutdown(opts?: { backup?: boolean }): Promise<void>;
  /** Lane J crash guard: tell the renderer the vault was locked after a fault (`code` only, never a message). */
  crashRecovered(code: string): void;
}

const lockedError = <T>(): Result<T> => err('VAULT_LOCKED', 'Vault is locked');

// ---------------------------------------------------------------------------------------------------------------

export async function composeApp(opts: ComposeOptions): Promise<ComposedApp> {
  const { paths, ports } = opts;
  const log = opts.logger ?? nullLogger;
  const now = opts.now ?? (() => Date.now());
  const sources: HostSources = {};

  let audit: AuditLog | null = null;
  let creating = false;
  let lastLockReason: LockReason = 'manual';
  let updates: UpdateServiceLike | null = null;
  let backupTimer: ReturnType<typeof setInterval> | null = null;
  let skipLockBackup = false;
  /** true once the renderer was already sent to the lock route for the current lock (avoid a second reload). */
  let routedToLock = false;

  // --- encrypted DB ----------------------------------------------------------------------------------------------
  const db = new SqliteDbController({
    path: join(paths.dataDir, 'vss.db'),
    backupDir: paths.migrationBackupDir,
    onOpen: (conn: Db, migration) => {
      audit = new AuditLog(conn);
      try {
        audit.append({
          actor: 'user',
          type: creating ? 'vault.create' : 'vault.unlock',
          subjectType: 'vault',
          subjectId: null,
          details: { schemaVersion: migration.to },
        });
      } catch {
        // an audit failure must not abort the unlock (the controller would be left open without keys)
        log.error('audit.append.failed', { kind: 'unlock' });
      }
    },
    onClose: () => {
      try {
        audit?.append({
          actor: 'user',
          type: 'vault.lock',
          subjectType: 'vault',
          subjectId: null,
          details: { reasonCode: lastLockReason },
        });
      } catch {
        log.error('audit.append.failed', { kind: 'lock' });
      }
      audit = null;
    },
  });
  const requireAudit = (): AuditLog => {
    if (!audit) throw new DbError('NOT_OPEN', 'database is not open');
    return audit;
  };

  // --- services ------------------------------------------------------------------------------------------------
  /** Throws (BAD_CREDENTIALS / RATE_LIMITED) unless `password` opens the vault's password slot. */
  const checkPassword = async (password: string): Promise<void> => {
    const status = await vault.status();
    const vaultPath = status.ok ? status.value.vaultPath : null;
    if (!vaultPath) throw new Error('no vault');
    const km = await cryptoUnlock({ dir: dirname(vaultPath), password, now });
    km.dispose();
  };
  const passwordOk = async (password: string): Promise<boolean> => {
    try {
      await checkPassword(password);
      return true;
    } catch {
      return false;
    }
  };

  const settings = new SettingsService({
    repo: () => db.repos().settings,
    audit: requireAudit,
    transact: (fn) => db.current().transaction(fn),
    verifyPassword: checkPassword,
    onChanged: (_next, changed) => {
      lock.ping(); // a settings change counts as activity (a shorter timeout must not lock instantly)
      log.info('settings.changed', { count: changed.length });
    },
  });

  const clipboard = new ClipboardService({
    port: ports.clipboard,
    clearSeconds: () => settings.getOrDefault().clipboardClearSeconds,
    onCleared: () => ports.emit('clipboard:cleared', {}),
  });

  const lock: LockController = new LockController({
    autoLockMinutes: () => settings.getOrDefault().autoLockMinutes,
    isUnlocked: () => db.isOpen,
    systemIdleSeconds: () => ports.systemIdleSeconds(),
    emitWarning: (s) => ports.emit('vault:lock-warning', { secondsRemaining: s }),
    performLock: (reason) => performLock(reason),
    ...(opts.lockTickMs !== undefined ? { tickMs: opts.lockTickMs } : {}),
    now,
  });

  const vault: VaultService = new VaultService({
    db,
    dataDir: paths.dataDir,
    ...(opts.kdf ? { kdf: opts.kdf } : {}),
    ...(opts.backupKdf ? { backupKdf: opts.backupKdf } : {}),
    now,
    autoLockInSeconds: () => lock.remainingSeconds(),
    onActivity: () => lock.ping(),
    onUnlocked: (status) => onUnlocked(status),
    onLocked: (reason) => void afterLocked(reason),
  });

  /** Every backup (manual, scheduled, on-lock) is audited and remembered for the dashboard. */
  const auditedBackup = async (req: VaultBackupRequest): Promise<Result<VaultBackupResult>> => {
    const r = await vault.backup(req);
    if (r.ok && db.isOpen) {
      try {
        audit?.append({
          actor: 'user',
          type: 'vault.backup',
          subjectType: 'vault',
          subjectId: null,
          details: { bytes: r.value.bytes, sha256: r.value.sha256 },
        });
      } catch {
        log.error('audit.append.failed', { kind: 'backup' });
      }
    }
    return r;
  };

  const backup = new BackupService({
    meta: () => db.repos().meta,
    vaultBackup: auditedBackup,
    vaultRestore: (req) => vault.restore(req),
    dataDir: paths.dataDir,
    now,
    ...(opts.backupKdf ? { keyringKdf: opts.backupKdf } : {}),
  });

  /** Dialog-issued path tokens (F-02); dropped on every lock. */
  const grants = new PathGrants(now);
  const lockHooks: (() => void)[] = [];
  const files = new FilesService({
    port: ports.files,
    grants,
    storedFiles: () => db.repos().files,
    // lane J: an open native dialog defers the idle lock; a failing dialog is logged without message or path
    holdWhile: (p) => lock.holdWhile(p),
    onDialogError: (kind) => log.warn('dialog.failed', { kind }),
  });

  // --- update service (NetGate stays closed unless updates are enabled; see update/service.ts) ---------------------
  try {
    updates = await opts.updates({
      isCheckEnabled: async () => db.isOpen && settings.getOrDefault().updateCheckEnabled,
      emit: (s) => ports.emit('updates:state', s),
      store: settingsLastCheckStore(() => (db.isOpen ? db.current() : null)),
    });
  } catch {
    log.error('updates.init.failed', { kind: 'updates' });
    updates = null;
  }

  // --- lock / unlock sequences -------------------------------------------------------------------------------
  function onUnlocked(status: VaultStatus): void {
    lock.arm();
    ports.emit('vault:unlocked', status);
    if (backupTimer) clearInterval(backupTimer);
    backupTimer = setInterval(() => void backup.runIfDue().catch(() => undefined), 10 * 60 * 1000);
    (backupTimer as { unref?: () => void }).unref?.();
    // A brand-new vault has not shown the user its settings yet: no network on the very first unlock.
    if (!creating && updates) void updates.onUnlocked().catch(() => undefined);
  }

  /** Runs for EVERY lock (idle, suspend, manual IPC, quit): wipe what the renderer and the clipboard may hold. */
  async function afterLocked(reason: 'manual' | 'error'): Promise<void> {
    lock.disarm();
    grants.clear();
    for (const fn of lockHooks) {
      try {
        fn();
      } catch {
        log.warn('lock.hook.failed', { kind: 'lock' });
      }
    }
    if (backupTimer) clearInterval(backupTimer);
    backupTimer = null;
    const shown: VssEventMap['vault:locked']['reason'] = reason === 'error' ? 'error' : lastLockReason;
    try {
      await clipboard.clearIfOurs();
    } catch {
      log.warn('clipboard.clear.failed', { kind: 'lock' });
    }
    try {
      await ports.clearRendererState();
    } catch {
      log.warn('renderer.clear.failed', { kind: 'lock' });
    }
    ports.emit('vault:locked', { reason: shown });
    if (!routedToLock) ports.navigate('lock');
    routedToLock = false;
    lastLockReason = 'manual';
    log.info('vault.locked', { reason: shown });
  }

  async function performLock(reason: LockReason, opt: { backup?: boolean } = {}): Promise<void> {
    lastLockReason = reason;
    if (!db.isOpen) {
      vault.forceLock();
      return;
    }
    // Hide the data first; the optional backup runs behind the lock screen.
    ports.navigate('lock');
    routedToLock = true;
    const wantBackup =
      !skipLockBackup && (opt.backup ?? true) && (reason === 'manual' || reason === 'idle') && backup.wantsLockBackup;
    if (wantBackup) {
      const timeout = opts.lockBackupTimeoutMs ?? 60_000;
      try {
        await Promise.race([
          backup.runNow(),
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, timeout);
            (t as { unref?: () => void }).unref?.();
          }),
        ]);
      } catch {
        log.error('backup.onlock.failed', { kind: 'backup' });
      }
    }
    vault.forceLock(); // closes the DB (audit 'vault.lock'), disposes key material, then afterLocked() runs
  }

  // --- handlers ---------------------------------------------------------------------------------------------------
  const unlockedGuard = async <T>(fn: () => Promise<Result<T>> | Result<T>): Promise<Result<T>> =>
    db.isOpen ? fn() : lockedError<T>();

  const guardDb = async <T>(fn: () => Promise<Result<T>> | Result<T>): Promise<Result<T>> => {
    try {
      return await fn();
    } catch (e) {
      if (isDbError(e, 'NOT_OPEN')) return lockedError<T>();
      throw e;
    }
  };

  const backupList = async (): Promise<BackupListResult> => {
    const config = backup.config();
    const last = backup.lastAt();
    const files = config ? await backup.list(config.dir) : [];
    return {
      config,
      backups: files.map((f) => ({
        name: f.name,
        path: join(config!.dir, f.name),
        bytes: f.bytes,
        modifiedAt: new Date(f.modifiedAt).toISOString(),
      })),
      lastBackupAt: last === null ? null : new Date(last).toISOString(),
    };
  };

  const mine: Handlers = {
    vault: {
      status: () => vault.status(),
      create: async (req) => {
        creating = true;
        try {
          await mkdir(paths.dataDir, { recursive: true });
          // The renderer never chooses where the vault lives: always the app data folder.
          return await vault.create({ password: req.password, displayName: req.displayName, directory: paths.dataDir });
        } finally {
          creating = false;
        }
      },
      open: (req) => vault.open(req),
      unlock: (req) => vault.unlock(req),
      lock: async () => {
        await lock.lock('manual');
        return vault.status();
      },
      changePassword: async (req) => {
        const r = await vault.changePassword(req);
        if (r.ok && db.isOpen) {
          try {
            audit?.append({
              actor: 'user',
              type: 'vault.password-change',
              subjectType: 'vault',
              subjectId: null,
              details: { action: 'rekey' },
            });
          } catch {
            log.error('audit.append.failed', { kind: 'password-change' });
          }
        }
        return r;
      },
      enrollFido2: () => vault.enrollFido2(),
      removeSlot: () => vault.removeSlot(),
      backup: (req) =>
        withGrant(async () => {
          const destPath = grants.resolve(req.destPath, 'save', ['backup']);
          const r = await auditedBackup({ ...req, destPath });
          if (r.ok && db.isOpen) backup.noteSuccess();
          return r;
        }),
      restore: (req) =>
        withGrant(async () => {
          // destDirectory is checked against the data folder by VaultService (F-04).
          const srcPath = grants.resolve(req.srcPath, 'open', ['backup']);
          return vault.restore({ ...req, srcPath });
        }),
      wipe: async (req) => {
        if (req.alsoDeleteScheduledBackups === true) {
          // The backup folder is only known while the vault is open, and only a proven owner may delete in it.
          try {
            await checkPassword(req.password);
          } catch (e) {
            const code = (e as { code?: string }).code === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'BAD_CREDENTIALS';
            return err(code, code === 'RATE_LIMITED' ? 'Too many failed attempts' : 'Password check failed');
          }
          let backupDir: string | null = null;
          try {
            backupDir = db.isOpen ? (backup.config()?.dir ?? null) : null;
          } catch {
            backupDir = null;
          }
          try {
            await (opts.wipeExtras ?? defaultWipeExtras)(req, { backupDir });
          } catch {
            log.warn('wipe.extras.failed', { kind: 'wipe' });
          }
        }
        const r = await vault.wipe(req);
        // F-17: pre-migration copies are encrypted under the DEK that just became unrecoverable; remove them too.
        if (r.ok) await rm(paths.migrationBackupDir, { recursive: true, force: true }).catch(() => undefined);
        // No audit is possible after a wipe: this PII-free log line is the only trace.
        log.info('vault.wiped', { kind: 'wipe', ok: r.ok });
        return r;
      },
      touch: () => vault.touch(),
    },
    settings: {
      get: async () => settings.get(),
      update: (req) => settings.update(req),
    },
    backup: {
      configure: (req) =>
        unlockedGuard(async () => {
          try {
            await checkPassword(req.reauth.password);
          } catch (e) {
            const code = (e as { code?: string }).code === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'BAD_CREDENTIALS';
            return err(code, code === 'RATE_LIMITED' ? 'Too many failed attempts' : 'Password check failed');
          }
          let newPassphrase: string | null = null;
          if (req.config === null) {
            backup.clearConfig();
          } else {
            // The folder is a fresh folder-dialog token, or exactly the folder already configured (F-02).
            let dir: string;
            if (isPathToken(req.config.dir)) {
              const resolved = await withGrant(() => ok(grants.resolve(req.config!.dir, 'directory', ['directory'])));
              if (!resolved.ok) return resolved;
              dir = resolved.value;
            } else if (req.config.dir === backup.config()?.dir) {
              dir = req.config.dir;
            } else {
              return err('BAD_REQUEST', 'Choose the backup folder again');
            }
            const r = backup.configureSchedule(
              { ...req.config, dir },
              { regenerate: req.regeneratePassphrase === true },
            );
            if (!r.ok) return r;
            newPassphrase = r.value.newPassphrase;
          }
          requireAudit().append({
            actor: 'user',
            type: 'backup.configure',
            subjectType: 'vault',
            subjectId: null,
            details: {
              enabled: req.config !== null,
              action: newPassphrase === null ? 'schedule' : 'new-passphrase',
            },
          });
          lock.ping();
          return ok({ ...(await backupList()), newPassphrase });
        }),
      list: () => unlockedGuard(async () => ok(await backupList())),
      runNow: () => unlockedGuard(() => backup.runNow()),
      restore: async (req) => {
        const src = await withGrant(() => ok(grants.resolve(req.srcPath, 'open', ['backup'])));
        if (!src.ok) return src;
        const st = await vault.status();
        if (st.ok && st.value.state !== 'no-vault')
          return err('VAULT_EXISTS', 'Restore is only possible before a vault exists on this computer');
        await mkdir(paths.dataDir, { recursive: true });
        const r = await backup.restore(src.value, req.passphrase);
        // A vault exists now (locked): show the unlock screen in a fresh document.
        if (r.ok) ports.navigate('unlock');
        return r;
      },
    },
    clipboard: {
      copy: (req) =>
        unlockedGuard(async () => {
          let text: string | null = null;
          if (req.personId !== undefined) {
            if (!sources.personFields) return err('NOT_SUPPORTED', 'Person fields are not available yet');
            text = sources.personFields.field(req.personId, req.field);
            if (text === null) return err('NOT_FOUND', 'Nothing to copy');
          } else if (req.text !== undefined) {
            text = req.text;
          }
          if (text === null) return err('BAD_REQUEST', 'Nothing to copy');
          return clipboard.copy(text, { sensitive: true });
        }),
      clear: () => clipboard.clear(),
    },
    email: {
      draft: (req) =>
        unlockedGuard(async () => {
          if (!sources.requestStatus) return err('NOT_SUPPORTED', 'Email drafts need the request service');
          try {
            req.to?.forEach(assertAddress);
            req.cc?.forEach(assertAddress);
            const snap = await sources.requestStatus.snapshot(req.requestId);
            if (!snap) return err('NOT_FOUND', 'Request not found');
            // DOB / ID columns are opt-in per email (default: name, unit, status, valid until).
            const fields: EmailFieldSet = { dob: req.fields?.dob === true, ids: req.fields?.ids === true };
            return ok(buildDraft(req, snap, fields));
          } catch (e) {
            if (e instanceof EmailError) return err(e.code, e.message);
            throw e;
          }
        }),
      writeEml: (req) =>
        unlockedGuard(async () => {
          const dest = await withGrant(() => ok(grants.resolve(req.destPath, 'save', ['eml'])));
          if (!dest.ok) return dest;
          try {
            let attachment: { name: string; bytes: Uint8Array } | null = null;
            if (req.attachExportId !== undefined) {
              if (!sources.exportFiles) return err('NOT_SUPPORTED', 'Attachments need the request service');
              attachment = await sources.exportFiles.read(req.attachExportId);
              if (!attachment) return err('NOT_FOUND', 'Export not found');
            }
            const eml = buildEml(req.draft, { attachment, now: new Date(now()) });
            await writeFile(dest.value, eml, { encoding: 'utf8' });
            grants.noteWritten(dest.value);
            return ok({ path: dest.value });
          } catch (e) {
            if (e instanceof EmailError) return err(e.code, e.message);
            throw e;
          }
        }),
      mailto: (req) =>
        unlockedGuard(async () => {
          try {
            const res = buildMailto(req);
            // The renderer cannot open URLs itself (CSP + navigation blocked), so main opens it. When the body did
            // not fit (`truncated`) nothing is opened: the UI must offer .eml / copy instead.
            if (!res.truncated) await openMailto(res.url, ports.openExternal);
            return ok(res);
          } catch (e) {
            if (e instanceof EmailError) return err(e.code, e.message);
            throw e;
          }
        }),
    },
    files: {
      pickOpen: (req) => files.pickOpen(req),
      pickSave: (req) => files.pickSave(req),
      reveal: (req) => unlockedGuard(() => files.reveal(req)),
      saveStored: (req) => guardDb(() => files.saveStored(req)),
    },
    audit: {
      list: (req) => guardDb(() => ok(requireAudit().list(req))),
      verify: () => guardDb(() => ok(requireAudit().verifyChain())),
      export: (req) =>
        guardDb(async () => {
          const a = requireAudit();
          const dest = await withGrant(() => ok(grants.resolve(req.destPath, 'save', ['audit'])));
          if (!dest.ok) return dest;
          const lines: string[] = [];
          for (let offset = 0; ; offset += 500) {
            const page = a.list({ offset, limit: 500 });
            for (const e of page.items.slice().reverse()) lines.push(JSON.stringify(e));
            if (offset + 500 >= page.total) break;
          }
          // Exactly the file chosen in the save dialog; no directories are created (F-02).
          await writeFile(dest.value, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
          grants.noteWritten(dest.value);
          return ok({ path: dest.value });
        }),
    },
    ...(updates ? { updates: updates.handlers() } : {}),
    app: {
      // No vault data: answers while locked too.
      info: async () =>
        ok({
          version: opts.appInfo?.version ?? '0.0.0',
          channel: opts.appInfo?.channel ?? 'dev',
          platform: process.platform,
          schemaVersion: APP_SCHEMA_VERSION,
        }),
      // LANE I SLOT: the fixed, allowlisted feedback URL (docs/PLAN-ALPHA.md section 12).
      openFeedback: async () => err('NOT_SUPPORTED', 'Feedback is not available in this version'),
      // R16: geometry only, no vault data: answers while locked too.
      resetWindowState: async () => {
        opts.resetWindowState?.();
        return ok({ ok: true as const });
      },
    },
  };

  // ===== LANE H SLOT ==============================================================================================
  // Lane H returns handlers for requests / responses / persons / units / review / stats and the data providers
  // (RequestStatusSource, ExportFileSource, PersonFieldSource). Methods implemented above always win.
  // Until the factory is supplied these namespaces answer NOT_SUPPORTED (registry default).
  const contribution = (opts.laneH ?? createDomainContribution)({
    db,
    repos: () => db.repos(),
    audit: requireAudit,
    settings: () => settings.getOrDefault(),
    emit: ports.emit,
    now,
    logger: log,
    sources,
    verifyPassword: passwordOk,
    grants,
    onLock: (fn) => void lockHooks.push(fn),
  });
  Object.assign(sources, contribution.sources ?? {});
  const handlers: Handlers = {};
  for (const ns of new Set([...Object.keys(contribution.handlers ?? {}), ...Object.keys(mine)])) {
    (handlers as Record<string, unknown>)[ns] = {
      ...((contribution.handlers as Record<string, object> | undefined)?.[ns] ?? {}),
      ...((mine as Record<string, object>)[ns] ?? {}),
    };
  }
  // =============================================================================================================

  if (ports.power) lock.attach(ports.power);

  return {
    handlers,
    vault,
    db,
    lock,
    clipboard,
    backup,
    settings,
    sources,
    async initialRoute() {
      if (!vaultExists(paths.dataDir)) return 'create';
      const r = await vault.open({ path: paths.dataDir });
      if (!r.ok) log.warn('vault.open.failed', { code: r.error.code });
      return 'unlock';
    },
    async shutdown(o = {}) {
      skipLockBackup = o.backup === false;
      await lock.lock('manual').catch(() => undefined);
      if (db.isOpen) {
        lastLockReason = 'manual';
        vault.forceLock();
      }
      lock.dispose();
      if (backupTimer) clearInterval(backupTimer);
      backupTimer = null;
    },
    crashRecovered(code) {
      ports.emit('app:crash-recovered', { code });
    },
  };
}

export type { Ack };
