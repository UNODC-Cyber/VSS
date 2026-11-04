import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createWindowStateKeeper,
  parseWindowState,
  readWindowState,
  resolveInitialWindow,
  serializeWindowState,
  WINDOW_STATE_FILE,
} from '../../../src/main/app/window-state';
import type { DisplayInfo, Rect, StateWindow, WindowState } from '../../../src/main/app/window-state';

const DEFAULTS = { width: 1280, height: 800 };
const MIN = { width: 960, height: 600 };
/** Primary 1920x1080 with a 40 px taskbar; second monitor to the right, 1600x900. */
const D1: DisplayInfo = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};
const D2: DisplayInfo = {
  id: 2,
  bounds: { x: 1920, y: 0, width: 1600, height: 900 },
  workArea: { x: 1920, y: 0, width: 1600, height: 900 },
};
const st = (bounds: Rect, o: Partial<WindowState> = {}): WindowState => ({
  bounds,
  maximized: false,
  displayId: 1,
  ...o,
});

describe('resolveInitialWindow', () => {
  it('centres the default size on the primary display when nothing is saved', () => {
    const r = resolveInitialWindow(null, [D1, D2], 1, DEFAULTS, MIN);
    expect(r).toEqual({ bounds: { x: 320, y: 120, width: 1280, height: 800 }, maximized: false });
  });

  it('restores a saved rectangle on a visible display unchanged', () => {
    const b = { x: 100, y: 50, width: 1100, height: 700 };
    expect(resolveInitialWindow(st(b), [D1, D2], 1, DEFAULTS, MIN).bounds).toEqual(b);
  });

  it('restores a window that was on the second display', () => {
    const b = { x: 2000, y: 40, width: 1000, height: 650 };
    expect(resolveInitialWindow(st(b, { displayId: 2 }), [D1, D2], 1, DEFAULTS, MIN).bounds).toEqual(b);
  });

  it('falls back to the primary display, centred, when the saved display is disconnected', () => {
    const b = { x: 2000, y: 40, width: 1000, height: 650 };
    const r = resolveInitialWindow(st(b, { displayId: 2 }), [D1], 1, DEFAULTS, MIN);
    expect(r.bounds).toEqual({ x: 460, y: 195, width: 1000, height: 650 });
  });

  it('falls back to centred when the rectangle is entirely off-screen', () => {
    const r = resolveInitialWindow(st({ x: 5000, y: 4000, width: 1000, height: 650 }), [D1], 1, DEFAULTS, MIN);
    expect(r.bounds.x).toBe(460);
    expect(r.bounds.y).toBe(195);
  });

  it('treats a sliver of overlap as off-screen', () => {
    const r = resolveInitialWindow(st({ x: 1900, y: 100, width: 1000, height: 650 }), [D1], 1, DEFAULTS, MIN);
    expect(r.bounds.x).toBe(460);
  });

  it('clamps to the work area (shifts in, shrinks to fit)', () => {
    const shifted = resolveInitialWindow(st({ x: 1200, y: 600, width: 1000, height: 650 }), [D1], 1, DEFAULTS, MIN);
    expect(shifted.bounds).toEqual({ x: 920, y: 390, width: 1000, height: 650 });
    const huge = resolveInitialWindow(st({ x: -50, y: -50, width: 5000, height: 4000 }), [D1], 1, DEFAULTS, MIN);
    expect(huge.bounds).toEqual({ x: 0, y: 0, width: 1920, height: 1040 });
  });

  it('enforces the minimum size', () => {
    const r = resolveInitialWindow(st({ x: 100, y: 100, width: 300, height: 200 }), [D1], 1, DEFAULTS, MIN);
    expect(r.bounds).toEqual({ x: 100, y: 100, width: 960, height: 600 });
  });

  it('keeps the maximised flag together with the last normal bounds', () => {
    const b = { x: 100, y: 50, width: 1100, height: 700 };
    const r = resolveInitialWindow(st(b, { maximized: true }), [D1], 1, DEFAULTS, MIN);
    expect(r).toEqual({ bounds: b, maximized: true });
  });

  it('works on a small display (min size shrinks to the work area)', () => {
    const small: DisplayInfo = {
      id: 3,
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      workArea: { x: 0, y: 0, width: 800, height: 560 },
    };
    const r = resolveInitialWindow(null, [small], 3, DEFAULTS, MIN);
    expect(r.bounds).toEqual({ x: 0, y: 0, width: 800, height: 560 });
  });

  it('uses the first display when the primary id is unknown', () => {
    expect(resolveInitialWindow(null, [D2], 99, DEFAULTS, MIN).bounds.x).toBe(1920 + 160);
  });
});

