/**
 * Renderer journeys against the in-memory mock backend (`?mock=1`), in a plain Chromium browser.
 * No Electron and no main process: this exercises the UI only. It starts a Vite dev server for src/renderer.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PASSWORD = 'correct horse battery staple';
let server: ViteDevServer;
let browser: Browser;
let page: Page;
let base = '';
const pageErrors: string[] = [];

beforeAll(async () => {
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
  page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`${base}?mock=1`);
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const nav = (name: string) =>
  page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: new RegExp(name) });

async function chooseOption(label: string, option: RegExp | string, index = 0): Promise<void> {
  await page.getByLabel(label).nth(index).click();
  await page.getByRole('option', { name: option }).first().click();
}

async function expectNoAxeViolations(): Promise<void> {
  await page.mouse.move(0, 0); // hover styles change contrast; test the resting state
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    r.violations.map(
      (v) =>
        `${v.id}: ${v.nodes
          .map((n) => `${n.target.join(' ')} ${n.any[0]?.message ?? ''}`)
          .slice(0, 3)
          .join(' | ')}`,
    ),
  ).toEqual([]);
}

describe('mock journey', () => {
  it('create vault', async () => {
    await page.getByRole('heading', { name: 'Create your vault' }).waitFor();
    await expectNoAxeViolations();
    await page.getByLabel(/^Your name/).fill('Test User');
    await page
      .getByLabel(/^Password/)
      .first()
      .fill(PASSWORD);
    await page.getByLabel(/^Confirm password/).fill(PASSWORD);
    await page.getByRole('button', { name: 'Create vault' }).click();
    await page.getByRole('navigation', { name: 'Main navigation' }).waitFor();
    expect(await page.getByTestId('network-status').textContent()).toBe('Offline');
  });

  it('lock with Ctrl+L and unlock', async () => {
    await page.keyboard.press('Control+l');
    await page.getByRole('heading', { name: 'Unlock' }).waitFor();
    expect(await page.getByTestId('stat-outstanding').count()).toBe(0);
    expect(page.url()).toContain('#/lock');
    await expectNoAxeViolations();
    await page.getByLabel(/^Password/).fill('wrong password here');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await page.getByText('Wrong password.').waitFor();
    await page.getByLabel(/^Password/).fill(PASSWORD);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await page.getByTestId('stat-outstanding').waitFor();
  });

  it('dashboard is accessible and shows the seeded numbers', async () => {
    expect(await page.getByTestId('stat-outstanding').textContent()).toBe('1');
    expect(await page.getByTestId('stat-review').textContent()).toBe('1');
    await expectNoAxeViolations();
  });

  it('import a request, resolve the flagged item, export, mark sent', async () => {
    await nav('Requests').click();
    await page.getByRole('link', { name: 'Regional Cyber Workshop' }).waitFor();
    await expectNoAxeViolations();
    await page.getByRole('button', { name: 'Import request file' }).click();
    await page.getByRole('button', { name: 'Choose file' }).click();
    await page.getByTestId('count-flagged').waitFor();
    expect(await page.getByTestId('count-flagged').textContent()).toBe('2 flagged');
    // Type-ahead over the saved requestors (lane B): picking one fills the e-mail, so the email to the requestor has an address.
    await page.getByLabel(/^Requestor name/).fill('pat');
    await page
      .getByRole('option', { name: /Pat Example/ })
      .first()
      .click();
    expect(await page.getByLabel(/^Requestor name/).inputValue()).toBe('Pat Example');
    expect(await page.getByLabel('Requestor email').inputValue()).toBe('pat@example.invalid');
    await page.getByLabel(/^Event name/).fill('Journey Event');
    await expectNoAxeViolations();
    await page.getByRole('button', { name: 'Import request' }).click();
    await page.getByRole('heading', { name: 'Journey Event' }).waitFor();
    await page.getByTestId('unresolved-count').waitFor();

    // blocked export, then resolve
    await page.getByRole('button', { name: 'Export for vetting' }).click();
    await page.getByText('Export is blocked').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Resolve identity for row R3' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Search').fill('Cedar');
    await dlg.getByRole('button', { name: 'Search' }).click();
    await dlg.getByRole('button', { name: /Select Cedar/ }).click();
    await page.getByTestId('unresolved-count').waitFor({ state: 'detached' });

    await page.getByRole('button', { name: 'Export for vetting' }).click();
    const exp = page.getByRole('dialog');
    await exp.getByRole('button', { name: 'Export file' }).click();
    await exp.getByText(/Saved to mock:\/\/saved\//).waitFor();
    await exp.getByRole('button', { name: 'Close', exact: true }).click();

    await page.getByRole('button', { name: 'Mark sent' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Mark sent' }).click();
    await page.getByText('Waiting for an answer').waitFor();
    await expectNoAxeViolations();
  });

  it('import the response and confirm a T2 row', async () => {
    await page.getByRole('button', { name: 'Import response' }).click();
    await page.getByRole('button', { name: 'Choose file' }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('table', { name: 'Rows in the response' }).waitFor();
    expect(await page.getByRole('button', { name: 'Next' }).isDisabled()).toBe(true);
    // Back keeps the step and the file: Match request is one step back, Next returns to the rows.
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByRole('heading', { name: 'Match request' }).waitFor();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('table', { name: 'Rows in the response' }).waitFor();
    await page.getByRole('button', { name: 'Compare row S2' }).click();
    await page.getByRole('dialog').getByTestId('diff').waitFor();
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await chooseOption('Decision for row S2', /^T2:/);
    await chooseOption('Decision for row S3', 'None of these');
    await expectNoAxeViolations();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Import response' }).click();
    await page.getByRole('heading', { name: 'Journey Event' }).waitFor();
    await page.getByText('Responded').first().waitFor();
  });

  it('drafts an email to the requestor', async () => {
    await page.getByRole('button', { name: 'Email requestor' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Subject').waitFor();
    expect(await dlg.getByLabel('Subject').inputValue()).toContain('vetting request received');
    expect(await dlg.getByLabel('To').inputValue()).toContain('pat@example.invalid');
    await dlg.getByRole('button', { name: 'Open in mail client' }).click();
    await dlg.getByTestId('mailto-status').waitFor();
    await expectNoAxeViolations();
    await page.keyboard.press('Escape');
  });

  it('a saved e-mail template shows up in the next draft; the authority contacts are accessible', async () => {
    await nav('Settings').click();
    await page.getByRole('heading', { name: 'E-mail templates' }).waitFor();
    await page.getByRole('tab', { name: 'Acknowledge receipt to requestor' }).click();
    await page.getByLabel('Subject', { exact: true }).fill('Custom ack: {event}');
    await page.getByTestId('preview-subject').filter({ hasText: 'Custom ack: Example Regional Workshop' }).waitFor();
    await page.getByRole('button', { name: 'Add To contact' }).click();
    await page.getByLabel('To contact 1: Name').fill('Example Desk');
    await page.getByLabel('To contact 1: E-mail address').fill('desk@example.invalid');
    await expectNoAxeViolations();
    await page.getByLabel(/Password to confirm changes/).fill(PASSWORD);
    await page.getByRole('button', { name: 'Save settings' }).click();
    await page.getByText('Settings saved').first().waitFor();
    await nav('Requests').click();
    await page.getByRole('link', { name: 'Journey Event' }).click();
    await page.getByRole('button', { name: 'Email requestor' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Subject').waitFor();
    expect(await dlg.getByLabel('Subject').inputValue()).toBe('Custom ack: Journey Event');
    await page.keyboard.press('Escape');
  });

  it('dashboard numbers reflect the journey', async () => {
    await nav('Dashboard').click();
    await page.getByTestId('stat-outstanding').waitFor();
    expect(await page.getByTestId('stat-outstanding').textContent()).toBe('1');
    expect(await page.getByTestId('ta-file').textContent()).toContain('2 requests');
    expect(await page.getByTestId('ta-email').textContent()).toContain('1 requests');
    expect(await page.getByTestId('stat-people').textContent()).toBe('10');
  });

  it('other main screens pass the accessibility check', async () => {
    for (const [name, heading] of [
      ['Responses', 'Responses'],
      ['People', 'People'],
      ['Units', 'Units'],
      ['Review queue', 'Review queue'],
      ['Search', 'Search'],
      ['Settings', 'Settings'],
      ['Audit', 'Audit log'],
    ] as const) {
      await nav(name).click();
      await page.getByRole('heading', { name: heading, level: 2 }).waitFor();
      await page.waitForTimeout(250);
      await expectNoAxeViolations();
    }
  });

  it('auto-locks after idle time, warns first, and unlocks again', async () => {
    await nav('Dashboard').click();
    await page.evaluate(() => window.__vssMock!.fastForwardIdle(10 * 60 - 25));
    await page
      .getByRole('dialog')
      .getByText(/locks automatically/)
      .waitFor();
    await page.getByRole('dialog').getByRole('button', { name: 'Stay unlocked' }).click();
    await page.evaluate(() => window.__vssMock!.fastForwardIdle(10 * 60));
    await page.getByRole('heading', { name: 'Unlock' }).waitFor();
    expect(await page.getByTestId('stat-outstanding').count()).toBe(0);
    await page.getByLabel(/^Password/).fill(PASSWORD);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await page.getByTestId('stat-outstanding').waitFor();
  });

  it('dark theme has no contrast violations on the dashboard', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page
      .getByRole('button', { name: /Switch theme/ })
      .first()
      .click();
    await page.waitForTimeout(300);
    await expectNoAxeViolations();
    await page.emulateMedia({ colorScheme: 'light' });
  });

  it('deletes the database through the danger zone and starts over with a new vault (lane L)', async () => {
    await nav('Settings').click();
    await page.locator('#card-danger').scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: 'Delete database...' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete database' });
    const confirm = dialog.getByRole('button', { name: 'Delete database' });
    await dialog.getByLabel(/^Password to confirm/).fill(PASSWORD);
    await dialog.getByLabel(/^Type DELETE DATABASE/).fill('delete database');
    expect(await confirm.isDisabled()).toBe(true);
    await dialog.getByLabel(/^Type DELETE DATABASE/).fill('DELETE DATABASE');
    await confirm.click();
    await page.getByRole('heading', { name: 'Create your vault' }).waitFor();
    expect(page.url()).toContain('#/create');
    await page.getByText('The database was deleted').waitFor();
    // Straight away: a new vault, with none of the old data.
    await page.getByLabel(/^Your name/).fill('Second User');
    await page
      .getByLabel(/^Password/)
      .first()
      .fill(PASSWORD);
    await page.getByLabel(/^Confirm password/).fill(PASSWORD);
    await page.getByRole('button', { name: 'Create vault' }).click();
    await page.getByRole('navigation', { name: 'Main navigation' }).waitFor();
    await page.getByTestId('stat-outstanding').waitFor();
  });

  it('raised no uncaught page errors', () => {
    expect(pageErrors).toEqual([]);
  });

  it('the production build contains no mock code', () => {
    const assets = resolve('out/renderer/assets');
    if (!existsSync(assets)) return; // only meaningful after `npm run build` (test:e2e builds first)
    const js = readdirSync(assets).filter((f) => f.endsWith('.js'));
    expect(js.length).toBeGreaterThan(0);
    for (const f of js) {
      const text = readFileSync(join(assets, f), 'utf8');
      expect(text).not.toContain('__vssMock');
      expect(text).not.toContain('Exampleland');
    }
  });
});
