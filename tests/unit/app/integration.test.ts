/**
 * The composed main process with the REAL domain services (lane H), exporter (lane G), vault and encrypted DB, driven
 * through the handler table exactly as the renderer drives it over IPC. Synthetic lane B fixtures only.
 * The Playwright suite (tests/e2e/journey.test.ts) repeats this journey against the built Electron app.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { simpleParser } from 'mailparser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addDays } from '@shared/domain/status';
import { parseInvestc } from '../../../src/main/formats/investc/parse';
import { makeApp, PW } from './helpers';
import type { AnyResult, TestApp } from './helpers';

vi.setConfig({ testTimeout: 120_000 });

let t: TestApp | null = null;
let t2: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t2?.cleanup();
  t = t2 = null;
});

const fx = (p: string) => resolve('fixtures', p);
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
  dobPrecision: 'exact' as const,
  sex,
  unitName: 'Example Cyber Crime Unit 1',
  unitType: 'Police' as const,
  unitCountry: 'MALAYSIA',
  pobCountry: 'MALAYSIA',
  pobCity,
  nationality: 'MALAYSIA',
  isHeadOfUnit: false,
});
const v = (r: AnyResult) => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
};
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => `${addDays(today(), -n)}T08:00:00.000Z`;

describe('integration: real services behind the handler table', () => {
  it('seed -> import -> flagged item -> export -> response -> review -> email clearance -> dashboard -> email -> backup/restore', async () => {
    t = await makeApp();
    const call = t.call;
    v(await call('vault', 'create', { password: PW, displayName: 'Integration office' }));

    // 1. Earlier, email-cleared request: three people of the later file are already known and approved
    //    ("Lishair, Bafer" lacks one given name of the later row => flagged for review, never auto-linked).
    const seed = v(
      await call('requests', 'createManual', {
        requestor: REQUESTOR,
        eventName: 'Earlier Synthetic Course',
        eventStart: '2026-09-01',
        eventEnd: '2026-09-02',
        eventLocation: 'Example City',
        sentToDcAt: '2026-09-01T08:00:00.000Z',
        notes: '',
        items: [
          manual('Yokkhai', ['Dadu', 'binti'], '1967-12-23', 'F', 'Rezeh'),
          manual('Vemebeesh', ['Paashal', 'a/p'], '1974-11-10', 'F', 'Shukibi'),
          manual('Lishair', ['Bafer'], '1981-10-27', 'M', 'Wishal'),
        ],
      }),
    );
    const seedReq = v(await call('requests', 'get', { id: seed.id }));
    const seedClear = v(
      await call('responses', 'recordEmailClearance', {
        requestId: seed.id,
        itemIds: seedReq.items.map((i: { id: string }) => i.id),
        certDate: today(),
        expiresAt: '2027-12-31',
        disposition: 'approved',
        note: '',
      }),
    );
    expect(seedClear.recordIds).toHaveLength(3);
    expect(seedClear.expiryAssumed).toBe(false);

    // 2. Import the INVESTc request
    const pv = v(
      await call('requests', 'importPreview', {
        path: await t.pickOpen(fx('requests/req-002-malay-particles.xlsx'), 'request-xlsx'),
      }),
    );
    expect(pv.canCommit).toBe(true);
    const byName = (n: string) => pv.items.find((i: { displayName: string }) => i.displayName.startsWith(n));
    expect(byName('Yokkhai').linkState).toBe('auto');
    expect(byName('Vemebeesh').linkState).toBe('auto');
    expect(byName('Lishair').linkState).toBe('pending-review');
    const req = v(await call('requests', 'importCommit', header(pv.previewId, 'Example Workshop')));
    expect(req.unresolvedLinkCount).toBe(1);

    // 3. Resolve the flagged item in the review queue: it is the known person
    const open = v(await call('review', 'list', { offset: 0, limit: 50, state: 'open' }));
    const link = open.items.find((r: { kind: string }) => r.kind === 'request-item-link');
    const known = seedReq.items.find((i: { observed: { surname: string } }) => i.observed.surname === 'Lishair');
    v(await call('review', 'resolve', { id: link.id, resolution: { action: 'link', targetId: known.personId } }));

    // 4. Export for vetting: only the people not yet vetted go to the DC
    const ep = v(await call('requests', 'exportPreview', { requestId: req.id, mode: 'filter-original' }));
    expect(ep.blockingItemIds).toEqual([]);
    const out = join(t.root, 'export.xlsx');
    const ex = v(
      await call('requests', 'export', {
        requestId: req.id,
        mode: 'filter-original',
        destPath: await t.pickSave(out, 'request-xlsx'),
      }),
    );
    expect(ex.includedCount).toBe(3);
    const reparsed = parseInvestc(new Uint8Array(readFileSync(out)));
    expect(reparsed.people.map((p) => p.surname).sort()).toEqual(['Kimal', 'Pibaageth', 'Tahus']);
    v(await call('requests', 'setStatus', { id: req.id, status: 'sent-to-dc', at: daysAgo(12) }));

    // 5. Response: the swapped-DOB row must not auto-link
    const rp = v(
      await call('responses', 'importPreview', {
        path: await t.pickOpen(fx('responses/resp-002-reformatted.xlsx'), 'response-xlsx'),
        requestId: req.id,
      }),
    );
    expect(rp.matchedRequestId).toBe(req.id);
    expect(rp.requestCandidates[0].requestId).toBe(req.id);
    const tahus = rp.rows.find((r: { nameRaw: string }) => r.nameRaw.startsWith('Tahus'));
    expect(tahus.decision).toBe('pending');
    expect(tahus.chosenRequestItemId).toBeNull();
    expect(rp.rows.every((r: { rowId: string }) => /^[0-9A-Z]{26}$/.test(r.rowId))).toBe(true);
    const committed = v(await call('responses', 'importCommit', { previewId: rp.previewId, requestId: req.id }));
    expect(committed.responseDays).toBe(12);

    const reqNow = v(await call('requests', 'get', { id: req.id }));
    const tahusItem = reqNow.items.find((i: { observed: { surname: string } }) => i.observed.surname === 'Tahus');
    expect(v(await call('persons', 'get', { id: tahusItem.personId })).status).not.toBe('approved');
    const reviews = v(await call('review', 'list', { offset: 0, limit: 50, state: 'open' }));
    const rowReview = reviews.items.find(
      (r: { kind: string; subjectIds: string[] }) => r.kind === 'response-row-match' && r.subjectIds[0] === tahus.rowId,
    );
    v(await call('review', 'resolve', { id: rowReview.id, resolution: { action: 'link', targetId: tahusItem.id } }));
    const tahusPerson = v(await call('persons', 'get', { id: tahusItem.personId }));
    expect(tahusPerson.status).toBe('approved');
    expect(tahusPerson.records[0].expiresAt).toBe('2027-10-20');
    expect(v(await call('requests', 'get', { id: req.id })).status).toBe('responded');

    // 6. Email-only all-clear for another request: default expiry assumed (30 days)
    const pv1 = v(
      await call('requests', 'importPreview', {
        path: await t.pickOpen(fx('requests/req-001-basic.xlsx'), 'request-xlsx'),
      }),
    );
    const r1 = v(await call('requests', 'importCommit', header(pv1.previewId, 'Second Synthetic Event')));
    v(await call('requests', 'setStatus', { id: r1.id, status: 'sent-to-dc', at: daysAgo(3) }));
    const r1Items = v(await call('requests', 'get', { id: r1.id })).items.map((i: { id: string }) => i.id);
    const ec = v(
      await call('responses', 'recordEmailClearance', {
        requestId: r1.id,
        itemIds: r1Items,
        certDate: today(),
        expiresAt: null,
        disposition: 'approved',
        note: 'all clear by email',
      }),
    );
    expect(ec.expiryAssumed).toBe(true);
    expect(ec.responseDays).toBe(3);
    const firstPerson = v(await call('requests', 'get', { id: r1.id })).items[0].personId;
    const rec = v(await call('persons', 'get', { id: firstPerson })).records[0];
    expect(rec).toMatchObject({ expiresAt: addDays(today(), 30), expiryAssumed: true, source: 'email' });

    // 7. Dashboard numbers
    const d = v(await call('stats', 'dashboard', { sinceDays: 365 }));
    // 3 seeded + Kimal, Tahus, Pibaageth (new from req-002) + 6 from req-001
    expect(d.totalPersons).toBe(12);
    // DC-approved (Kimal, Tahus, Pibaageth) + seed approvals valid to 2027-12-31
    expect(d.counts.approved).toBe(6);
    // the six email-cleared people expire after the assumed 30 days, i.e. inside the 30-day expiring window
    expect(d.counts.expiring).toBe(6);
    expect(d.expiringWithin).toEqual({ d30: 6, d60: 6, d90: 6 });
    expect(d.outstandingRequests).toEqual([]);
    expect(d.agingBuckets).toEqual({ '0-7': 0, '8-14': 0, '15-30': 0, '>30': 0 });
    expect(d.turnaroundByKind.file).toMatchObject({ count: 1, meanDays: 12 });
    expect(d.turnaroundByKind.email.count).toBe(2);
    // 63 (seed) and 3 days; the exact value depends on the time of day the test runs
    expect(d.turnaroundByKind.email.medianDays).toBeGreaterThanOrEqual(33);
    expect(d.turnaroundByKind.email.medianDays).toBeLessThanOrEqual(34);
    expect(d.perMonth).toHaveLength(12);
    expect(d.perMonth.at(-1)).toMatchObject({ received: 3, responded: 3 });
    expect(d.lastBackupAt).toBeNull();
    expect(d.inactivePersons).toEqual({ count: 0, sample: [] });
    expect(d.openReviewItems).toBe(v(await call('review', 'counts')).open);

    // 8. Email draft: default columns only; DOB is opt-in per email; .eml parses
    const draft = v(await call('email', 'draft', { template: 'clearance-notice', requestId: req.id }));
    expect(draft.bodyText).toContain('Valid until');
    expect(draft.bodyText).not.toContain('Date of birth');
    expect(draft.bodyText).not.toContain('1988-11-02');
    const withDob = v(
      await call('email', 'draft', { template: 'clearance-notice', requestId: req.id, fields: { dob: true } }),
    );
    expect(withDob.bodyText).toContain('Date of birth');
    expect(withDob.bodyText).toContain('1988-11-02');
    const emlPath = join(t.root, 'draft.eml');
    v(
      await call('email', 'writeEml', {
        draft: { ...draft, to: ['dc@example.invalid'] },
        attachExportId: ex.exportId,
        destPath: await t.pickSave(emlPath, 'eml'),
      }),
    );
    const mail = await simpleParser(readFileSync(emlPath));
    expect(mail.subject).toBe(draft.subject);
    expect(mail.headers.get('x-unsent')).toBe('1');
    expect(mail.text).toContain('Tahus');
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments[0]!.content.equals(readFileSync(out))).toBe(true);

    // 9. Backup: configure needs the password, generates the recovery passphrase ONCE
    const dir = join(t.root, 'backups');
    mkdirSync(dir);
    const cfg = { dir: await t.pickOpen(dir, 'directory'), keep: 3, onLock: true, everyHours: null };
    expect(
      (await call('backup', 'configure', { config: cfg, reauth: { password: 'wrong wrong wrong wrong' } })).error.code,
    ).toBe('BAD_CREDENTIALS');
    // a raw folder path that is not the configured one is refused (F-02)
    expect((await call('backup', 'configure', { config: { ...cfg, dir }, reauth: { password: PW } })).error.code).toBe(
      'BAD_REQUEST',
    );
    const conf = v(await call('backup', 'configure', { config: cfg, reauth: { password: PW } }));
    expect(conf.config.dir).toBe(dir);
    expect(conf.newPassphrase).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
    // the configured folder itself (no new token) is accepted for a schedule change
    const again = v(await call('backup', 'configure', { config: { ...cfg, dir, keep: 5 }, reauth: { password: PW } }));
    expect(again.newPassphrase).toBeNull();
    expect(JSON.stringify(v(await call('backup', 'list')))).not.toContain(conf.newPassphrase);
    const b = v(await call('backup', 'runNow'));
    expect(b.path.startsWith(dir)).toBe(true);
    const listed = v(await call('backup', 'list'));
    expect(listed.backups).toHaveLength(1);
    expect(listed.lastBackupAt).not.toBeNull();
    expect(v(await call('stats', 'dashboard', {})).lastBackupAgeDays).toBe(0);

    // 10. Lock -> on-lock backup -> unlock
    v(await call('vault', 'lock'));
    expect((await call('requests', 'list', { offset: 0, limit: 5 })).error.code).toBe('VAULT_LOCKED');
    expect((await call('backup', 'list')).error.code).toBe('VAULT_LOCKED');
    v(await call('vault', 'unlock', { password: PW }));
    // the on-lock backup ran (counted through the audit events)
    const backups = v(await call('audit', 'list', { offset: 0, limit: 100, type: 'vault.backup' }));
    expect(backups.total).toBe(2);
    const audit = v(await call('audit', 'verify'));
    expect(audit.ok).toBe(true);

    // 11. Restore into a fresh data dir (another computer): only possible before a vault exists
    const src1 = await t.pickOpen(b.path, 'backup');
    expect((await call('backup', 'restore', { srcPath: src1, passphrase: conf.newPassphrase })).error.code).toBe(
      'VAULT_EXISTS',
    );
    t2 = await makeApp();
    // raw path refused
    expect((await t2.call('backup', 'restore', { srcPath: b.path, passphrase: conf.newPassphrase })).ok).toBe(false);
    const src2 = await t2.pickOpen(b.path, 'backup');
    expect((await t2.call('backup', 'restore', { srcPath: src2, passphrase: 'not the passphrase at all' })).ok).toBe(
      false,
    );
    const restored = v(await t2.call('backup', 'restore', { srcPath: src2, passphrase: conf.newPassphrase }));
    expect(restored.state).toBe('locked');
    v(await t2.call('vault', 'unlock', { password: PW }));
    const r2 = v(await t2.call('requests', 'list', { offset: 0, limit: 10 }));
    expect(r2.total).toBe(3);
    expect(v(await t2.call('persons', 'list', { offset: 0, limit: 50 })).total).toBe(12);
    expect(v(await t2.call('audit', 'verify')).ok).toBe(true);
  });

  it('import commit applies per-row export decisions; unmerge keeps a reason; split and duplicate scan are wired', async () => {
    t = await makeApp();
    const call = t.call;
    v(await call('vault', 'create', { password: PW, displayName: 'x' }));
    const pv = v(
      await call('requests', 'importPreview', {
        path: await t.pickOpen(fx('requests/req-001-basic.xlsx'), 'request-xlsx'),
      }),
    );
    const row = pv.items[0].rowRef;
    expect(
      (
        await call('requests', 'importCommit', {
          ...header(pv.previewId, 'E'),
          exportDecisions: [{ rowRef: 'Data!999', decision: 'manual-exclude', reason: 'x' }],
        })
      ).error.code,
    ).toBe('BAD_REQUEST');
    const s1 = v(
      await call('requests', 'importCommit', {
        ...header(pv.previewId, 'E'),
        exportDecisions: [{ rowRef: row, decision: 'manual-exclude', reason: 'withdrawn by requestor' }],
      }),
    );
    const items = v(await call('requests', 'get', { id: s1.id })).items;
    const first = items.find((i: { observed: { rowRef: string } }) => i.observed.rowRef === row);
    expect(first).toMatchObject({ exportDecision: 'manual-exclude', exportReason: 'withdrawn by requestor' });
    const ep = v(await call('requests', 'exportPreview', { requestId: s1.id, mode: 'regenerate' }));
    expect(ep.includedCount).toBe(5);

    const target = items.find((i: { id: string }) => i.id !== first.id);
    const other = items.find((i: { id: string }) => i.id !== first.id && i.id !== target.id);
    v(await call('persons', 'merge', { survivorId: other.personId, mergedId: target.personId, reason: 'test merge' }));
    const merged = v(await call('persons', 'get', { id: other.personId }));
    const logId = merged.mergeHistory[0].id;
    const back = v(await call('persons', 'unmerge', { mergeLogId: logId, reason: 'they are two people' }));
    expect(back.mergeHistory[0].reason).toContain('undone');
    expect(back.mergeHistory[0].reason).toContain('they are two people');
    const scan = v(await call('persons', 'scanDuplicates'));
    expect(scan.pairsFound).toBeGreaterThanOrEqual(0);
    v(await call('persons', 'merge', { survivorId: other.personId, mergedId: target.personId, reason: 'again' }));
    const split = v(
      await call('persons', 'split', { personId: other.personId, itemIds: [target.id], reason: 'wrong link' }),
    );
    expect(split.person.id).not.toBe(other.personId);
  });

  it('dashboard lists people with no activity for 3+ years (informational, nothing purged)', async () => {
    let clock = Date.parse('2026-11-03T09:00:00.000Z');
    t = await makeApp({ now: () => clock });
    v(await t.call('vault', 'create', { password: PW, displayName: 'x' }));
    const pv = v(
      await t.call('requests', 'importPreview', {
        path: await t.pickOpen(fx('requests/req-001-basic.xlsx'), 'request-xlsx'),
      }),
    );
    v(await t.call('requests', 'importCommit', header(pv.previewId, 'Old event')));
    expect(v(await t.call('stats', 'dashboard', {})).inactivePersons.count).toBe(0);
    clock = Date.parse('2029-11-04T09:00:00.000Z');
    const d = v(await t.call('stats', 'dashboard', {}));
    expect(d.inactivePersons.count).toBe(6);
    expect(d.inactivePersons.sample[0].lastActivityAt).toBe('2026-11-03');
    expect(d.totalPersons).toBe(6);
  });
});
