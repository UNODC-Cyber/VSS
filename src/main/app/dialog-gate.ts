/**
 * DialogGate (lane J, R10): one native file dialog at a time, and nothing that tears the window down while one is up.
 *
 * Evidence (docs/INVESTIGATION-dialog-crash.md): a double click on a "Choose file" button queued a second native
 * Open dialog that popped up right after the first returned, over the import summary page; the owner's native crash
 * (BEX64, explorerframe.dll unloaded) happened on that page. An idle lock could also reload the renderer while the
 * modal dialog was open. The gate removes both situations:
 * - `run()` admits one dialog; a call made while one is open is answered with the caller's "cancelled" value;
 * - `whenIdle()` lets the window port defer navigation (lock screen reload) until the dialog has returned;
 * - `dialogParent()` only parents a dialog on a live, visible, non-minimised window;
 * - `compactOptions()` never hands Electron an options member that is `undefined` (Electron's argument converter
 *   rejects some of those: "Error processing argument at index 1, conversion failure").
 * No Electron import: unit-tested in tests/unit/app/dialog-gate.test.ts.
 */

export interface DialogWindowLike {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
}

export class DialogGate {
  #open = false;
  #waiters: (() => void)[] = [];
  readonly #onChange: ((open: boolean) => void) | undefined;

  constructor(onChange?: (open: boolean) => void) {
    this.#onChange = onChange;
  }

  get isOpen(): boolean {
    return this.#open;
  }

  /**
   * Run `show` unless a dialog is already open, in which case `busy()` answers at once (the second dialog is never
   * shown). `show` throwing or rejecting releases the gate and rethrows.
   */
  async run<T>(show: () => Promise<T>, busy: () => T): Promise<T> {
    if (this.#open) return busy();
    this.#set(true);
    try {
      return await show();
    } finally {
      this.#set(false);
    }
  }

  /** Resolves immediately when no dialog is open, otherwise once the current one has returned. */
  whenIdle(): Promise<void> {
    if (!this.#open) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  #set(open: boolean): void {
    this.#open = open;
    try {
      this.#onChange?.(open);
    } catch {
      // observers (lock hold) must never break the dialog path
    }
    if (!open) {
      const w = this.#waiters;
      this.#waiters = [];
      for (const fn of w) fn();
    }
  }
}

/** The window a dialog may be parented on, or null (then the dialog is shown unparented). */
export function dialogParent<W extends DialogWindowLike>(win: W | null | undefined): W | null {
  if (!win) return null;
  try {
    if (win.isDestroyed() || !win.isVisible() || win.isMinimized()) return null;
  } catch {
    return null;
  }
  return win;
}

/** A shallow copy of `o` without `undefined` members and without empty `filters`. */
export function compactOptions<T extends object>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) continue;
    if (k === 'filters' && Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}
