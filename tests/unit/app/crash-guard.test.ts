import { describe, expect, it } from 'vitest';
import {
  CRASH_TEXT,
  faultCode,
  faultFrames,
  installCrashGuard,
  REPEAT_WINDOW_MS,
} from '../../../src/main/bootstrap/crash-guard';
import type { ChildGoneDetails, CrashGuardDeps } from '../../../src/main/bootstrap/crash-guard';
import { checkedProfilePath } from '../../../src/main/bootstrap/profile-path';
import { createLogger, LOG_FIELDS } from '../../../src/main/app/logger';

const SECRET = 'Placeholder Person C:\\Users\\someone\\Desktop\\req.xlsx';

function harness(opts: { ready?: boolean; choice?: 'continue' | 'quit' } = {}) {
  const lines: string[] = [];
  const procHandlers = new Map<string, (e: unknown) => void>();
  let childHandler: ((d: ChildGoneDetails) => void) | null = null;
  const calls = { lock: 0, dialog: 0, startupBox: 0, quit: 0, exit: [] as number[], recovered: [] as string[] };
  let t = 1_000_000;
  const deps: CrashGuardDeps = {
    onProcess: (e, fn) => procHandlers.set(e, fn),
    onChildGone: (fn) => (childHandler = fn),
    log: createLogger({ sink: { write: (l) => lines.push(l) }, level: 'debug' }),
    isReady: () => opts.ready ?? true,
    lock: () => {
      calls.lock++;
    },
    emitRecovered: (code) => calls.recovered.push(code),
    showDialog: async (text) => {
      calls.dialog++;
      expect(text).toBe(CRASH_TEXT);
      return opts.choice ?? 'continue';
    },
    showStartupError: () => {
      calls.startupBox++;
    },
    quit: () => {
      calls.quit++;
    },
    exit: (c) => calls.exit.push(c),
    now: () => t,
  };
  const guard = installCrashGuard(deps);
  return {
    guard,
    lines,
    calls,
    fire: (event: 'uncaughtException' | 'unhandledRejection', e: unknown) => procHandlers.get(event)!(e),
    child: (d: ChildGoneDetails) => childHandler!(d),
    advance: (ms: number) => (t += ms),
    flush: () => new Promise((r) => setTimeout(r, 0)),
  };
}

