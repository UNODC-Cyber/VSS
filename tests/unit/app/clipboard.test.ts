import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClipboardService } from '../../../src/main/services/clipboard';
import type { ClipboardPort } from '../../../src/main/services/clipboard';

class FakeClipboard implements ClipboardPort {
  text = '';
  sensitiveFlag: boolean | null = null;
  async write(text: string, sensitive: boolean): Promise<void> {
    this.text = text;
    this.sensitiveFlag = sensitive;
  }
  async readText(): Promise<string> {
    return this.text;
  }
  async clear(): Promise<void> {
    this.text = '';
  }
}

let port: FakeClipboard;
let cleared: number;
let svc: ClipboardService;
let seconds: number;

beforeEach(() => {
  vi.useFakeTimers();
  port = new FakeClipboard();
  cleared = 0;
  seconds = 30;
  svc = new ClipboardService({ port, clearSeconds: () => seconds, onCleared: () => void cleared++ });
});
afterEach(() => vi.useRealTimers());

describe('ClipboardService', () => {
  it('copies sensitive text and clears it after the configured seconds', async () => {
    const r = await svc.copy('synthetic-secret');
    expect(r).toEqual({ ok: true, value: { clearsInSeconds: 30 } });
    expect(port.sensitiveFlag).toBe(true);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(port.text).toBe('synthetic-secret');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(port.text).toBe('');
    expect(cleared).toBe(1);
  });

  it('does not clear when the user copied something else meanwhile', async () => {
    await svc.copy('synthetic-secret');
    port.text = 'something the user copied elsewhere';
    await vi.advanceTimersByTimeAsync(31_000);
    expect(port.text).toBe('something the user copied elsewhere');
    expect(cleared).toBe(0);
  });

  it('a second copy restarts the timer for the new content', async () => {
    await svc.copy('first');
    await vi.advanceTimersByTimeAsync(20_000);
    await svc.copy('second');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(port.text).toBe('second');
    await vi.advanceTimersByTimeAsync(11_000);
    expect(port.text).toBe('');
  });

  it('clearIfOurs (lock path) clears early, only for unchanged content', async () => {
    await svc.copy('synthetic-secret');
    expect(await svc.clearIfOurs()).toBe(true);
    expect(port.text).toBe('');
    expect(await svc.clearIfOurs()).toBe(false); // nothing pending any more
  });

  it('non-sensitive copies are never scheduled for clearing', async () => {
    const r = await svc.copy('public text', { sensitive: false });
    expect(r).toEqual({ ok: true, value: { clearsInSeconds: 0 } });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(port.text).toBe('public text');
    expect(svc.hasPending).toBe(false);
  });

  it('honours a changed clearSeconds setting on the next copy', async () => {
    seconds = 5;
    const r = await svc.copy('x');
    expect(r).toEqual({ ok: true, value: { clearsInSeconds: 5 } });
    await vi.advanceTimersByTimeAsync(5_100);
    expect(port.text).toBe('');
  });

  it('manual clear acknowledges even when nothing is ours', async () => {
    expect(await svc.clear()).toEqual({ ok: true, value: { ok: true } });
  });
});
