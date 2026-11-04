/**
 * LockController (WP-05): auto-lock after N idle minutes, immediate lock on suspend / screen lock, 30 s warning.
 *
 * Idle = max(seconds since the last renderer activity ping, OS-wide idle seconds). The renderer pings through
 * `vault.touch`; the OS idle time (powerMonitor.getSystemIdleTime) stops a synthetic ping stream from keeping the
 * vault open while the user is away, and the ping age locks the vault when the user works in other applications.
 *
 * The controller only decides WHEN to lock; `performLock` (wired in app/compose.ts) closes the DB, disposes keys,
 * clears caches/clipboard and tells the renderer. No Electron import: timers and clocks are injectable.
 */

export type LockReason = 'manual' | 'idle' | 'suspend' | 'screen-lock' | 'error';

export interface LockControllerDeps {
  /** Current settings.autoLockMinutes (read on every tick, so setting changes apply at once). */
  autoLockMinutes(): number;
  isUnlocked(): boolean;
  /** powerMonitor.getSystemIdleTime(). */
  systemIdleSeconds(): number;
  performLock(reason: LockReason): void | Promise<void>;
  emitWarning(secondsRemaining: number): void;
  now?(): number;
  /** Tick period, default 1000 ms. */
  tickMs?: number;
  /** Warning lead time, default 30 s. */
  warnSeconds?: number;
  /** Longest time an open native dialog may defer the idle lock (holdWhile), default 10 min. */
  maxHoldMs?: number;
}

export const DEFAULT_MAX_HOLD_MS = 10 * 60_000;

type PowerEvent = 'suspend' | 'lock-screen' | 'resume';
/** The subset of Electron's powerMonitor used here. */
export interface PowerEvents {
  on(event: PowerEvent, listener: () => void): unknown;
  removeListener(event: PowerEvent, listener: () => void): unknown;
}

export class LockController {
  readonly #d: LockControllerDeps;
  #timer: ReturnType<typeof setInterval> | null = null;
  #lastActivity = 0;
  #locking: Promise<void> | null = null;
  #detach: (() => void) | null = null;
  #holds = 0;
  #holdSince = 0;

  constructor(deps: LockControllerDeps) {
    this.#d = deps;
  }

  #now(): number {
    return (this.#d.now ?? Date.now)();
  }

  get armed(): boolean {
    return this.#timer !== null;
  }

  /** Start watching (call after every unlock). Resets the idle clock. */
  arm(): void {
    this.disarm();
    this.#lastActivity = this.#now();
    this.#timer = setInterval(() => this.tick(), this.#d.tickMs ?? 1000);
    // Never keep the process alive just for the idle timer.
    (this.#timer as { unref?: () => void }).unref?.();
  }

  disarm(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Renderer activity ping (vault.touch). */
  ping(): void {
    if (!this.#timer) return;
    this.#lastActivity = this.#now();
  }

  /** Seconds until idle lock, null when not armed. */
  remainingSeconds(): number | null {
    if (!this.#timer) return null;
    const limit = Math.max(1, this.#d.autoLockMinutes()) * 60;
    const idle = Math.max((this.#now() - this.#lastActivity) / 1000, this.#d.systemIdleSeconds());
    return Math.max(0, Math.ceil(limit - idle));
  }

  tick(): void {
    if (!this.#d.isUnlocked()) {
      this.disarm();
      return;
    }
    const remaining = this.remainingSeconds();
    if (remaining === null) return;
    // A native dialog is open (the renderer cannot ping while it is modal): defer the idle lock, up to maxHoldMs.
    if (this.#holds > 0 && !this.#holdExpired()) return;
    if (remaining <= 0) {
      void this.lock('idle');
      return;
    }
    if (remaining <= (this.#d.warnSeconds ?? 30)) this.#d.emitWarning(remaining);
  }

  /** true while at least one holdWhile() promise is pending. */
  get held(): boolean {
    return this.#holds > 0;
  }

  #holdExpired(): boolean {
    return this.#now() - this.#holdSince >= (this.#d.maxHoldMs ?? DEFAULT_MAX_HOLD_MS);
  }

  /**
   * Defer the IDLE lock while `p` is pending (an open native dialog). Suspend, screen lock, manual and error locks
   * are never deferred. Once the hold lasted longer than maxHoldMs the idle lock runs anyway (the window port defers
   * only the lock-screen reload until the dialog returns). When the last hold ends, answering the dialog counts as
   * activity unless the cap was exceeded, in which case the vault locks at once. Returns `p` unchanged.
   */
  holdWhile<T>(p: Promise<T>): Promise<T> {
    if (this.#holds === 0) this.#holdSince = this.#now();
    this.#holds++;
    const release = (): void => {
      this.#holds = Math.max(0, this.#holds - 1);
      if (this.#holds > 0) return;
      if (!this.#timer) return;
      if (this.#holdExpired()) void this.lock('idle');
      else this.ping();
    };
    p.then(release, release);
    return p;
  }

  /** Lock now. Idempotent while a lock is running. Never rejects. */
  lock(reason: LockReason): Promise<void> {
    if (this.#locking) return this.#locking;
    this.disarm();
    const run = (async () => {
      try {
        await this.#d.performLock(reason);
      } catch {
        // performLock is responsible for logging; a failing step must not leave the controller stuck
      }
    })();
    this.#locking = run.finally(() => {
      this.#locking = null;
    });
    return this.#locking;
  }

  /** Subscribe to OS power events. Returns a detach function. */
  attach(power: PowerEvents): () => void {
    this.#detach?.();
    const onSuspend = (): void => void this.lock('suspend');
    const onLockScreen = (): void => void this.lock('screen-lock');
    const onResume = (): void => this.tick();
    power.on('suspend', onSuspend);
    power.on('lock-screen', onLockScreen);
    power.on('resume', onResume);
    this.#detach = () => {
      power.removeListener('suspend', onSuspend);
      power.removeListener('lock-screen', onLockScreen);
      power.removeListener('resume', onResume);
    };
    return this.#detach;
  }

  dispose(): void {
    this.disarm();
    this.#detach?.();
    this.#detach = null;
  }
}
