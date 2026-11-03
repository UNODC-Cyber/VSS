/**
 * Security review F-10: a packaged build refuses remote-debugging / inspector switches. The decision function is
 * tested here; that index.ts runs it first (before the scheme, the instance lock and 'ready') is checked on the
 * source. The packaged exe itself is covered by tests/e2e/packaged.test.ts (VERIFY on a real build).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEBUG_REFUSED_MESSAGE, FORBIDDEN_SWITCHES, findDebugSwitch } from '../../src/main/bootstrap/debug-guard';

const none = () => false;
const exe = 'C:\\Program Files\\VSS\\VSS.exe';

describe('F-10 debug switch guard', () => {
  it('a normal start passes', () => {
    expect(findDebugSwitch([exe], none)).toBeNull();
    expect(findDebugSwitch([exe, 'C:\\data\\file.xlsx', '--some-other-flag'], none)).toBeNull();
  });

  it.each([
    ['--remote-debugging-port=9222'],
    ['--remote-debugging-port', '9222'],
    ['--remote-debugging-pipe'],
    ['--REMOTE-DEBUGGING-PORT=1'],
    ['-remote-debugging-port=1'],
    ['--remote-debugging-address=0.0.0.0'],
    ['--remote-allow-origins=*'],
    ['--inspect'],
    ['--inspect=9229'],
    ['--inspect-brk=0'],
    ['--inspect-port=0'],
    ['--debug=5858'],
    ['--js-flags=--expose-gc'],
    ['--auto-open-devtools-for-tabs'],
  ])('argv %s is refused', (...args) => {
    expect(findDebugSwitch([exe, ...args], none)).not.toBeNull();
  });

  it('every forbidden switch is refused when Chromium reports it (whatever argv looks like)', () => {
    for (const s of FORBIDDEN_SWITCHES) expect(findDebugSwitch([exe], (n) => n === s)).toBe(s);
  });

  it('a command line that cannot be inspected is refused', () => {
    expect(
      findDebugSwitch([exe], () => {
        throw new Error('boom');
      }),
    ).not.toBeNull();
  });

  it('the message names no switch and no path', () => {
    expect(DEBUG_REFUSED_MESSAGE).not.toMatch(/--|\\|\//);
  });

  it('index.ts runs the guard for packaged builds before anything else starts', () => {
    const src = readFileSync(resolve('src/main/index.ts'), 'utf8');
    const guard = src.indexOf('findDebugSwitch(process.argv');
    expect(guard).toBeGreaterThan(0);
    expect(src.slice(guard - 200, guard)).toContain('app.isPackaged');
    for (const later of ['registerAppScheme();', 'requestSingleInstanceLock', 'app.whenReady']) {
      expect(src.indexOf(later)).toBeGreaterThan(guard);
    }
    expect(src).toMatch(/app\.exit\(1\)/);
  });
});
