/* global window */
// Manual acceptance probe (lane J, needs a desktop; run after npm run build): usage node tools/e2e-native/forced-fault.mjs
// Acceptance probe (lane J): forced uncaughtException in a dev build -> friendly dialog, vault locked, log has no message.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

const root = mkdtempSync(join(tmpdir(), 'vss-j2-fault-'));
const env = { ...process.env, VSS_DATA_DIR: join(root, 'vault') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const app = await electron.launch({ args: [process.argv[2] ?? '.'], env });
const stderr = [];
app.process().stderr.on('data', (d) => stderr.push(String(d)));
const page = await app.firstWindow();
await page.waitForSelector('html[data-vault-state]:not([data-vault-state="booting"])', { state: 'attached' });
const r = await page.evaluate(() =>
  window.vss.vault.create({ password: 'correct horse battery staple 1', displayName: 'x' }),
);
if (!r.ok) throw new Error('create failed');
await page.waitForSelector('html[data-vault-state="unlocked"]', { state: 'attached' });
await app.evaluate(({ dialog }) => {
  globalThis.__boxes = [];
  dialog.showMessageBox = async (...a) => {
    const o = a.length > 1 ? a[1] : a[0];
    globalThis.__boxes.push({ message: o.message, buttons: o.buttons });
    return { response: 0, checkboxChecked: false };
  };
  dialog.showErrorBox = () => globalThis.__boxes.push({ raw: true });
  setTimeout(() => {
    throw new TypeError('forced fault with Secret Placeholder C:\\synthetic\\x.xlsx');
  }, 10);
});
await new Promise((res) => setTimeout(res, 3000));
const boxes = await app.evaluate(() => globalThis.__boxes);
const status = await page.evaluate(() => window.vss.vault.status()).catch(() => ({ reload: true }));
console.log(JSON.stringify({ boxes, status: status.value?.state ?? status }));
console.log(
  'fault-lines:',
  stderr
    .join('')
    .split('\n')
    .filter((l) => l.includes('app.fault'))
    .join(' | '),
);
console.log('leak:', /Secret|forced|synthetic/.test(stderr.join('')));
await app.close();