describe('parseWindowState', () => {
  const ok = serializeWindowState(st({ x: 1, y: 2, width: 1000, height: 700 }, { maximized: true }));
  it('round-trips', () => {
    expect(parseWindowState(ok)).toEqual(st({ x: 1, y: 2, width: 1000, height: 700 }, { maximized: true }));
  });
  it.each([
    '',
    'not json',
    '{',
    'null',
    '[]',
    '{"version":2,"bounds":{"x":0,"y":0,"width":1,"height":1}}',
    '{"version":1}',
    '{"version":1,"bounds":{"x":"a","y":0,"width":10,"height":10}}',
    '{"version":1,"bounds":{"x":0,"y":0,"width":0,"height":10}}',
    '{"version":1,"bounds":{"x":0,"y":0,"width":1e999,"height":10}}',
  ])('rejects %j', (text) => {
    expect(parseWindowState(text)).toBeNull();
  });
});

class FakeWindow implements StateWindow {
  normal: Rect = { x: 10, y: 20, width: 1000, height: 700 };
  maximized = false;
  destroyed = false;
  handlers = new Map<string, () => void>();
  getNormalBounds() {
    return this.normal;
  }
  isMaximized() {
    return this.maximized;
  }
  isDestroyed() {
    return this.destroyed;
  }
  unmaximize() {
    this.maximized = false;
  }
  setBounds(r: Rect) {
    this.normal = r;
  }
  on(event: string, fn: () => void) {
    this.handlers.set(event, fn);
  }
  emit(event: string) {
    this.handlers.get(event)?.();
  }
}

describe('window state keeper', () => {
  let dir: string;
  let file: string;
  let displays: DisplayInfo[];
  let timers: { fn: () => void; ms: number; id: number }[];
  let nextId: number;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vss-ws-'));
    file = join(dir, WINDOW_STATE_FILE);
    displays = [D1, D2];
    timers = [];
    nextId = 1;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const keeper = () =>
    createWindowStateKeeper({
      file,
      defaults: DEFAULTS,
      min: MIN,
      displays: () => ({ displays, primaryId: 1 }),
      debounceMs: 500,
      setTimer: (fn, ms) => {
        const id = nextId++;
        timers.push({ fn, ms, id });
        return id;
      },
      clearTimer: (t) => {
        timers = timers.filter((x) => x.id !== t);
      },
    });

  it('debounces move/resize into one write', () => {
    const k = keeper();
    const w = new FakeWindow();
    k.attach(w);
    w.emit('move');
    w.emit('resize');
    w.emit('resize');
    expect(existsSync(file)).toBe(false);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(500);
    timers[0]!.fn();
    expect(readWindowState(file)).toEqual(st(w.normal));
  });

  it('saves immediately on close and cancels the pending write', () => {
    const k = keeper();
    const w = new FakeWindow();
    k.attach(w);
    w.emit('move');
    w.normal = { x: 5, y: 6, width: 1100, height: 720 };
    w.emit('close');
    expect(timers).toHaveLength(0);
    expect(readWindowState(file)?.bounds).toEqual(w.normal);
  });

  it('keeps the last normal bounds while maximised and records the flag and display', () => {
    const k = keeper();
    const w = new FakeWindow();
    w.normal = { x: 2000, y: 30, width: 1000, height: 700 };
    w.maximized = true;
    k.attach(w);
    w.emit('maximize');
    timers[0]!.fn();
    expect(readWindowState(file)).toEqual({ bounds: w.normal, maximized: true, displayId: 2 });
  });

  it('does not write for a destroyed window', () => {
    const k = keeper();
    const w = new FakeWindow();
    k.attach(w);
    w.destroyed = true;
    w.emit('close');
    expect(existsSync(file)).toBe(false);
  });

  it('initial() reads the file and validates against the current displays', () => {
    writeFileSync(file, serializeWindowState(st({ x: 2000, y: 40, width: 1000, height: 650 }, { displayId: 2 })));
    expect(keeper().initial().bounds).toEqual({ x: 2000, y: 40, width: 1000, height: 650 });
    displays = [D1];
    expect(keeper().initial().bounds).toEqual({ x: 460, y: 195, width: 1000, height: 650 });
  });

  it('tolerates a corrupt file', () => {
    writeFileSync(file, '{"version":1,"bounds":');
    expect(keeper().initial()).toEqual({ bounds: { x: 320, y: 120, width: 1280, height: 800 }, maximized: false });
  });

  it('writes only geometry', () => {
    const k = keeper();
    k.attach(new FakeWindow());
    k.attach(new FakeWindow());
    const w = new FakeWindow();
    k.attach(w);
    w.emit('close');
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')) as object).sort()).toEqual([
      'bounds',
      'displayId',
      'maximized',
      'version',
    ]);
  });

  it('reset() deletes the file and re-centres an un-maximised window on the primary display', () => {
    const k = keeper();
    const w = new FakeWindow();
    w.maximized = true;
    k.attach(w);
    w.emit('close');
    expect(existsSync(file)).toBe(true);
    w.emit('move');
    k.reset();
    expect(existsSync(file)).toBe(false);
    expect(timers).toHaveLength(0);
    expect(w.maximized).toBe(false);
    expect(w.normal).toEqual({ x: 320, y: 120, width: 1280, height: 800 });
  });

  it('reset() without a window only deletes the file', () => {
    writeFileSync(file, 'x');
    keeper().reset();
    expect(existsSync(file)).toBe(false);
  });
});
