/**
 * Clipboard service: copy via main only. Sensitive entries are written with the Windows "exclude from history /
 * cloud sync" formats (best effort, see app/electron-ports.ts) and auto-cleared after settings.clipboardClearSeconds,
 * but only when the clipboard still holds exactly what we wrote. Cleared on lock under the same condition.
 * Only a SHA-256 of what we wrote is kept in memory, never the text.
 */
import { createHash } from 'node:crypto';
import type { Ack, ClipboardCopyResult, Result } from '@shared/ipc/contract';
import { ok } from '@shared/ipc/result';

export interface ClipboardPort {
  /** Write text. `sensitive` => add the exclusion formats (VERIFY on a real Windows 11 build). */
  write(text: string, sensitive: boolean): Promise<void>;
  readText(): Promise<string>;
  clear(): Promise<void>;
}

export interface ClipboardServiceDeps {
  port: ClipboardPort;
  clearSeconds(): number;
  onCleared(): void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export class ClipboardService {
  readonly #d: ClipboardServiceDeps;
  #written: string | null = null;
  #timer: unknown = null;

  constructor(deps: ClipboardServiceDeps) {
    this.#d = deps;
  }

  async copy(text: string, opts: { sensitive?: boolean } = {}): Promise<Result<ClipboardCopyResult>> {
    const sensitive = opts.sensitive ?? true;
    this.#cancelTimer();
    await this.#d.port.write(text, sensitive);
    if (!sensitive) {
      this.#written = null;
      return ok({ clearsInSeconds: 0 });
    }
    this.#written = sha(text);
    const seconds = Math.max(1, this.#d.clearSeconds());
    const set = this.#d.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.#timer = set(() => void this.clearIfOurs(), seconds * 1000);
    (this.#timer as { unref?: () => void } | null)?.unref?.();
    return ok({ clearsInSeconds: seconds });
  }

  /** Clears the clipboard only if it still contains what we wrote. Returns true when it was cleared. */
  async clearIfOurs(): Promise<boolean> {
    this.#cancelTimer();
    const mine = this.#written;
    this.#written = null;
    if (mine === null) return false;
    let current: string;
    try {
      current = await this.#d.port.readText();
    } catch {
      return false;
    }
    if (sha(current) !== mine) return false;
    await this.#d.port.clear();
    this.#d.onCleared();
    return true;
  }

  async clear(): Promise<Result<Ack>> {
    await this.clearIfOurs();
    return ok({ ok: true as const });
  }

  get hasPending(): boolean {
    return this.#written !== null;
  }

  #cancelTimer(): void {
    if (this.#timer !== null) (this.#d.clearTimer ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout)))(this.#timer);
    this.#timer = null;
  }
}
