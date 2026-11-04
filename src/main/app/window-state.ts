/**
 * R16 (docs/PLAN-ALPHA.md section 18): remember the main window's size, position, maximised state and display.
 *
 * The state is a small plain JSON file (`window-state.json`) in the session directory, NOT in the vault, so the
 * lock screen can open where the user left it. It holds geometry only, never user data. Everything here is
 * Electron-free (displays and the window are injected) so it is unit-testable with a fake display list.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Size {
  width: number;
  height: number;
}
export interface DisplayInfo {
  id: number;
  bounds: Rect;
  workArea: Rect;
}
export interface WindowState {
  /** Last NORMAL (not maximised, not full-screen) bounds. */
  bounds: Rect;
  maximized: boolean;
  /** Id of the display the window was on; only used to detect a disconnected monitor. */
  displayId: number | null;
}
export interface InitialWindow {
  bounds: Rect;
  maximized: boolean;
}

export const WINDOW_STATE_FILE = 'window-state.json';
const FILE_VERSION = 1;
/** Part of the window that must stay on a display for the saved position to be accepted. */
const MIN_VISIBLE = { width: 120, height: 60 };
const MAX_COORD = 100_000;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < MAX_COORD;

/** Parses a file body; anything unexpected yields null (a corrupt file is reset silently). */
export function parseWindowState(text: string): WindowState | null {
  try {
    const o = JSON.parse(text) as Record<string, unknown> | null;
    if (!o || typeof o !== 'object' || o['version'] !== FILE_VERSION) return null;
    const b = o['bounds'] as Record<string, unknown> | null;
    if (!b || typeof b !== 'object') return null;
    const { x, y, width, height } = b;
    if (!isNum(x) || !isNum(y) || !isNum(width) || !isNum(height) || width < 1 || height < 1) return null;
    return {
      bounds: { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) },
      maximized: o['maximized'] === true,
      displayId: isNum(o['displayId']) ? o['displayId'] : null,
    };
  } catch {
    return null;
  }
}

export function serializeWindowState(s: WindowState): string {
  return JSON.stringify({ version: FILE_VERSION, bounds: s.bounds, maximized: s.maximized, displayId: s.displayId });
}

export function readWindowState(file: string): WindowState | null {
  try {
    return parseWindowState(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Write via a temp file so a crash never leaves half a file. Failures are ignored (geometry is not worth a crash). */
export function writeWindowState(file: string, s: WindowState): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, serializeWindowState(s), 'utf8');
    renameSync(tmp, file);
  } catch {
    // ignore
  }
}

