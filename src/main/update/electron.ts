/**
 * Production wiring for UpdateService (Electron main process, after app ready). Not unit-tested: it only adapts
 * electron-updater, NetGate and node:fs to the ports in ./service.ts.
 *
 * Integrator (main/index.ts): `const updates = await createUpdateService({ isCheckEnabled, emit, store })`, pass
 * `updates.handlers()` as the `updates` namespace to registerIpc, call `updates.onUnlocked()` after each unlock.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { app } from 'electron';
import { netGate } from '../net/NetGate';
import { UPDATE_KEYS } from './keys';
import { UpdateService } from './service';
import type { FsPort, UpdateServiceDeps, UpdaterPort } from './service';

export const UPDATE_OWNER = 'UNODC-Cyber';
export const UPDATE_REPO = 'VSS';

export const nodeFs: FsPort = {
  async hashFile(path) {
    const h = createHash('sha512');
    let size = 0;
    for await (const chunk of createReadStream(path)) {
      const b = chunk as Buffer;
      size += b.length;
      h.update(b);
    }
    return { sha512Hex: h.digest('hex'), size };
  },
  async remove(path) {
    await rm(path, { force: true });
  },
};

export async function createUpdateService(
  deps: Pick<UpdateServiceDeps, 'isCheckEnabled' | 'emit' | 'store' | 'allowPrerelease'>,
): Promise<UpdateService> {
  const au = await netGate.loadAutoUpdater();
  au.setFeedURL({ provider: 'github', owner: UPDATE_OWNER, repo: UPDATE_REPO, releaseType: 'release' });
  au.disableWebInstaller = true;
  au.disableDifferentialDownload = true;
  au.forceDevUpdateConfig = false;
  const updater: UpdaterPort = {
    get autoDownload() {
      return au.autoDownload;
    },
    set autoDownload(v) {
      au.autoDownload = v;
    },
    get autoInstallOnAppQuit() {
      return au.autoInstallOnAppQuit;
    },
    set autoInstallOnAppQuit(v) {
      au.autoInstallOnAppQuit = v;
    },
    get allowDowngrade() {
      return au.allowDowngrade;
    },
    set allowDowngrade(v) {
      au.allowDowngrade = v;
    },
    get allowPrerelease() {
      return au.allowPrerelease;
    },
    set allowPrerelease(v) {
      au.allowPrerelease = v;
    },
    checkForUpdates: async () => {
      const r = await au.checkForUpdates();
      return r ? { updateInfo: r.updateInfo } : null;
    },
    downloadUpdate: () => au.downloadUpdate(),
    quitAndInstall: (silent, forceRun) => au.quitAndInstall(silent, forceRun),
    onDownloadProgress: (listener) => {
      au.on('download-progress', (p) => listener({ transferred: p.transferred, total: p.total }));
    },
  };
  return new UpdateService({
    ...deps,
    currentVersion: app.getVersion(),
    updater,
    net: netGate,
    fs: nodeFs,
    clock: { now: () => Date.now() },
    keys: UPDATE_KEYS,
    owner: UPDATE_OWNER,
    repo: UPDATE_REPO,
  });
}
