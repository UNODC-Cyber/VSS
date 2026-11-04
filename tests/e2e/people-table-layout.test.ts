/**
 * R13 layout check: the People table at two common laptop sizes, in Chromium against the mock backend.
 * Expires and Status cells stay one line, Unit cells never exceed their column and show an ellipsis for long names.
 * A PNG of each viewport is written to the OS temp directory for the PR.
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
const OUT = join(tmpdir(), 'vss-people-table-layout');
const LONG_UNIT = 'Sample Directorate of Transnational Organised Crime Liaison and Coordination Section';

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
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
}, 120_000);

async function openPeople(width: number, height: number): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width, height } })).newPage();
  page.setDefaultTimeout(15_000);
  await page.goto(`${base}?mock=1&state=unlocked`);
  await page.waitForFunction(() => !!window.__vssMock);
  await page.evaluate((long) => {
    // Synthetic long unit names, set on the in-memory mock before the screen asks for people.
    for (const u of window.__vssMock!.db.units) u.name = `${long} ${u.name}`;
  }, LONG_UNIT);
  await page.evaluate(() => {
    window.location.hash = '#/people';
  });
  await page.getByRole('heading', { name: 'People', level: 1 }).waitFor();
  await page.getByRole('table', { name: /People/ }).waitFor();
  await page.waitForTimeout(400);
  return page;
}

for (const [w, h] of [
  [1280, 720],
  [1366, 768],
] as const) {
  describe(`People table at ${w}x${h}`, () => {
    it('keeps Expires and Status on one line and Unit inside its column', async () => {
      const page = await openPeople(w, h);
      const table = page.getByRole('table', { name: /People/ });
      const res = await table.evaluate((el) => {
        const headers = [...el.querySelectorAll('thead th')].map((th) => th.textContent?.trim() ?? '');
        const idx = (name: string) => headers.findIndex((x) => x.startsWith(name));
        const lineHeight = (c: Element) => parseFloat(getComputedStyle(c).lineHeight) || 20;
        const cellsOf = (i: number) => [...el.querySelectorAll('tbody tr')].map((r) => r.children[i] as HTMLElement);
        const col = (i: number) => (el.querySelectorAll('colgroup col')[i] as HTMLElement).getBoundingClientRect();
        const status = cellsOf(idx('Status'));
        const expires = cellsOf(idx('Expires'));
        const unit = cellsOf(idx('Unit'));
        return {
          n: status.length,
          // the content (not the padded cell) must fit on one line
          statusInner: status.map((c) => (c.firstElementChild as HTMLElement).getBoundingClientRect().height),
          statusLine: status.map((c) => lineHeight(c)),
          expiresH: expires.map((c) => c.scrollHeight),
          expiresLine: expires.map((c) => lineHeight(c)),
          unitOver: unit.map((c) => c.scrollWidth - c.clientWidth),
          unitW: unit.map((c) => c.getBoundingClientRect().width),
          unitColW: col(idx('Unit')).width,
          unitCut: unit.map((c) => {
            const inner = c.querySelector('.vss-truncate-inner') as HTMLElement | null;
            return inner ? inner.scrollWidth > inner.clientWidth : false;
          }),
        };
      });
      expect(res.n).toBeGreaterThan(3);
      res.statusInner.forEach((h2, i) => expect(h2).toBeLessThanOrEqual(res.statusLine[i]! * 1.6));
      // Expires: padded cell height equals one line plus the vertical padding of the other single-line cells.
      const dobH = await table.evaluate(
        (el) => (el.querySelector('tbody tr td:nth-child(2)') as HTMLElement).clientHeight,
      );
      res.expiresH.forEach((h2) => expect(h2).toBeLessThanOrEqual(dobH + 1));
      res.unitOver.forEach((o) => expect(o).toBeLessThanOrEqual(1));
      res.unitW.forEach((w2) => expect(w2).toBeLessThanOrEqual(res.unitColW + 1));
      expect(res.unitCut.some(Boolean)).toBe(true);
      await page.screenshot({ path: join(OUT, `people-${w}x${h}.png`) });
      await page.context().close();
    });
  });
}

describe('People table column chooser (real browser)', () => {
  it('hides and shows a column and keeps the popover usable', async () => {
    const page = await openPeople(1280, 720);
    const header = (n: string) => page.getByRole('columnheader', { name: n });
    await header('Nationality').waitFor();
    await page.getByRole('button', { name: 'Choose columns' }).click();
    await page.getByRole('checkbox', { name: 'Nationality' }).uncheck();
    await header('Nationality').waitFor({ state: 'detached' });
    await page.getByRole('checkbox', { name: 'Nationality' }).check();
    await header('Nationality').waitFor();
    await page.context().close();
  });
});
