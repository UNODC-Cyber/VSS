/**
 * End-to-end over the real built app (out/main, launched through Playwright's Electron driver) with VSS_DATA_DIR in
 * a temp dir: create vault -> lock -> unlock with a wrong then the right password -> settings change needs the
 * password -> app quits cleanly (locks first) -> relaunch shows the audit trail.
 * All credentials here are synthetic test values.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';

const PW = 'correct horse battery staple 1';
const root = mkdtempSync(join(tmpdir(), 'vss-e2e-'));
const dataDir = join(root, 'vault');

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const env = { ...process.env, VSS_DATA_DIR: dataDir } as Record<string, string>;
  delete env['ELECTRON_RUN_AS_NODE'];
  delete env['ELECTRON_RENDERER_URL'];
  const app = await electron.launch({ args: [resolve('.')], env });
  // the real OS idle time must not trip the idle auto-lock mid-test
  await app.evaluate(({ powerMonitor }) => {
    powerMonitor.getSystemIdleTime = () => 0;
  });
  const page = await app.firstWindow();
  await page.waitForSelector('html[data-vault-state]:not([data-vault-state="booting"])', { state: 'attached' });
  return { app, page };
}

type R = { ok: boolean; value?: any; error?: { code: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any
const run = <T>(page: Page, fn: () => Promise<T>): Promise<T> => page.evaluate(fn);

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    // Chromium helper processes can keep the profile locked briefly on Windows; best-effort cleanup.
  }
});

describe('app e2e', () => {
  it('first run -> create -> lock -> wrong/right unlock -> gated settings -> clean quit -> relaunch', async () => {
    // ---- first launch: no vault => create route
    let { app, page } = await launch();
    expect(page.url()).toMatch(/#\/create$/);
    const status0 = (await run(page, () => window.vss.vault.status())) as R;
    expect(status0.value.state).toBe('no-vault');

    const created = (await page.evaluate(
      (pw) => window.vss.vault.create({ password: pw, displayName: 'E2E office' }),
      PW,
    )) as R;
    expect(created.ok).toBe(true);
    expect(created.value.state).toBe('unlocked');
    expect(existsSync(join(dataDir, 'vault.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'vss.db'))).toBe(true);

    // ---- manual lock navigates the renderer to the lock route
    expect(((await run(page, () => window.vss.vault.lock())) as R).value.state).toBe('locked');
    await page.waitForURL(/#\/lock$/);
    await page.waitForSelector('html[data-vault-state="locked"]', { state: 'attached' });
    expect(((await run(page, () => window.vss.settings.get())) as R).error?.code).toBe('VAULT_LOCKED');

    // ---- wrong then right password
    const wrong = (await page.evaluate(() => window.vss.vault.unlock({ password: 'wrong wrong wrong wrong' }))) as R;
    expect(wrong.error?.code).toBe('BAD_CREDENTIALS');
    const right = (await page.evaluate((pw) => window.vss.vault.unlock({ password: pw }), PW)) as R;
    expect(right.ok).toBe(true);
    expect(right.value.state).toBe('unlocked');

    // ---- settings change requires the password
    const current = ((await run(page, () => window.vss.settings.get())) as R).value;
    const changed = { ...current, clipboardClearSeconds: 45 };
    const noAuth = (await page.evaluate(
      (s) => window.vss.settings.update({ settings: s, reauth: { password: 'wrong wrong wrong wrong' } }),
      changed,
    )) as R;
    expect(noAuth.error?.code).toBe('BAD_CREDENTIALS');
    expect(((await run(page, () => window.vss.settings.get())) as R).value.clipboardClearSeconds).toBe(30);
    const withAuth = (await page.evaluate(
      ([s, pw]) => window.vss.settings.update({ settings: s as typeof current, reauth: { password: pw as string } }),
      [changed, PW] as const,
    )) as R;
    expect(withAuth.ok).toBe(true);
    expect(withAuth.value.clipboardClearSeconds).toBe(45);

    // ---- clipboard goes through main
    const copy = (await run(page, () => window.vss.clipboard.copy({ field: 'plain', text: 'synthetic' }))) as R;
    expect(copy.value.clearsInSeconds).toBe(45);

    // ---- clean quit: the before-quit handler locks first, then the process exits
    const exited = new Promise<void>((r) => app.process().once('exit', () => r()));
    await app.evaluate(({ app: a }) => a.quit());
    await exited;

    // ---- relaunch: vault exists => unlock route; audit trail shows the whole story and verifies
    ({ app, page } = await launch());
    expect(page.url()).toMatch(/#\/unlock$/);
    expect(((await run(page, () => window.vss.vault.status())) as R).value.state).toBe('locked');
    expect(((await page.evaluate((pw) => window.vss.vault.unlock({ password: pw }), PW)) as R).ok).toBe(true);
    const audit = (await run(page, () => window.vss.audit.list({ offset: 0, limit: 50 }))) as R;
    const types = audit.value.items.map((e: { type: string }) => e.type).reverse();
    expect(types).toEqual([
      'vault.create',
      'vault.lock',
      'vault.unlock',
      'settings.update',
      'vault.lock', // written by the graceful shutdown
      'vault.unlock',
    ]);
    expect(((await run(page, () => window.vss.audit.verify())) as R).value.ok).toBe(true);
    expect(((await run(page, () => window.vss.settings.get())) as R).value.clipboardClearSeconds).toBe(45);
    await app.close();
  });
});
