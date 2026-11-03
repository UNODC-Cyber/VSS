/**
 * The REAL app end to end: the built, unpacked Electron app (out/, launched through Playwright's Electron driver) with
 * VSS_DATA_DIR in a temp dir, the real vault / encrypted DB / domain services / exporter, and the synthetic lane B
 * fixtures only. No mock. Mostly driven through `window.vss` (the exact bridge the UI uses), with the key screens
 * driven through the UI: email-only clearance (assumed expiry shown), dashboard numbers, backup set-up (recovery
 * passphrase shown once) and unlock after the idle auto-lock.
 *
 * Offline proof: from launch to quit every main-process socket / DNS lookup / http(s) call and every Chromium
 * request that is not vss:// is recorded; with updates disabled the list must stay empty.
 * All credentials here are synthetic test values.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { simpleParser } from 'mailparser';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';
import { parseInvestc } from '../../src/main/formats/investc/parse';

const PW = 'correct horse battery staple 1';
const root = mkdtempSync(join(tmpdir(), 'vss-journey-'));
const dataA = join(root, 'office-a', 'vault');
const dataB = join(root, 'office-b', 'vault');
const backups = join(root, 'backups');
const fx = (p: string) => resolve('fixtures', p);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const today = () => iso(new Date());
const addDays = (date: string, n: number) => iso(new Date(Date.parse(`${date}T00:00:00.000Z`) + n * 86_400_000));
const daysAgo = (n: number) => `${addDays(today(), -n)}T08:00:00.000Z`;

type R = { ok: boolean; value?: any; error?: { code: string; message: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    // Chromium helpers may hold the profile briefly on Windows; best-effort cleanup of a temp dir.
  }
});

/** Records every network attempt of the main process and of Chromium. Installed right after launch. */
async function installNetworkRecorder(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: a, session }) => {
    const g = globalThis as unknown as { __vssNet: string[] };
    g.__vssNet = [];
    const rec = (what: string) => g.__vssNet.push(what);
    const watch = (s: Electron.Session) => {
      const note = (d: { url: string }) => {
        if (!/^(vss|devtools|data|blob|chrome-extension|chrome):/.test(d.url)) rec(`chromium:${d.url}`);
      };
      // non-blocking listeners: the security filter installed by the app stays in place
      s.webRequest.onCompleted(note);
      s.webRequest.onErrorOccurred(note);
    };
    watch(session.defaultSession);
    a.on('session-created', watch);
    const getMod = (process as unknown as { getBuiltinModule(id: string): any }).getBuiltinModule; // eslint-disable-line @typescript-eslint/no-explicit-any
    const net = getMod('node:net');
    const origConnect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (...args: unknown[]) {
      const o = args[0] as { path?: string } | undefined;
      // named pipes (Chromium/Playwright IPC) are not network
      if (!(o && typeof o === 'object' && typeof o.path === 'string')) rec(`socket:${JSON.stringify(o).slice(0, 80)}`);
      return origConnect.apply(this, args);
    };
    const dns = getMod('node:dns');
    for (const fn of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
      const orig = dns[fn];
      dns[fn] = (...args: unknown[]) => {
        rec(`dns:${String(args[0])}`);
        return orig(...args);
      };
    }
    for (const id of ['node:http', 'node:https']) {
      const m = getMod(id);
      for (const fn of ['request', 'get']) {
        const orig = m[fn];
        m[fn] = (...args: unknown[]) => {
          rec(`${id}:${fn}`);
          return orig(...args);
        };
      }
    }
  });
}
const networkLog = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { __vssNet: string[] }).__vssNet.slice());