function overlap(a: Rect, b: Rect): Rect | null {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  return x2 > x1 && y2 > y1 ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : null;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** A rectangle of (at most) `size`, never below `min`, that fits the work area, centred in it. */
export function centredIn(area: Rect, size: Size, min: Size): Rect {
  const width = Math.min(Math.max(size.width, min.width), area.width);
  const height = Math.min(Math.max(size.height, min.height), area.height);
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function primaryOf(displays: readonly DisplayInfo[], primaryId: number): DisplayInfo | undefined {
  return displays.find((d) => d.id === primaryId) ?? displays[0];
}

/**
 * Decides where the window opens. Off-screen, disconnected-display or missing state -> centred on the primary
 * display at the saved (or default) size; otherwise the saved rectangle clamped to the work area of the display
 * it overlaps most. Size is never below `min`.
 */
export function resolveInitialWindow(
  saved: WindowState | null,
  displays: readonly DisplayInfo[],
  primaryId: number,
  defaults: Size,
  min: Size,
): InitialWindow {
  const primary = primaryOf(displays, primaryId);
  if (!primary) {
    // No display information at all (should not happen): let the OS place it.
    return { bounds: { x: 0, y: 0, width: defaults.width, height: defaults.height }, maximized: false };
  }
  if (!saved) return { bounds: centredIn(primary.workArea, defaults, min), maximized: false };

  const size: Size = { width: saved.bounds.width, height: saved.bounds.height };
  const wasOnGone = saved.displayId !== null && !displays.some((d) => d.id === saved.displayId);
  let best: DisplayInfo | null = null;
  let bestArea = 0;
  for (const d of displays) {
    const o = overlap(saved.bounds, d.workArea);
    if (!o || o.width < Math.min(MIN_VISIBLE.width, saved.bounds.width) || o.height < MIN_VISIBLE.height) continue;
    if (o.width * o.height > bestArea) {
      best = d;
      bestArea = o.width * o.height;
    }
  }
  if (wasOnGone || !best) {
    return { bounds: centredIn(primary.workArea, size, min), maximized: saved.maximized };
  }
  const area = best.workArea;
  const width = Math.min(Math.max(size.width, min.width), area.width);
  const height = Math.min(Math.max(size.height, min.height), area.height);
  return {
    bounds: {
      x: clamp(saved.bounds.x, area.x, area.x + area.width - width),
      y: clamp(saved.bounds.y, area.y, area.y + area.height - height),
      width,
      height,
    },
    maximized: saved.maximized,
  };
}

/** The subset of BrowserWindow the keeper uses (a fake in tests). */
export interface StateWindow {
  getNormalBounds(): Rect;
  isMaximized(): boolean;
  isDestroyed(): boolean;
  unmaximize(): void;
  setBounds(r: Rect): void;
  on(event: 'resize' | 'move' | 'maximize' | 'unmaximize' | 'close', listener: () => void): unknown;
}

export interface WindowStateOptions {
  file: string;
  defaults: Size;
  min: Size;
  /** Called lazily (after `app.ready`): the current displays and the primary display's id. */
  displays: () => { displays: DisplayInfo[]; primaryId: number };
  /** Debounce for move/resize writes (ms). Default 500. */
  debounceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export interface WindowStateKeeper {
  /** Where to create the window (reads the file, validates against the current displays). */
  initial(): InitialWindow;
  /** Start tracking `win` (move, resize, maximise; flushes on close). */
  attach(win: StateWindow): void;
  /** Settings -> General "Reset window position": forget the saved state and re-centre the open window. */
  reset(): void;
}

export function createWindowStateKeeper(o: WindowStateOptions): WindowStateKeeper {
  const debounceMs = o.debounceMs ?? 500;
  const setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let current: StateWindow | null = null;
  let timer: unknown = null;

  const snapshot = (win: StateWindow): WindowState | null => {
    if (win.isDestroyed()) return null;
    const maximized = win.isMaximized();
    // getNormalBounds() is the restored rectangle even while maximised / full-screen / minimised.
    const bounds = win.getNormalBounds();
    const { displays, primaryId } = o.displays();
    let displayId: number | null = primaryOf(displays, primaryId)?.id ?? null;
    let best = 0;
    for (const d of displays) {
      const ov = overlap(bounds, d.bounds);
      const area = ov ? ov.width * ov.height : 0;
      if (area > best) {
        best = area;
        displayId = d.id;
      }
    }
    return { bounds, maximized, displayId };
  };

  const save = (): void => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (!current) return;
    const s = snapshot(current);
    if (s) writeWindowState(o.file, s);
  };
  const schedule = (): void => {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(save, debounceMs);
  };

  return {
    initial() {
      const { displays, primaryId } = o.displays();
      return resolveInitialWindow(readWindowState(o.file), displays, primaryId, o.defaults, o.min);
    },
    attach(win) {
      current = win;
      win.on('resize', schedule);
      win.on('move', schedule);
      win.on('maximize', schedule);
      win.on('unmaximize', schedule);
      win.on('close', save);
    },
    reset() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      try {
        rmSync(o.file, { force: true });
      } catch {
        // ignore
      }
      const win = current;
      if (!win || win.isDestroyed()) return;
      if (win.isMaximized()) win.unmaximize();
      const { displays, primaryId } = o.displays();
      const primary = primaryOf(displays, primaryId);
      if (primary) win.setBounds(centredIn(primary.workArea, o.defaults, o.min));
    },
  };
}
