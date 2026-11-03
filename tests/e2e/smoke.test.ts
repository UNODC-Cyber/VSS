import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let app: ElectronApplication;
let dataDir: string;
let page: Page;
const consoleErrors: string[] = [];

beforeAll(async () => {
  dataDir = join(mkdtempSync(join(tmpdir(), 'vss-smoke-')), 'vault');
  const env = { ...process.env, VSS_DATA_DIR: dataDir } as Record<string, string>;
  delete env['ELECTRON_RUN_AS_NODE'];
  delete env['ELECTRON_RENDERER_URL'];
  app = await electron.launch({ args: [resolve('.')], env });
  page = await app.firstWindow();
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  await page.reload();
  await page.waitForSelector('html[data-vault-state]:not([data-vault-state="booting"])', { state: 'attached' });
});

afterAll(async () => {
  await app?.close();
  // Chromium helpers may hold the profile a moment after close; the temp dir is cleaned up best-effort.
  try {
    if (dataDir) rmSync(join(dataDir, '..'), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    // best-effort
  }
});

describe('app smoke', () => {
  it('renders the app from vss://app (first run: the create-vault screen)', async () => {
    expect(page.url()).toMatch(/^vss:\/\/app\/index\.html(#.*)?$/);
    expect(await page.title()).toBe('Vetting Support System');
    await expect(page.locator('h1').textContent()).resolves.toBe('Create your vault');
  });

  it('is isolated: no require, process, Buffer or ipcRenderer in the page', async () => {
    const probe = await page.evaluate(() => ({
      require: typeof (window as unknown as Record<string, unknown>)['require'],
      process: typeof (window as unknown as Record<string, unknown>)['process'],
      buffer: typeof (window as unknown as Record<string, unknown>)['Buffer'],
      electron: typeof (window as unknown as Record<string, unknown>)['electron'],
      ipcRenderer: typeof (window as unknown as Record<string, unknown>)['ipcRenderer'],
      vss: typeof window.vss,
    }));
    expect(probe).toEqual({
      require: 'undefined',
      process: 'undefined',
      buffer: 'undefined',
      electron: 'undefined',
      ipcRenderer: 'undefined',
      vss: 'object',
    });
  });

  it('main process window is sandboxed with context isolation', async () => {
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0]!.webContents;
      const p = (wc as unknown as { getLastWebPreferences(): Record<string, unknown> }).getLastWebPreferences();
      return { sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration };
    });
    expect(prefs).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false });
  });

  it('window.vss exposes exactly the contract namespaces', async () => {
    const keys = await page.evaluate(() => Object.keys(window.vss).sort());
    expect(keys).toEqual(
      [
        'audit',
        'backup',
        'clipboard',
        'email',
        'files',
        'on',
        'peer',
        'persons',
        'requests',
        'responses',
        'review',
        'settings',
        'stats',
        'templates',
        'units',
        'updates',
        'vault',
      ].sort(),
    );
  });

  it('unimplemented handlers answer NOT_SUPPORTED and bad payloads BAD_REQUEST', async () => {
    const r = await page.evaluate(() => window.vss.peer.status());
    expect(r).toEqual({ ok: false, error: { code: 'NOT_SUPPORTED', message: 'vss:peer.status is not implemented' } });
    const bad = await page.evaluate(() =>
      (window.vss.persons.list as (x: unknown) => Promise<{ ok: boolean; error: { code: string } }>)({
        offset: 0,
        limit: 999999,
      }),
    );
    expect(bad.error.code).toBe('BAD_REQUEST');
  });

  it('applies the CSP without violations and blocks outside requests', async () => {
    const result = await page.evaluate(async () => {
      try {
        await window.fetch('https://example.com/');
        return 'allowed';
      } catch {
        return 'blocked';
      }
    });
    expect(result).toBe('blocked');
    expect(
      consoleErrors.filter((e) => /Content Security Policy|Refused to/.test(e) && !/example\.com/.test(e)),
    ).toEqual([]);
  });

  it('denies window.open and navigation away', async () => {
    const windowsBefore = app.windows().length;
    await page.evaluate(() => window.open('https://example.com/'));
    await page.evaluate(() => {
      location.href = 'https://example.com/';
    });
    await page.waitForTimeout(500);
    expect(app.windows().length).toBe(windowsBefore);
    expect(page.url()).toMatch(/^vss:\/\/app\/index\.html/);
  });
});