async function launch(dataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env = { ...process.env, VSS_DATA_DIR: dataDir } as Record<string, string>;
  delete env['ELECTRON_RUN_AS_NODE'];
  delete env['ELECTRON_RENDERER_URL'];
  const app = await electron.launch({ args: [resolve('.')], env });
  await installNetworkRecorder(app);
  // The real OS idle time would trip the idle auto-lock when nobody touches this machine during the run; the
  // auto-lock step below sets it explicitly.
  await app.evaluate(({ powerMonitor }) => {
    powerMonitor.getSystemIdleTime = () => 0;
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  await page.waitForSelector('html[data-vault-state]:not([data-vault-state="booting"])', { state: 'attached' });
  return { app, page };
}

const call = (page: Page, ns: string, method: string, arg?: unknown): Promise<R> =>
  page.evaluate(
    ([n, m, a]) =>
      (window.vss as unknown as Record<string, Record<string, (x?: unknown) => Promise<R>>>)[n as string]![
        m as string
      ]!(a),
    [ns, method, arg] as const,
  );
const v = async (p: Promise<R>) => {
  const r = await p;
  if (!r.ok) throw new Error(`expected ok, got ${r.error?.code}: ${r.error?.message}`);
  return r.value;
};
/**
 * The user picks `path` in the native open / save dialog (stubbed in the main process). Returns the opaque token
 * main hands to the renderer (security review F-02): raw paths are refused by every file handler.
 */
async function pick(app: ElectronApplication, page: Page, kind: string, path: string, save = false): Promise<string> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog;
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as typeof dialog.showSaveDialog;
  }, path);
  const r = await v(
    call(page, 'files', save ? 'pickSave' : 'pickOpen', save ? { kind, suggestedName: 'x' } : { kind }),
  );
  expect(r.path).toMatch(/^vss-file:[0-9a-f]{32}$/);
  return r.path as string;
}

const REQUESTOR = { name: 'Requestor Placeholder', email: 'requestor@example.invalid', organisation: 'Example Org' };
const header = (previewId: string, eventName: string) => ({
  previewId,
  requestor: REQUESTOR,
  eventName,
  eventStart: '2026-11-20',
  eventEnd: '2026-11-22',
  eventLocation: 'Example City',
  notes: '',
});
// The POB city lets a later request auto-link these people (same unit + same POB place; security review F-06).
const manual = (surname: string, given: string[], dob: string, sex: 'M' | 'F', pobCity: string) => ({
  surname,
  givenNames: given,
  dob,
  dobPrecision: 'exact',
  sex,
  unitName: 'Example Cyber Crime Unit 1',
  unitType: 'Police',
  unitCountry: 'MALAYSIA',
  pobCountry: 'MALAYSIA',
  pobCity,
  nationality: 'MALAYSIA',
  isHeadOfUnit: false,
});

