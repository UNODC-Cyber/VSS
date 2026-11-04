/**
 * Crash guard (lane J, R10). Registered before `app.whenReady()` so Electron's raw "A JavaScript error occurred in
 * the main process" box is never shown (Electron only shows it when no uncaughtException listener exists).
 *
 * On an uncaught exception, an unhandled rejection or a crashed child process:
 * - one PII-free log line `{ kind, code, phase }` through the allowlisted logger: `code` is a fixed classification
 *   (error class name or an UPPER_CASE error code), never the message, the stack or a path;
 * - the vault is locked;
 * - `app:crash-recovered` is emitted when the event exists (contract lane A0; wired through `emitRecovered`);
 * - a friendly message box offers Continue / Quit (one at a time);
 * - a second fault within 5 s quits; a fault before the app is ready shows a plain error box and exits.
 * No Electron import: everything is injected (tests/unit/app/crash-guard.test.ts).
 */
import type { Logger } from '../app/logger';

export type FaultKind = 'uncaught' | 'rejection' | 'child';

export const CRASH_TEXT = {
  title: 'Vetting Support System',
  message: 'Something went wrong; the vault was locked to protect your data.',
  detail: 'No personal data was written to a log. You can continue (unlock again) or quit the application.',
  continue: 'Continue',
  quit: 'Quit',
  startup: 'Vetting Support System could not start. No personal data was written to a log.',
  startupDetail: 'Check that the data folder is available (VSS_DATA_DIR, if set, must be an absolute folder path).',
} as const;

/** Child-process exits that are not faults. */
const BENIGN_CHILD = new Set(['clean-exit', 'killed']);
export const REPEAT_WINDOW_MS = 5_000;

export interface ChildGoneDetails {
  type: string;
  reason: string;
}

export interface CrashGuardDeps {
  /** process.on for the two process-level events. */
  onProcess(event: 'uncaughtException' | 'unhandledRejection', fn: (e: unknown) => void): void;
  /** app.on('child-process-gone'). */
  onChildGone(fn: (details: ChildGoneDetails) => void): void;
  log: Logger;
  isReady(): boolean;
  /** Lock the vault (composed.lock.lock('error')); may be absent before compose ran. */
  lock(): Promise<void> | void;
  emitRecovered?(code: string): void;
  /** dialog.showMessageBox with Continue (0) / Quit (1). */
  showDialog(text: typeof CRASH_TEXT): Promise<'continue' | 'quit'>;
  /** dialog.showErrorBox (works before ready). */
  showStartupError(text: typeof CRASH_TEXT): void;
  quit(): void;
  /** Hard exit (before ready, or when quitting fails). */
  exit(code: number): void;
  now?(): number;
}

const CODE_RE = /^[A-Z][A-Z0-9_]{1,39}$/;
const NAME_RE = /^[A-Za-z][A-Za-z0-9]{1,39}$/;

/** A fixed, PII-free classification of `e`: never the message. */
export function faultCode(e: unknown): string {
  if (e && typeof e === 'object') {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && CODE_RE.test(code)) return code;
    const name = (e as { name?: unknown }).name;
    if (typeof name === 'string' && NAME_RE.test(name)) return name;
    return 'OBJECT';
  }
  return e === undefined || e === null ? 'EMPTY' : typeof e === 'string' ? 'STRING' : 'PRIMITIVE';
}

const FRAME_RE = /^\s*at (?:.*? \()?(?:.*[\\/])?([^\\/()]+?):(\d+):(\d+)\)?\s*$/;

/**
 * Where `e` was thrown, PII-free: up to three stack frames as `<file base name>:<line>:<col>`, joined by " < ".
 * Only `    at ...` lines are read (the message line(s) are skipped), function names and directories are dropped, so
 * neither the message nor a user path can end up in the log. Maps to source with the locally kept source maps.
 */
export function faultFrames(e: unknown): string {
  const stack = e && typeof e === 'object' ? (e as { stack?: unknown }).stack : undefined;
  if (typeof stack !== 'string') return '';
  const frames: string[] = [];
  for (const line of stack.split('\n')) {
    if (!/^\s+at /.test(line)) continue;
    const m = FRAME_RE.exec(line);
    if (!m) continue;
    const file = m[1]!.replace(/[^A-Za-z0-9._-]/g, '_');
    frames.push(`${file}:${m[2]}:${m[3]}`);
    if (frames.length === 3) break;
  }
  return frames.join(' < ');
}

export interface CrashGuard {
  /** Exposed for tests and for index.ts' explicit startup fault path. */
  handle(kind: FaultKind, e: unknown, phase?: string): Promise<void>;
  /** A fault that makes starting impossible (before ready): log, plain error box, exit(1). */
  fatalStartup(phase: string, e: unknown): void;
}

export function installCrashGuard(d: CrashGuardDeps): CrashGuard {
  const now = d.now ?? Date.now;
  let lastFault = Number.NEGATIVE_INFINITY;
  let dialogOpen = false;
  let quitting = false;

  const logFault = (kind: FaultKind, code: string, phase: string, e?: unknown): void => {
    try {
      const at = kind === 'child' ? '' : faultFrames(e);
      d.log.error('app.fault', { kind, code, phase, ...(at ? { at } : {}) });
    } catch {
      // never throw from the guard
    }
  };

  const quit = (): void => {
    if (quitting) return;
    quitting = true;
    try {
      d.quit();
    } catch {
      d.exit(1);
    }
  };

  const fatalStartup = (phase: string, e: unknown): void => {
    logFault('uncaught', faultCode(e), phase, e);
    try {
      d.showStartupError(CRASH_TEXT);
    } catch {
      // no UI possible
    }
    d.exit(1);
  };

  const handle = async (kind: FaultKind, e: unknown, phase?: string): Promise<void> => {
    const code = kind === 'child' ? String((e as ChildGoneDetails | null)?.reason ?? 'unknown') : faultCode(e);
    const ready = d.isReady();
    const at = phase ?? (ready ? 'running' : 'startup');
    if (!ready) {
      fatalStartup(at, e); // logs once
      return;
    }
    logFault(kind, code, at, e);
    const t = now();
    const repeated = t - lastFault < REPEAT_WINDOW_MS;
    lastFault = t;
    try {
      await d.lock();
    } catch {
      // the lock controller never rejects; keep going regardless
    }
    try {
      d.emitRecovered?.(code);
    } catch {
      // renderer may be gone
    }
    if (repeated || quitting) {
      quit();
      return;
    }
    if (dialogOpen) return;
    dialogOpen = true;
    try {
      const choice = await d.showDialog(CRASH_TEXT);
      if (choice === 'quit') quit();
    } catch {
      quit();
    } finally {
      dialogOpen = false;
    }
  };

  d.onProcess('uncaughtException', (e) => void handle('uncaught', e));
  d.onProcess('unhandledRejection', (e) => void handle('rejection', e));
  d.onChildGone((details) => {
    if (BENIGN_CHILD.has(details.reason)) return;
    void handle('child', { reason: details.reason });
  });
  return { handle, fatalStartup };
}
