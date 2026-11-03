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
}

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
    if (remaining <= 0) {
      void this.lock('idle');
      return;
    }
    if (remaining <= (this.#d.warnSeconds ?? 30)) this.#d.emitWarning(remaining);
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
