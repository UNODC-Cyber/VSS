/**
 * With update checks disabled the whole create-vault / unlock / lock cycle must make ZERO NetGate calls (no
 * enabling, no fetching) and ZERO updater calls. With checks enabled an unlock triggers exactly one gated check.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/domain/types';
import { composeApp } from '../../src/main/app/compose';
import { _resetAllLockoutsForTests } from '../../src/main/crypto/lockout';
import type { Db } from '../../src/main/db/open';
import { settingsLastCheckStore } from '../../src/main/services/updates-wiring';
import type { UpdateServiceFactory } from '../../src/main/services/updates-wiring';
import { UpdateService } from '../../src/main/update/service';
import type { NetPort, UpdaterPort } from '../../src/main/update/service';
import { UPDATE_KEYS } from '../../src/main/update/keys';
import { FAST_KDF } from '../unit/crypto/helpers';
import { makePorts, PW } from '../unit/app/helpers';
import type { IpcMainInvokeEvent } from 'electron';

vi.setConfig({ testTimeout: 60_000 });

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  _resetAllLockoutsForTests();
  const root = mkdtempSync(join(tmpdir(), 'vss-netgate-'));
  dirs.push(root);
  const calls: string[] = [];
  const net: NetPort = {
    setEnabled: (e) => void calls.push(`net.setEnabled(${e})`),
    fetchBytes: async (u) => {
      calls.push(`net.fetchBytes(${u})`);
      throw new Error('no network in tests');
    },
  };
  const updater: UpdaterPort = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowDowngrade: true,
    allowPrerelease: true,
    checkForUpdates: async () => {
      calls.push('updater.check');
      return { updateInfo: { version: '0.0.1', files: [] } };
    },
    downloadUpdate: async () => {
      calls.push('updater.download');
      return [];
    },
    quitAndInstall: () => void calls.push('updater.install'),
    onDownloadProgress: () => undefined,
  };
  let getDb: () => Db | null = () => null;
  const factory: UpdateServiceFactory = async (deps) =>
    new UpdateService({
      ...deps,
      currentVersion: '0.2.0-alpha.1',
      updater,
      net,
      fs: { hashFile: async () => ({ sha512Hex: '', size: 0 }), remove: async () => undefined },
      clock: { now: () => Date.now() },
      keys: UPDATE_KEYS,
      store: settingsLastCheckStore(() => getDb()),
    });
  const { ports } = makePorts();
  const compose = async () => {
    const app = await composeApp({
      paths: {
        dataDir: join(root, 'vault'),
        sessionDir: join(root, 's'),
        migrationBackupDir: join(root, 'm'),
        overridden: true,
      },
      ports,
      updates: factory,
      kdf: FAST_KDF,
      backupKdf: FAST_KDF,
    });
    getDb = () => (app.db.isOpen ? app.db.current() : null);
    return app;
  };
  return { calls, compose };
}

const call = async (
  app: Awaited<ReturnType<ReturnType<typeof setup>['compose']>>,
  ns: string,
  m: string,
  arg?: unknown,
) =>
  (await (app.handlers as Record<string, Record<string, (a: unknown, e: IpcMainInvokeEvent) => Promise<unknown>>>)[ns]![
    m
  ]!(arg, {} as IpcMainInvokeEvent)) as {
    ok: boolean;
    value?: unknown;
  };

describe('NetGate stays closed unless updates are enabled', () => {
  it('records zero calls across create / unlock / lock cycles when updateCheckEnabled=false', async () => {
    const { calls, compose } = setup();
    const app = await compose();
    expect((await call(app, 'vault', 'create', { directory: 'x', password: PW, displayName: 'x' })).ok).toBe(true);
    expect(calls).toEqual([]); // a brand-new vault never phones home
    const settings = { ...structuredClone(DEFAULT_SETTINGS), updateCheckEnabled: false };
    expect((await call(app, 'settings', 'update', { settings, reauth: { password: PW } })).ok).toBe(true);
    for (let i = 0; i < 3; i++) {
      await call(app, 'vault', 'lock');
      expect((await call(app, 'vault', 'unlock', { password: PW })).ok).toBe(true);
      await new Promise((r) => setTimeout(r, 50)); // let the fire-and-forget onUnlocked settle
    }
    await call(app, 'vault', 'lock');
    await call(app, 'updates', 'check'); // even an explicit check is refused while disabled
    expect(calls).toEqual([]);
    app.lock.dispose();
  });

  it('with updates enabled, an unlock makes exactly one gated check, then respects the 24 h interval', async () => {
    const { calls, compose } = setup();
    const app = await compose();
    await call(app, 'vault', 'create', { directory: 'x', password: PW, displayName: 'x' });
    expect(calls).toEqual([]);
    await call(app, 'vault', 'lock');
    await call(app, 'vault', 'unlock', { password: PW });
    await vi.waitFor(() => expect(calls).toContain('updater.check'));
    expect(calls).toEqual(['net.setEnabled(true)', 'updater.check', 'net.setEnabled(false)']);
    calls.length = 0;
    await call(app, 'vault', 'lock');
    await call(app, 'vault', 'unlock', { password: PW });
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toEqual([]); // last check persisted in the encrypted settings table
    app.vault.forceLock();
    app.lock.dispose();
  });
});