describe('real app journey (no mock)', () => {
  it('create -> import -> flagged item -> export -> response -> review -> email clearance -> dashboard -> email -> auto-lock -> backup/restore -> audit; offline', async () => {
    // ---- 1. create the vault; switch the only network feature (update check) off
    let { app, page } = await launch(dataA);
    expect(page.url()).toMatch(/#\/create$/);
    await v(call(page, 'vault', 'create', { password: PW, displayName: 'Journey office' }));
    await page.waitForSelector('html[data-vault-state="unlocked"]', { state: 'attached' });
    const settings = await v(call(page, 'settings', 'get'));
    expect(settings.exportPolicy.expiringWithinDays).toBe(30);
    await v(
      call(page, 'settings', 'update', {
        settings: { ...settings, updateCheckEnabled: false },
        reauth: { password: PW },
      }),
    );

    // ---- 2. an earlier email-cleared request makes three people of the file known
    const seed = await v(
      call(page, 'requests', 'createManual', {
        requestor: REQUESTOR,
        eventName: 'Earlier Synthetic Course',
        eventStart: '2026-09-01',
        eventEnd: '2026-09-02',
        eventLocation: 'Example City',
        sentToDcAt: daysAgo(40),
        notes: '',
        items: [
          manual('Yokkhai', ['Dadu', 'binti'], '1967-12-23', 'F', 'Rezeh'),
          manual('Vemebeesh', ['Paashal', 'a/p'], '1974-11-10', 'F', 'Shukibi'),
          manual('Lishair', ['Bafer'], '1981-10-27', 'M', 'Wishal'), // one given name short => flagged later, never auto
        ],
      }),
    );
    const seedReq = await v(call(page, 'requests', 'get', { id: seed.id }));
    await v(
      call(page, 'responses', 'recordEmailClearance', {
        requestId: seed.id,
        itemIds: seedReq.items.map((i: { id: string }) => i.id),
        certDate: today(),
        expiresAt: '2027-12-31',
        disposition: 'approved',
        note: '',
      }),
    );

    // ---- 3. import the INVESTc request fixture
    // a raw path from the renderer is refused (F-02)
    expect(
      ((await call(page, 'requests', 'importPreview', { path: fx('requests/req-002-malay-particles.xlsx') })) as R)
        .error?.code,
    ).toBe('BAD_REQUEST');
    const reqFile = await pick(app, page, 'request-xlsx', fx('requests/req-002-malay-particles.xlsx'));
    const pv = await v(call(page, 'requests', 'importPreview', { path: reqFile }));
    const link = (n: string) => pv.items.find((i: { displayName: string }) => i.displayName.startsWith(n)).linkState;
    expect([link('Yokkhai'), link('Vemebeesh'), link('Lishair'), link('Tahus')]).toEqual([
      'auto',
      'auto',
      'pending-review',
      'new-person',
    ]);
    // No template ships with the app: before the first import a regenerate export has nothing to work from.
    expect((await v(call(page, 'templates', 'list'))).active).toBeNull();
    expect(
      (await v(call(page, 'requests', 'exportPreview', { requestId: seed.id, mode: 'regenerate' }))).templateAvailable,
    ).toBe(false);
    const req = await v(call(page, 'requests', 'importCommit', header(pv.previewId, 'Example Workshop')));
    expect(req.unresolvedLinkCount).toBe(1);
    // ...the first valid import is captured, sanitised and without rows, as the vault's export template
    expect(req.templateCaptured).toMatchObject({ source: 'auto-capture', templateVersion: '1.11.0', active: true });
    const tpl = await v(call(page, 'templates', 'list'));
    expect(tpl.active.id).toBe(req.templateCaptured.id);

    // ---- 4. resolve the flagged item in the review queue (it is the known person)
    const open = await v(call(page, 'review', 'list', { offset: 0, limit: 50, state: 'open' }));
    const flagged = open.items.find((r: { kind: string }) => r.kind === 'request-item-link');
    const known = seedReq.items.find((i: { observed: { surname: string } }) => i.observed.surname === 'Lishair');
    await v(
      call(page, 'review', 'resolve', { id: flagged.id, resolution: { action: 'link', targetId: known.personId } }),
    );

    // ---- 5. export for vetting: re-parse the file, only the unknown people are in it
    const exportPath = join(root, 'export-for-dc.xlsx');
    const ex = await v(
      call(page, 'requests', 'export', {
        requestId: req.id,
        mode: 'filter-original',
        destPath: await pick(app, page, 'request-xlsx', exportPath, true),
      }),
    );
    expect(ex.mode).toBe('filter-original');
    const reparsed = parseInvestc(new Uint8Array(readFileSync(exportPath)));
    expect(reparsed.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(reparsed.people.map((p) => p.surname).sort()).toEqual(['Kimal', 'Pibaageth', 'Tahus']);
    // regenerate now works from the captured vault template, and carries only the included people
    const regenPath = join(root, 'export-regenerated.xlsx');
    const rg = await v(
      call(page, 'requests', 'export', {
        requestId: req.id,
        mode: 'regenerate',
        destPath: await pick(app, page, 'request-xlsx', regenPath, true),
      }),
    );
    expect(rg.mode).toBe('regenerate');
    const regen = parseInvestc(new Uint8Array(readFileSync(regenPath)));
    expect(regen.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(regen.people.map((p) => p.surname).sort()).toEqual(['Kimal', 'Pibaageth', 'Tahus']);
    await v(call(page, 'requests', 'setStatus', { id: req.id, status: 'sent-to-dc', at: daysAgo(12) }));

    // ---- 6. the reformatted DC response: the swapped-DOB row must NOT auto-link
    const rp = await v(
      call(page, 'responses', 'importPreview', {
        path: await pick(app, page, 'response-xlsx', fx('responses/resp-002-reformatted.xlsx')),
        requestId: req.id,
      }),
    );
    expect(rp.requestCandidates[0].requestId).toBe(req.id);
    const swapped = rp.rows.find((r: { nameRaw: string }) => r.nameRaw.startsWith('Tahus'));
    expect(swapped.decision).toBe('pending');
    expect(swapped.chosenRequestItemId).toBeNull();
    expect(swapped.candidates[0].evidence).toContain('DOB_SWAPPED');
    const committed = await v(call(page, 'responses', 'importCommit', { previewId: rp.previewId, requestId: req.id }));
    expect(committed.responseDays).toBe(12);
    const items = (await v(call(page, 'requests', 'get', { id: req.id }))).items;
    const tahusItem = items.find((i: { observed: { surname: string } }) => i.observed.surname === 'Tahus');
    expect((await v(call(page, 'persons', 'get', { id: tahusItem.personId }))).records).toHaveLength(0);
    const queue = await v(call(page, 'review', 'list', { offset: 0, limit: 50, state: 'open' }));
    const rowReview = queue.items.find(
      (r: { kind: string; subjectIds: string[] }) =>
        r.kind === 'response-row-match' && r.subjectIds[0] === swapped.rowId,
    );
    await v(
      call(page, 'review', 'resolve', { id: rowReview.id, resolution: { action: 'link', targetId: tahusItem.id } }),
    );

    // ---- 7. statuses and expiry as stated by the DC
    const tahus = await v(call(page, 'persons', 'get', { id: tahusItem.personId }));
    expect(tahus.status).toBe('approved');
    expect(tahus.records[0]).toMatchObject({ certDate: '2026-10-20', expiresAt: '2027-10-20', source: 'dc-file' });
    expect((await v(call(page, 'requests', 'get', { id: req.id }))).status).toBe('responded');

    // ---- 8. email-only clearance for another request, through the UI: 30-day default shown as assumed
    const pv1 = await v(
      call(page, 'requests', 'importPreview', {
        path: await pick(app, page, 'request-xlsx', fx('requests/req-001-basic.xlsx')),
      }),
    );
    const r1 = await v(call(page, 'requests', 'importCommit', header(pv1.previewId, 'Second Synthetic Event')));
    await v(call(page, 'requests', 'setStatus', { id: r1.id, status: 'sent-to-dc', at: daysAgo(3) }));
    await page.evaluate((id) => (window.location.hash = `#/requests/${id}`), r1.id);
    await page.getByRole('heading', { name: 'Second Synthetic Event' }).waitFor();
    await page.getByRole('button', { name: 'Responded by email' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByTestId('expiry-assumed').waitFor();
    expect(await dlg.getByLabel('Expires on').inputValue()).toBe(addDays(today(), 30));
    await dlg.getByRole('button', { name: 'Record outcome' }).click();
    await dlg.waitFor({ state: 'detached' });
    const r1Person = (await v(call(page, 'requests', 'get', { id: r1.id }))).items[0].personId;
    expect((await v(call(page, 'persons', 'get', { id: r1Person }))).records[0]).toMatchObject({
      expiresAt: addDays(today(), 30),
      expiryAssumed: true,
      source: 'email',
    });

    // ---- 9. dashboard numbers, read from the screen
    await page.evaluate(() => (window.location.hash = '#/'));
    await page.getByTestId('stat-people').waitFor();
    expect(await page.getByTestId('stat-people').textContent()).toBe('12');
    expect(await page.getByTestId('stat-outstanding').textContent()).toBe('0');
    expect(await page.getByTestId('ta-file').textContent()).toBe('1 requests, mean 12.0, median 12.0');
    expect(await page.getByTestId('ta-email').textContent()).toBe('2 requests, mean 21.5, median 21.5'); // 40 and 3
    expect(await page.getByTestId('exp-30').textContent()).toBe('within 30 d: 6');
    expect(await page.getByTestId('stat-backup').textContent()).toBe('Never');
    const dash = await v(call(page, 'stats', 'dashboard', {}));
    expect(dash.counts).toMatchObject({ approved: 6, expiring: 6 });
    expect(Number(await page.getByTestId('stat-review').textContent())).toBe(dash.openReviewItems);

    // ---- 10. email draft (default columns, no DOB) saved as .eml with the export attached, then parsed
    const draft = await v(call(page, 'email', 'draft', { template: 'clearance-notice', requestId: req.id }));
    expect(draft.bodyText).not.toContain('Date of birth');
    const emlPath = join(root, 'status.eml');
    await v(
      call(page, 'email', 'writeEml', {
        draft: { ...draft, to: ['requestor@example.invalid'] },
        attachExportId: ex.exportId,
        destPath: await pick(app, page, 'eml', emlPath, true),
      }),
    );
    const mail = await simpleParser(readFileSync(emlPath));
    expect(mail.subject).toBe(draft.subject);
    expect(mail.headers.get('x-unsent')).toBe('1');
    expect(mail.text).toContain('Valid until');
    expect(mail.text).toContain('Tahus');
    expect(mail.attachments[0]!.content.equals(readFileSync(exportPath))).toBe(true);

    // ---- 11. backup set-up through the UI: folder picker (stubbed native dialog), passphrase shown once
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog;
    }, backups);
    await page.evaluate(() => (window.location.hash = '#/settings'));
    await page.getByRole('button', { name: 'Choose folder' }).click();
    await page.getByLabel('Password to change backup settings').fill(PW);
    await page.getByRole('button', { name: 'Set up backups' }).click();
    const pass = page.getByRole('dialog', { name: 'Your backup recovery passphrase' });
    const recovery = (await pass.getByTestId('recovery-passphrase').textContent())!.trim();
    expect(recovery).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(await pass.getByRole('button', { name: 'Done' }).isDisabled()).toBe(true);
    await pass.getByText('I have saved the recovery passphrase').click();
    await pass.getByRole('button', { name: 'Done' }).click();
    await pass.waitFor({ state: 'detached' });
    expect(await page.getByText(recovery).count()).toBe(0);
    await page.getByRole('button', { name: 'Back up now' }).click();
    await page
      .getByTestId('backup-last')
      .getByText(/Last backup/)
      .waitFor();
    const listed = await v(call(page, 'backup', 'list'));
    expect(listed.backups.length).toBe(1);
    expect(JSON.stringify(listed)).not.toContain(recovery);

    // ---- 12. auto-lock: the OS reports the user idle => the idle lock fires (and backs up on lock)
    await app.evaluate(({ powerMonitor }) => {
      powerMonitor.getSystemIdleTime = () => 24 * 3600;
    });
    await page.waitForURL(/#\/lock$/, { timeout: 30_000 });
    await page.waitForSelector('html[data-vault-state="locked"]', { state: 'attached' });
    expect(((await call(page, 'requests', 'list', { offset: 0, limit: 1 })) as R).error?.code).toBe('VAULT_LOCKED');
    await app.evaluate(({ powerMonitor }) => {
      powerMonitor.getSystemIdleTime = () => 0;
    });
    // ---- unlock through the UI
    await page.getByLabel(/^Password/).fill(PW);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await page.getByTestId('stat-people').waitFor();
    const audit = await v(call(page, 'audit', 'list', { offset: 0, limit: 500 }));
    const types = audit.items.map((e: { type: string; details: Record<string, unknown> }) => e.type);
    expect(types).toContain('vault.backup');
    const lockEvent = audit.items.find((e: { type: string }) => e.type === 'vault.lock');
    expect(lockEvent.details.reasonCode).toBe('idle');
    expect((await v(call(page, 'audit', 'verify'))).ok).toBe(true);
    const finalBackup = (await v(call(page, 'backup', 'list'))).backups[0].path;

    // ---- offline proof for office A, then a clean quit
    expect(await networkLog(app)).toEqual([]);
    const exited = new Promise<void>((r) => app.process().once('exit', () => r()));
    await app.evaluate(({ app: a }) => a.quit());
    await exited;

    // ---- 13. restore into a fresh data dir (another computer)
    ({ app, page } = await launch(dataB));
    expect(page.url()).toMatch(/#\/create$/);
    const backupFile = await pick(app, page, 'backup', finalBackup);
    expect(
      ((await call(page, 'backup', 'restore', { srcPath: backupFile, passphrase: 'not the passphrase' })) as R).ok,
    ).toBe(false);
    const restored = await v(call(page, 'backup', 'restore', { srcPath: backupFile, passphrase: recovery }));
    expect(restored.state).toBe('locked');
    expect(existsSync(join(dataB, 'vault.json'))).toBe(true);
    await page.waitForSelector('html[data-vault-state="locked"]', { state: 'attached' });
    await page.getByLabel(/^Password/).fill(PW);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await page.getByTestId('stat-people').waitFor();
    expect(await page.getByTestId('stat-people').textContent()).toBe('12');
    expect((await v(call(page, 'requests', 'list', { offset: 0, limit: 10 }))).total).toBe(3);
    // the restored copy's settings came along: updates are still off
    expect((await v(call(page, 'settings', 'get'))).updateCheckEnabled).toBe(false);
    // ---- 14. the audit chain of the restored vault verifies
    const verified = await v(call(page, 'audit', 'verify'));
    expect(verified.ok).toBe(true);
    expect(verified.checked).toBeGreaterThan(10);
    const restoredTypes = (await v(call(page, 'audit', 'list', { offset: 0, limit: 500 }))).items.map(
      (e: { type: string }) => e.type,
    );
    for (const t of ['vault.create', 'request.import', 'request.export', 'response.import', 'request.email-clearance'])
      expect(restoredTypes).toContain(t);
    expect(await networkLog(app)).toEqual([]);
    await app.close();
  }, 240_000);

  it('positive control: the network recorder does see a socket from main and a blocked request from the page', async () => {
    const { app, page } = await launch(join(root, 'office-c', 'vault'));
    await app.evaluate(() => {
      const net = (process as unknown as { getBuiltinModule(id: string): any }).getBuiltinModule('node:net'); // eslint-disable-line @typescript-eslint/no-explicit-any
      const s = net.connect({ host: '127.0.0.1', port: 9 });
      s.on('error', () => undefined);
    });
    // The renderer cannot even try (CSP connect-src 'none' stops fetch before the network stack); Chromium's network
    // stack is probed through Electron's net module instead, which is what electron-updater would use.
    expect(
      await page.evaluate(() =>
        // eslint-disable-next-line no-restricted-globals -- runs in the page, proving CSP refuses it
        fetch('http://127.0.0.1:9/csp').then(
          () => 'sent',
          () => 'refused',
        ),
      ),
    ).toBe('refused');
    await app.evaluate(({ net }) => void net.fetch('http://127.0.0.1:9/probe').catch(() => undefined));
    await expect.poll(async () => (await networkLog(app)).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    const log = await networkLog(app);
    expect(log.some((l) => l.startsWith('socket:'))).toBe(true);
    expect(log.some((l) => l.startsWith('chromium:http://127.0.0.1:9/probe'))).toBe(true);
    await app.close();
  }, 60_000);
});
