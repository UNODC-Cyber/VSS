import { describe, expect, it, vi } from 'vitest';
import { compactOptions, DialogGate, dialogParent } from '../../../src/main/app/dialog-gate';
import { FilesService, PathGrants } from '../../../src/main/services/files';
import type { FilesPort } from '../../../src/main/services/files';

const win = (o: Partial<{ destroyed: boolean; visible: boolean; minimized: boolean; throws: boolean }> = {}) => ({
  isDestroyed: () => {
    if (o.throws) throw new Error('Object has been destroyed');
    return o.destroyed ?? false;
  },
  isVisible: () => o.visible ?? true,
  isMinimized: () => o.minimized ?? false,
});

describe('DialogGate', () => {
  it('serialises: a call while a dialog is open answers "cancelled" without showing a second dialog', async () => {
    const gate = new DialogGate();
    let release!: () => void;
    const show = vi.fn(() => new Promise<string>((r) => (release = () => r('first'))));
    const a = gate.run(show, () => 'cancelled');
    const b = gate.run(show, () => 'cancelled');
    await expect(b).resolves.toBe('cancelled');
    expect(show).toHaveBeenCalledTimes(1);
    expect(gate.isOpen).toBe(true);
    release();
    await expect(a).resolves.toBe('first');
    expect(gate.isOpen).toBe(false);
    // the next call is admitted again
    await expect(
      gate.run(
        async () => 'second',
        () => 'cancelled',
      ),
    ).resolves.toBe('second');
  });

  it('releases the gate when the dialog throws', async () => {
    const gate = new DialogGate();
    await expect(
      gate.run(
        () => Promise.reject(new TypeError('Error processing argument at index 1, conversion failure')),
        () => 'x',
      ),
    ).rejects.toThrow(TypeError);
    expect(gate.isOpen).toBe(false);
  });

  it('whenIdle waits for the open dialog; onChange reports open/close', async () => {
    const seen: boolean[] = [];
    const gate = new DialogGate((o) => seen.push(o));
    await gate.whenIdle(); // idle: resolves at once
    let release!: () => void;
    const run = gate.run(
      () => new Promise<void>((r) => (release = r)),
      () => undefined,
    );
    let idle = false;
    void gate.whenIdle().then(() => (idle = true));
    await Promise.resolve();
    expect(idle).toBe(false);
    release();
    await run;
    await Promise.resolve();
    expect(idle).toBe(true);
    expect(seen).toEqual([true, false]);
  });
});

describe('dialogParent', () => {
  it('parents only on a live, visible, non-minimised window', () => {
    const ok = win();
    expect(dialogParent(ok)).toBe(ok);
    expect(dialogParent(null)).toBeNull();
    expect(dialogParent(win({ destroyed: true }))).toBeNull();
    expect(dialogParent(win({ visible: false }))).toBeNull();
    expect(dialogParent(win({ minimized: true }))).toBeNull();
    expect(dialogParent(win({ throws: true }))).toBeNull();
  });
});

describe('compactOptions', () => {
  it('drops undefined members and empty filters, keeps everything else', () => {
    expect(
      compactOptions({ title: 'Open', defaultPath: undefined, filters: [], properties: ['openFile'] }),
    ).toStrictEqual({ title: 'Open', properties: ['openFile'] });
    const filters = [{ name: 'Excel workbook', extensions: ['xlsx'] }];
    expect(compactOptions({ title: undefined, filters })).toStrictEqual({ filters });
    expect(Object.keys(compactOptions({ a: undefined, b: null, c: 0 }))).toEqual(['b', 'c']);
  });
});

describe('FilesService dialog paths (lane J)', () => {
  const port = (over: Partial<FilesPort>): FilesPort => ({
    showOpenDialog: async () => ({ canceled: false, filePaths: ['C:\\synthetic\\req.xlsx'] }),
    showSaveDialog: async () => ({ canceled: false, filePath: 'C:\\synthetic\\out.xlsx' }),
    showItemInFolder: () => undefined,
    ...over,
  });
  const storedFiles = () => {
    throw new Error('locked');
  };

  it('a throwing dialog becomes an INTERNAL Result, logged without message', async () => {
    const kinds: string[] = [];
    const svc = new FilesService({
      port: port({
        showOpenDialog: () => Promise.reject(new TypeError('conversion failure C:\\secret')),
        showSaveDialog: () => {
          throw new TypeError('sync throw');
        },
      }),
      grants: new PathGrants(),
      storedFiles,
      onDialogError: (k) => kinds.push(k),
    });
    const r = await svc.pickOpen({ kind: 'request-xlsx' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('INTERNAL');
      expect(r.error.message).not.toContain('secret');
    }
    const s = await svc.pickSave({ kind: 'request-xlsx', suggestedName: 'x.xlsx' });
    expect(s.ok).toBe(false);
    expect(kinds).toEqual(['open', 'save']);
  });

  it('a lock during the dialog discards the choice (no grant issued after the lock)', async () => {
    const grants = new PathGrants();
    const svc = new FilesService({
      port: port({
        showOpenDialog: async () => {
          grants.clear(); // the vault locked while the dialog was open
          return { canceled: false, filePaths: ['C:\\synthetic\\req.xlsx'] };
        },
      }),
      grants,
      storedFiles,
    });
    const r = await svc.pickOpen({ kind: 'request-xlsx' });
    expect(r).toEqual({ ok: true, value: { path: null, displayPath: null } });
    expect(grants.size).toBe(0);
  });

  it('wraps every dialog in holdWhile', async () => {
    const held: Promise<unknown>[] = [];
    const svc = new FilesService({
      port: port({}),
      grants: new PathGrants(),
      storedFiles,
      holdWhile: (p) => {
        held.push(p);
        return p;
      },
    });
    await svc.pickOpen({ kind: 'request-xlsx' });
    await svc.pickSave({ kind: 'request-xlsx', suggestedName: 'x.xlsx' });
    expect(held).toHaveLength(2);
  });
});
