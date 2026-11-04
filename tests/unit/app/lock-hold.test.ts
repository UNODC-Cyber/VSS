import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LockController } from '../../../src/main/services/lock';
import type { LockReason, PowerEvents } from '../../../src/main/services/lock';

function harness(minutes = 1, maxHoldMs?: number) {
  const state = { unlocked: true };
  const locks: LockReason[] = [];
  const c = new LockController({
    autoLockMinutes: () => minutes,
    isUnlocked: () => state.unlocked,
    systemIdleSeconds: () => 0,
    performLock: (r) => {
      locks.push(r);
      state.unlocked = false;
    },
    emitWarning: () => undefined,
    ...(maxHoldMs !== undefined ? { maxHoldMs } : {}),
  });
  return { c, locks, state };
}

function deferred(): { p: Promise<string>; resolve: (v: string) => void; reject: (e: Error) => void } {
  let resolve!: (v: string) => void;
  let reject!: (e: Error) => void;
  const p = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { p, resolve, reject };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('LockController.holdWhile (open native dialog)', () => {
  it('defers the idle lock while the dialog is open and counts answering it as activity', async () => {
    const h = harness(1);
    h.c.arm();
    const d = deferred();
    const held = h.c.holdWhile(d.p);
    expect(h.c.held).toBe(true);
    vi.advanceTimersByTime(5 * 60_000);
    expect(h.locks).toEqual([]);
    d.resolve('picked');
    await expect(held).resolves.toBe('picked');
    expect(h.c.held).toBe(false);
    // answering the dialog was activity: the full idle period starts again
    vi.advanceTimersByTime(59_000);
    expect(h.locks).toEqual([]);
    vi.advanceTimersByTime(2_000);
    expect(h.locks).toEqual(['idle']);
  });

  it('locks once the hold exceeds the cap, even with the dialog still open', async () => {
    const h = harness(1, 10 * 60_000);
    h.c.arm();
    const d = deferred();
    void h.c.holdWhile(d.p);
    vi.advanceTimersByTime(10 * 60_000 - 2_000);
    expect(h.locks).toEqual([]);
    vi.advanceTimersByTime(3_000);
    expect(h.locks).toEqual(['idle']);
    d.resolve('late');
    await Promise.resolve();
    expect(h.locks).toEqual(['idle']);
  });

  it('a rejected dialog promise releases the hold and is passed through', async () => {
    const h = harness(1);
    h.c.arm();
    const d = deferred();
    const held = h.c.holdWhile(d.p);
    d.reject(new Error('boom'));
    await expect(held).rejects.toThrow('boom');
    expect(h.c.held).toBe(false);
  });

  it('never defers suspend or screen-lock', () => {
    const h = harness(15);
    const handlers = new Map<string, () => void>();
    const power: PowerEvents = {
      on: (e, fn) => handlers.set(e, fn),
      removeListener: () => undefined,
    };
    h.c.attach(power);
    h.c.arm();
    void h.c.holdWhile(new Promise<void>(() => undefined));
    handlers.get('suspend')!();
    expect(h.locks).toEqual(['suspend']);
  });

  it('overlapping holds release only when the last one ends', async () => {
    const h = harness(1);
    h.c.arm();
    const a = deferred();
    const b = deferred();
    void h.c.holdWhile(a.p);
    void h.c.holdWhile(b.p);
    a.resolve('a');
    await a.p;
    await Promise.resolve();
    expect(h.c.held).toBe(true);
    b.resolve('b');
    await b.p;
    await Promise.resolve();
    expect(h.c.held).toBe(false);
  });
});
