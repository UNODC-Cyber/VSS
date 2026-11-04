/**
 * G2 layout check: at 1024 px wide no screen scrolls the page sideways, and no table cell's text spills out of its
 * cell. Chromium against the mock backend (no Electron). PNGs go to the OS temp directory.
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let server: ViteDevServer;
let browser: Browser;
let base = '';
let page: Page;
const OUT = join(tmpdir(), 'vss-layout-1024');

beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  server = await createServer({
    root: resolve('src/renderer'),
    configFile: false,
    plugins: [react()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    server: { port: 0, host: '127.0.0.1' },
    logLevel: 'error',
  });
  await server.listen();
  base = server.resolvedUrls?.local[0] ?? '';
  try {
    browser = await chromium.launch();
  } catch {
    browser = await chromium.launch({ channel: 'msedge' });
  }
  page = await (await browser.newContext({ viewport: { width: 1024, height: 768 } })).newPage();
  page.setDefaultTimeout(15_000);
  await page.goto(`${base}?mock=1&state=unlocked`);
  await page.waitForFunction(() => !!window.__vssMock);
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
}, 120_000);

async function go(hash: string): Promise<void> {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
  await page.waitForTimeout(700);
}

async function metrics() {
  return page.evaluate(() => {
    const spill: string[] = [];
    for (const td of document.querySelectorAll('.vss-table td, .vss-table th')) {
      const cell = td as HTMLElement;
      // Content may be cut (ellipsis) but must never be painted over the next cell: the cell clips.
      if (getComputedStyle(cell).overflow === 'visible' && cell.scrollWidth > cell.clientWidth + 1) {
        spill.push(cell.textContent?.slice(0, 30) ?? '');
      }
    }
    const root = document.documentElement;
    return {
      pageScroll: root.scrollWidth - root.clientWidth,
      spill,
      tables: document.querySelectorAll('.vss-table').length,
    };
  });
}

const ROUTES: [string, string][] = [
  ['dashboard', '#/'],
  ['requests', '#/requests'],
  ['people', '#/people'],
  ['units', '#/units'],
  ['review', '#/review'],
  ['responses', '#/responses'],
  ['audit', '#/audit'],
  ['search', '#/search?q=Alder'],
  ['settings', '#/settings'],
  ['manual-request', '#/requests/new'],
];

describe('1024 px layout', () => {
  for (const [name, hash] of ROUTES) {
    it(`${name}: no page-level horizontal scroll, no spilling cells`, async () => {
      await go(hash);
      const m = await metrics();
      await page.screenshot({ path: join(OUT, `${name}.png`) });
      expect(m.pageScroll).toBeLessThanOrEqual(0);
      expect(m.spill).toEqual([]);
    });
  }

  it('request detail and import preview', async () => {
    await go('#/requests');
    const href = await page.getByRole('link', { name: 'Regional Cyber Workshop' }).getAttribute('href');
    await go(href ?? '#/requests');
    await page.getByRole('table', { name: 'Individuals on this request' }).waitFor();
    let m = await metrics();
    await page.screenshot({ path: join(OUT, 'request-detail.png') });
    expect(m.pageScroll).toBeLessThanOrEqual(0);
    expect(m.spill).toEqual([]);

    await go('#/requests/import');
    await page.getByRole('button', { name: 'Choose file' }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('table', { name: 'Rows in the file' }).waitFor();
    m = await metrics();
    await page.screenshot({ path: join(OUT, 'import-request.png') });
    expect(m.pageScroll).toBeLessThanOrEqual(0);
    expect(m.spill).toEqual([]);
  });
});
