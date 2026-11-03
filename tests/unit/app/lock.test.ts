import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LockController } from '../../../src/main/services/lock';
import type { LockReason, PowerEvents } from '../../../src/main/services/lock';

interface Harness {
  c: LockController;
  locks: LockReason[];
  warnings: number[];
  state: { minutes: number; unlocked: boolean; sysIdle: number };
}

function harness(minutes = 10): Harness {
  const state = { minutes, unlocked: true, sysIdle: 0 };
  const locks: LockReason[] = [];
  const warnings: number[] = [];
  const c = new LockController({
    autoLockMinutes: () => state.minutes,
    isUnlocked: () => state.unlocked,
    systemIdleSeconds: () => state.sysIdle,
    performLock: (r) => {
      locks.push(r);
      state.unlocked = false;
    },
    emitWarning: (s) => warnings.push(s),
  });
  return { c, locks, warnings, state };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('LockController', () => {
  it('locks after N idle minutes and not before', () => {
    const h = harness(10);
    h.c.arm();
    vi.advanceTimersByTime(9 * 60_000 + 59_000);
    expect(h.locks).toEqual([]);
    vi.advanceTimersByTime(2_000);
    expect(h.locks).toEqual(['idle']);
    expect(h.c.armed).toBe(false);
  });

  it('warns 30 s before locking, counting down', () => {
    const h = harness(1);
    h.c.arm();
    vi.advanceTimersByTime(29_000);
    expect(h.warnings).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(h.warnings[0]).toBe(30);
    vi.advanceTimersByTime(5_000);
    expect(h.warnings.at(-1)).toBe(25);
  });

  it('renderer activity pings reset the idle clock', () => {
    const h = harness(1);
    h.c.arm();
    vi.advanceTimersByTime(50_000);
    h.c.ping();
    vi.advanceTimersByTime(50_000);
    expect(h.locks).toEqual([]);
    vi.advanceTimersByTime(11_000);
    expect(h.locks).toEqual(['idle']);
  });

  it('OS idle time can lock earlier than the ping age (synthetic pings do not keep the vault open)', () => {
    const h = harness(1);
    h.c.arm();
    h.state.sysIdle = 61;
    vi.advanceTimersByTime(1_000);
    expect(h.locks).toEqual(['idle']);
  });

  it('a settings change to the timeout applies on the next tick', () => {
    const h = harness(10);
    h.c.arm();
    vi.advanceTimersByTime(120_000);
    h.state.minutes = 1;
    vi.advanceTimersByTime(1_000);
    expect(h.locks).toEqual(['idle']);
  });

  it('suspend and lock-screen lock immediately with their own reason', () => {
    const handlers = new Map<string, () => void>();
    const power: PowerEvents = {
      on: (e, l) => void handlers.set(e, l),
      removeListener: (e) => void handlers.delete(e),
    };
    const a = harness();
    a.c.arm();
    a.c.attach(power);
    handlers.get('suspend')!();
    expect(a.locks).toEqual(['suspend']);

    const b = harness();
    b.c.arm();
    b.c.attach(power);
    handlers.get('lock-screen')!();
    expect(b.locks).toEqual(['screen-lock']);
  });

  it('manual lock is idempotent while running and disarms the timer', async () => {
    const h = harness();
    h.c.arm();
    const p1 = h.c.lock('manual');
    const p2 = h.c.lock('manual');
    await Promise.all([p1, p2]);
    expect(h.locks).toEqual(['manual']);
    expect(h.c.armed).toBe(false);
  });

  it('a throwing performLock never rejects and does not wedge the controller', async () => {
    let n = 0;
    const c = new LockController({
      autoLockMinutes: () => 1,
      isUnlocked: () => true,
      systemIdleSeconds: () => 0,
      performLock: () => {
        n++;
        throw new Error('boom');
      },
      emitWarning: () => undefined,
    });
    await expect(c.lock('error')).resolves.toBeUndefined();
    await c.lock('error');
    expect(n).toBe(2);
  });

  it('stops ticking once the vault is locked by someone else; remainingSeconds is null when disarmed', () => {
    const h = harness(1);
    expect(h.c.remainingSeconds()).toBeNull();
    h.c.arm();
    expect(h.c.remainingSeconds()).toBe(60);
    h.state.unlocked = false;
    vi.advanceTimersByTime(1_000);
    expect(h.c.armed).toBe(false);
    expect(h.locks).toEqual([]);
  });
});