describe('crash guard', () => {
  it('registers both process handlers (so Electron never shows its raw error box)', () => {
    const h = harness();
    expect(() => h.fire('uncaughtException', new Error('x'))).not.toThrow();
    expect(() => h.fire('unhandledRejection', new Error('x'))).not.toThrow();
  });

  it('logs only allowlisted fields and never the message, locks, emits and shows the dialog once', async () => {
    const h = harness();
    h.fire('uncaughtException', new TypeError(`Error processing argument at index 1, ${SECRET}`));
    await h.flush();
    expect(h.calls.lock).toBe(1);
    expect(h.calls.dialog).toBe(1);
    expect(h.calls.recovered).toEqual(['TypeError']);
    expect(h.calls.quit).toBe(0);
    expect(h.lines).toHaveLength(1);
    const line = JSON.parse(h.lines[0]!) as Record<string, unknown>;
    expect(line).toMatchObject({ level: 'error', event: 'app.fault', kind: 'uncaught', code: 'TypeError' });
    for (const k of Object.keys(line)) expect(['t', 'level', 'event', ...LOG_FIELDS]).toContain(k);
    expect(h.lines[0]).not.toContain('Placeholder');
    expect(h.lines[0]).not.toContain('conversion');
    expect(h.lines[0]).not.toContain('Desktop');
  });

  it('"Quit" in the dialog quits', async () => {
    const h = harness({ choice: 'quit' });
    h.fire('unhandledRejection', Object.assign(new Error(SECRET), { code: 'ERR_SYNTHETIC' }));
    await h.flush();
    expect(h.calls.quit).toBe(1);
    expect(h.lines[0]).toContain('"code":"ERR_SYNTHETIC"');
    expect(h.lines[0]).toContain('"kind":"rejection"');
  });

  it('a second fault within 5 s quits without a second dialog', async () => {
    const h = harness();
    h.fire('uncaughtException', new Error('a'));
    await h.flush();
    h.advance(REPEAT_WINDOW_MS - 1);
    h.fire('uncaughtException', new Error('b'));
    await h.flush();
    expect(h.calls.dialog).toBe(1);
    expect(h.calls.quit).toBe(1);
    expect(h.calls.lock).toBe(2);
  });

  it('a fault after the repeat window shows the dialog again', async () => {
    const h = harness();
    h.fire('uncaughtException', new Error('a'));
    await h.flush();
    h.advance(REPEAT_WINDOW_MS + 1);
    h.fire('uncaughtException', new Error('b'));
    await h.flush();
    expect(h.calls.dialog).toBe(2);
    expect(h.calls.quit).toBe(0);
  });

  it('before ready: plain friendly error box and exit(1), no message box', async () => {
    const h = harness({ ready: false });
    h.fire('uncaughtException', new TypeError(SECRET));
    await h.flush();
    expect(h.calls.startupBox).toBe(1);
    expect(h.calls.dialog).toBe(0);
    expect(h.calls.exit).toEqual([1]);
    expect(h.lines.join('\n')).not.toContain('Placeholder');
  });

  it('child-process-gone: crashes are faults, clean exits are not', async () => {
    const h = harness();
    h.child({ type: 'Utility', reason: 'clean-exit' });
    h.child({ type: 'GPU', reason: 'killed' });
    await h.flush();
    expect(h.calls.lock).toBe(0);
    h.child({ type: 'GPU', reason: 'crashed' });
    await h.flush();
    expect(h.calls.lock).toBe(1);
    expect(h.lines[0]).toContain('"kind":"child"');
    expect(h.lines[0]).toContain('"code":"crashed"');
  });

  it('logs where it was thrown (file base name:line:col), never the message, a directory or a function name', async () => {
    const h = harness();
    const e = new TypeError('Error processing argument at index 1, conversion failure Placeholder Person');
    e.stack = [
      'TypeError: Error processing argument at index 1, conversion failure Placeholder Person',
      '    at App.setPath (node:electron/js2c/browser_init:2:1234)',
      '    at secretFunctionName (C:\\Users\\someone\\Desktop\\Placeholder\\resources\\app.asar\\out\\main\\index.js:15639:5)',
      '    at C:\\Users\\someone\\app\\out\\main\\index.js:15700:3',
      '    at more (file:///C:/x/y.js:1:1)',
    ].join('\n');
    h.fire('uncaughtException', e);
    await h.flush();
    const line = JSON.parse(h.lines[0]!) as Record<string, unknown>;
    expect(line['at']).toBe('browser_init:2:1234 < index.js:15639:5 < index.js:15700:3');
    expect(h.lines[0]).not.toMatch(/Placeholder|someone|Desktop|secretFunctionName|conversion/);
  });

  it('faultFrames ignores message lines that look like frames and non-errors', () => {
    const e = new Error('x');
    e.stack = 'Error: at C:\\Users\\someone\\x.js:1:1\n    at f (C:\\a\\b.js:3:4)';
    expect(faultFrames(e)).toBe('b.js:3:4');
    expect(faultFrames('string')).toBe('');
    expect(faultFrames({ stack: 42 })).toBe('');
  });

  it('faultCode is a fixed classification', () => {
    expect(faultCode(new TypeError('x'))).toBe('TypeError');
    expect(faultCode(Object.assign(new Error('x'), { code: 'EPERM' }))).toBe('EPERM');
    expect(faultCode(Object.assign(new Error('x'), { code: 'not a code' }))).toBe('Error');
    expect(faultCode({ name: SECRET })).toBe('OBJECT');
    expect(faultCode(SECRET)).toBe('STRING');
    expect(faultCode(undefined)).toBe('EMPTY');
    expect(faultCode(42)).toBe('PRIMITIVE');
  });
});

describe('checkedProfilePath (owner: conversion failure at app.setPath)', () => {
  it('accepts absolute string paths', () => {
    expect(checkedProfilePath('C:\\synthetic\\VSS\\session')).toBe('C:\\synthetic\\VSS\\session');
  });
  it.each([
    ['undefined', undefined],
    ['number', 5],
    ['object', {}],
    ['empty', ''],
    ['NUL inside', 'C:\\synthetic\\a\u0000b'],
    ['relative', 'relative\\session'],
  ])('rejects %s with a coded error', (_n, v) => {
    expect(() => checkedProfilePath(v)).toThrow(expect.objectContaining({ code: 'PROFILE_PATH_INVALID' }));
  });
});
