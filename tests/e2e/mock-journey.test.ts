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
import type { VssApi } from '../../src/shared/ipc/contract';

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

/**
 * The explicit compare step (UI review O-02): once the full record is loaded, a conflict must be acknowledged before
 * the confirm button works. `expectConflict` asserts that the conflict path was taken.
 */
async function confirmIdentity(confirmName: string, expectConflict = false): Promise<void> {
  const dlg = page.getByRole('dialog');
  const confirm = dlg.getByRole('button', { name: confirmName });
  await confirm.waitFor();
  await dlg.getByText(/These records disagree|Compare the records field by field/).waitFor();
  const conflicts = await dlg.getByTestId('identity-conflicts').count();
  if (expectConflict) expect(conflicts).toBe(1);
  if (conflicts > 0) {
    expect(await confirm.isDisabled()).toBe(true);
    await dlg.getByRole('checkbox', { name: /I compared/ }).check();
  }
  await confirm.click();
}

async function expectNoAxeViolations(): Promise<void> {
  await page.mouse.move(0, 0); // hover styles change contrast; test the resting state
  // A dialog that is still fading in is measured at partial opacity; wait for transitions to settle.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
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
    await page.getByRole('button', { name: 'Next' }).click();
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
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Import request' }).click();
    await page.getByRole('heading', { name: 'Journey Event' }).waitFor();
    await page.getByTestId('unresolved-count').waitFor();

    // blocked export, then resolve
    await page.getByRole('button', { name: 'Export for vetting' }).click();
    await page.getByText('Export is blocked').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Resolve identity for row R3' }).click();
    const dlg = page.getByRole('dialog');
    // Lane K picker: likely persons are listed at once; typing refines the list (no Search button).
    await dlg.getByRole('option').first().waitFor();
    await dlg.getByRole('combobox', { name: /Search/ }).fill('Cedar');
    await dlg
      .getByRole('option', { name: /Cedar, Solana/ })
      .first()
      .click();
    // Identity is never linked on the first click: compare, acknowledge any conflict, then confirm.
    await confirmIdentity('Confirm link to Cedar, Solana');
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
    expect(await dlg.getByLabel('To', { exact: true }).inputValue()).toContain('pat@example.invalid');
    await dlg.getByRole('button', { name: 'Open in mail client' }).click();
    await dlg.getByTestId('mailto-status').waitFor();
    await expectNoAxeViolations();
    await page.keyboard.press('Escape');
  });

  it('resolves a no-candidate response row via the person picker (lane K, R11/R12)', async () => {
    await nav('Review queue').click();
    // R12: the queue names who the item is about.
    const item = page.getByRole('link', { name: 'Open review item for UNLISTED, PERSON' });
    await item.waitFor();
    await expectNoAxeViolations();
    await item.click();
    await page.getByRole('button', { name: 'Choose person...' }).click();
    const dlg = page.getByRole('dialog', { name: 'Choose the person this record is about' });
    const input = dlg.getByRole('combobox', { name: /Search/ });
    // R11: pre-filled with the subject's name and listing at once.
    expect(await input.inputValue()).toBe('UNLISTED, PERSON');
    await dlg
      .getByRole('status')
      .filter({ hasText: /possible person/ })
      .waitFor();
    await expectNoAxeViolations();
    await input.fill('indigo, HAZEL');
    await dlg.getByRole('option', { name: /Hazel, Indigo/ }).waitFor();
    await dlg.getByText('1 possible person').waitFor();
    await input.press('Enter');
    await page.getByText('Compare the record with the person you selected').waitFor();
    await expectNoAxeViolations();
    await confirmIdentity('Confirm link to Hazel, Indigo', true);
    const recorded = () =>
      page.evaluate(async () => {
        const v = (window as unknown as { vss: VssApi }).vss;
        const people = await v.persons.list({ offset: 0, limit: 5, text: 'Hazel' });
        if (!people.ok || !people.value.items[0]) return -1;
        const d = await v.persons.get({ id: people.value.items[0].id });
        return d.ok ? d.value.records.filter((r) => r.responseRowId !== null).length : -1;
      });
    await expect.poll(recorded).toBe(1);
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

  it('R7: a request whose people all have an answer is Finished; review and close; reopen', async () => {
    // The journey request still has one unanswered row (S3 "None of these"): excluding it completes the request.
    await page.evaluate(async () => {
      const m = window.__vssMock!;
      const r = m.db.requests.find((x) => x.eventName === 'Journey Event')!;
      for (const i of r.items)
        if (!m.db.records.some((x) => x.requestId === r.id && x.personId === i.personId))
          await m.api.requests.setItemDecision({ itemId: i.id, decision: 'exclude', reason: 'no answer needed' });
    });
    await nav('Requests').click();
    await page.getByRole('button', { name: 'Needs closing' }).click();
    await page.getByRole('link', { name: 'Journey Event' }).click();
    await page.getByTestId('review-close-panel').waitFor();
    expect(await page.locator('[data-request-status="finished"]').count()).toBeGreaterThan(0);
    await expectNoAxeViolations();
    await page.getByRole('button', { name: 'Close request' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Close note (optional)').fill('Reviewed with the requestor');
    await expectNoAxeViolations();
    await dlg.getByRole('button', { name: 'Close request' }).click();
    await page.getByTestId('close-note').waitFor();
    await page.getByRole('button', { name: 'Reopen request' }).click();
    const re = page.getByRole('dialog');
    expect(await re.getByRole('button', { name: 'Reopen request' }).isDisabled()).toBe(true);
    await re.getByLabel('Reason for reopening').fill('Late correction');
    await re.getByRole('button', { name: 'Reopen request' }).click();
    await page.getByRole('button', { name: 'Close request' }).first().waitFor();
  });

  it('R14: the dashboard backup warning links to the Backup card in Settings and focuses its heading', async () => {
    await page.evaluate(() => {
      const m = window.__vssMock!;
      m.db.audit = m.db.audit.filter((e) => e.type !== 'vault.backup');
    });
    await nav('Dashboard').click();
    const warning = page.getByRole('status').filter({ hasText: 'No backup has been made yet' });
    await warning.waitFor();
    await expectNoAxeViolations();
    await warning.getByRole('link', { name: 'Settings' }).click();
    await page.getByRole('heading', { name: 'Settings', level: 2 }).waitFor();
    await page.waitForFunction(() => document.activeElement?.textContent === 'Backup and restore');
    expect(await page.evaluate(() => window.location.hash)).toBe('#/settings');
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
