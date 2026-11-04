// Creates a synthetic vault in VSS_DATA_DIR (argv[2]) through the dev build (out/) so the packaged build can then
// be driven through the real native dialogs by drive-import.ps1. Synthetic credentials only.
// Usage: node tools/e2e-native/seed-vault.mjs <dataDir> [autoLockMinutes]
/* global window, document */
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';

const dataDir = process.argv[2];
const autoLock = Number(process.argv[3] ?? '15');
if (!dataDir) throw new Error('usage: seed-vault.mjs <dataDir> [autoLockMinutes]');
export const PW = 'correct horse battery staple 1';

const env = { ...process.env, VSS_DATA_DIR: dataDir };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const app = await electron.launch({ args: [resolve('.')], env });
const page = await app.firstWindow();
await page.waitForSelector('html[data-vault-state]:not([data-vault-state="booting"])', { state: 'attached' });
const call = (ns, m, a) => page.evaluate(([n, mm, aa]) => window.vss[n][mm](aa), [ns, m, a]);
const state = await page.evaluate(() => document.documentElement.dataset.vaultState);
if (state === 'no-vault' || state === 'create') {
  const r = await call('vault', 'create', { password: PW, displayName: 'Native dialog probe' });
  if (!r.ok) throw new Error(`create failed: ${r.error?.code}`);
} else {
  const r = await call('vault', 'unlock', { password: PW });
  if (!r.ok) throw new Error(`unlock failed: ${r.error?.code}`);
}
await page.waitForSelector('html[data-vault-state="unlocked"]', { state: 'attached' });
const s = await call('settings', 'get');
const u = await call('settings', 'update', {
  settings: { ...s.value, updateCheckEnabled: false, autoLockMinutes: autoLock },
  reauth: { password: PW },
});
if (!u.ok) throw new Error(`settings failed: ${u.error?.code}`);
await app.close();
console.log('seeded');
