// Email clearance expiry policy, export policy, dashboard statistics, expiry watch + CSV export.
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/domain/types';
import type { VettingStatusSnapshot } from '@shared/domain/types';
import { applyExportPolicy } from '../../../src/main/services/vetting-status';
import { csvCell } from '../../../src/main/services/vetting';
import type { DashboardEx } from '../../../src/main/services/vetting';
import {
  commitHeader,
  errCode,
  fixtureBytes,
  harness,
  manualItem,
  manualRequest,
  once,
  PASSWORD,
  unwrap,
} from './helpers';
import type { Harness } from './helpers';

let h: Harness;
afterEach(() => h?.cleanup());

let seq = 0;
async function sentManual(h: Harness, n: number, sentAt = '2026-11-01T08:00:00.000Z') {
  const items = Array.from({ length: n }, () => {
    const k = seq++;
    return manualItem({
      surname: `Personname${String.fromCharCode(97 + (k % 26))}${String.fromCharCode(97 + Math.floor(k / 26))}`,
      dob: `198${k % 10}-02-1${k % 10}`,
      unitName: `Synthetic Unit ${k}`,
    });
  });
  const s = await once(h, () => h.svc.requests.createManual(manualRequest(items, { sentToDcAt: sentAt })));
  return { s, items: h.fx.repos.requests.listItems(s.id) };
}

describe('email-only clearance', () => {
  it('defaults expiry to cert date + 30 days (expiryAssumed) and computes response time', async () => {
    h = harness('2026-11-10T08:00:00.000Z');
    const { s, items } = await sentManual(h, 2);
    expect(h.fx.repos.requests.getHeader(s.id)!.status).toBe('sent-to-dc');
    const out = await once(h, () =>
      h.svc.requests.markRespondedByEmail({
        requestId: s.id,
        itemIds: [items[0]!.id],
        certDate: '2026-11-10',
        expiresAt: null,
        disposition: 'approved',
        note: '',
      }),
    );
    expect(out.responseDays).toBe(9);
    const rec = h.fx.repos.vetting.get(out.recordIds[0]!)!;
    expect(rec).toMatchObject({
      disposition: 'email-cleared',
      source: 'email',
      certDate: '2026-11-10',
      expiresAt: '2026-12-10',
      expiryAssumed: true,
    });
    const st = unwrap(await h.svc.vetting.statusOf(items[0]!.personId!));
    expect(st.status).toBe('expiring'); // 30 days < 60-day window
    const req = h.fx.repos.requests.getHeader(s.id)!;
    expect(req).toMatchObject({ status: 'responded', responseKind: 'email-clearance' });
  });

  it('explicit expiry overrides the default; per-person dispositions; settings change the default', async () => {
    h = harness('2026-11-10T08:00:00.000Z');
    const { s, items } = await sentManual(h, 3);
    const out = await once(h, () =>
      h.svc.responses.recordEmailClearance({
        requestId: s.id,
        itemIds: [items[0]!.id, items[1]!.id],
        certDate: '2026-11-10',
        expiresAt: '2027-11-10',
        disposition: 'approved',
        dispositions: { [items[1]!.id]: 'non-approved' },
        note: 'per email',
      }),
    );
    const [r0, r1] = out.recordIds.map((id) => h.fx.repos.vetting.get(id)!);
    expect(r0).toMatchObject({ disposition: 'email-cleared', expiresAt: '2027-11-10', expiryAssumed: false });
    expect(r1).toMatchObject({ disposition: 'non-approved', expiryAssumed: false });
    expect(unwrap(await h.svc.vetting.statusOf(items[1]!.personId!)).status).toBe('non-approved');
    expect(unwrap(await h.svc.vetting.statusOf(items[0]!.personId!)).status).toBe('approved');

    h.fx.repos.settings.set('emailClearanceDefaultDays', 45);
    const out2 = unwrap(
      await h.svc.requests.markRespondedByEmail({
        requestId: s.id,
        itemIds: [items[2]!.id],
        certDate: '2026-11-10',
        expiresAt: null,
        disposition: 'approved',
        note: '',
      }),
    );
    expect(h.fx.repos.vetting.get(out2.recordIds[0]!)!.expiresAt).toBe('2026-12-25');
  });

  it('refuses items with an unresolved person link', async () => {
    h = harness();
    const s = await once(h, () => h.svc.requests.createManual(manualRequest([manualItem(), manualItem()])));
    const items = h.fx.repos.requests.listItems(s.id);
    const r = await h.svc.requests.markRespondedByEmail({
      requestId: s.id,
      itemIds: [items[0]!.id],
      certDate: '2026-11-03',
      expiresAt: null,
      disposition: 'approved',
      note: '',
    });
    expect(errCode(r)).toBe('UNRESOLVED_REVIEW');
  });
});

describe('export policy', () => {
  const snap = (status: VettingStatusSnapshot['status'], unitId: string | null = 'U1'): VettingStatusSnapshot => ({
    status,
    certDate: null,
    expiresAt: null,
    unitId,
    source: null,
    asOf: '2026-11-03',
  });
  const P = DEFAULT_SETTINGS.exportPolicy;
  it('maps statuses onto decisions', () => {
    const d = (
      s: VettingStatusSnapshot | null,
      linkState: 'auto' | 'pending-review' = 'auto',
      unitId: string | null = 'U1',
    ) => applyExportPolicy({ linkState, prior: s, unitId }, P);
    expect(d(null).decision).toBe('include');
    expect(d(snap('unknown')).decision).toBe('include');
    expect(d(snap('pending')).decision).toBe('exclude');
    expect(d(snap('expired')).decision).toBe('include');
    expect(d(snap('expiring')).decision).toBe('include');
    expect(d(snap('non-approved')).decision).toBe('exclude');
    expect(d(snap('approved'))).toMatchObject({ decision: 'exclude', reason: 'approved-valid' });
    expect(d(snap('approved'), 'auto', 'U2')).toMatchObject({ decision: 'include', reason: 'unit-changed' });
    expect(d(null, 'pending-review')).toMatchObject({ decision: 'include', blocking: true });
    expect(
      applyExportPolicy(
        { linkState: 'pending-review', prior: null, unitId: null },
        { ...P, includeFlaggedUnresolved: 'exclude' },
      ).decision,
    ).toBe('exclude');
    expect(
      applyExportPolicy({ linkState: 'auto', prior: snap('pending'), unitId: null }, { ...P, includePending: true })
        .decision,
    ).toBe('include');
  });

  it('a re-request of an approved person is excluded by default', async () => {
    h = harness('2026-11-10T08:00:00.000Z');
    const { s, items } = await sentManual(h, 1);
    unwrap(
      await h.svc.requests.markRespondedByEmail({
        requestId: s.id,
        itemIds: [items[0]!.id],
        certDate: '2026-11-10',
        expiresAt: '2027-11-10',
        disposition: 'approved',
        note: '',
      }),
    );
    const again = await once(h, () =>
      h.svc.requests.createManual(
        manualRequest([
          manualItem({
            surname: items[0]!.observed.surname,
            dob: items[0]!.observed.dob.parsed,
            unitName: items[0]!.observed.unitName,
          }),
        ]),
      ),
    );
    const it2 = h.fx.repos.requests.listItems(again.id)[0]!;
    expect(it2).toMatchObject({ linkState: 'auto', exportDecision: 'exclude', exportReason: 'approved-valid' });
    expect(it2.prior?.status).toBe('approved');
    // manual override, then revalidate keeps it
    await once(h, () =>
      h.svc.requests.setItemDecision({ itemId: it2.id, decision: 'manual-include', reason: 'new role' }),
    );
    await once(h, () => h.svc.requests.revalidate({ id: again.id }));
    expect(h.fx.repos.requests.getItem(it2.id)!.exportDecision).toBe('manual-include');
  });
});

describe('dashboard and expiry watch', () => {
  it('aging buckets, turnaround by kind, monthly counts, expiring windows, reviews', async () => {
    h = harness('2026-10-01T08:00:00.000Z');
    // file response: sent 2026-10-01, answered 2026-10-21 (20 days)
    const p = unwrap(await h.svc.requests.importFile('r.xlsx', fixtureBytes('requests/req-001-basic.xlsx')));
    const s = unwrap(await h.svc.requests.importCommit(commitHeader(p.previewId)));
    unwrap(await h.svc.requests.export({ requestId: s.id, mode: 'regenerate', destPath: '/o.xlsx' }));
    unwrap(await h.svc.requests.markSentToDc({ id: s.id }));
    h.setNow('2026-10-21T08:00:00.000Z');
    const pv = unwrap(
      await h.svc.responses.importFile('a.xlsx', fixtureBytes('responses/resp-001-all-approved.xlsx'), s.id),
    );
    unwrap(await h.svc.responses.importCommit({ previewId: pv.previewId, requestId: s.id }));
    // email responses: 4 and 10 days
    for (const [sent, days] of [
      ['2026-10-01T08:00:00.000Z', 4],
      ['2026-10-05T08:00:00.000Z', 10],
    ] as const) {
      h.setNow(sent);
      const { s: m, items } = await sentManual(h, 1, sent);
      h.setNow(new Date(Date.parse(sent) + days * 86_400_000).toISOString());
      unwrap(
        await h.svc.requests.markRespondedByEmail({
          requestId: m.id,
          itemIds: [items[0]!.id],
          certDate: '2026-10-20',
          expiresAt: null,
          disposition: 'approved',
          note: '',
        }),
      );
    }
    // outstanding: sent 3 and 20 days before "now"
    h.setNow('2026-11-03T08:00:00.000Z');
    await sentManual(h, 1, '2026-10-31T08:00:00.000Z');
    await sentManual(h, 1, '2026-10-14T08:00:00.000Z');
    const d = unwrap(await h.svc.stats.dashboard({})) as unknown as DashboardEx;
    expect(d.asOf).toBe('2026-11-03');
    expect(d.outstandingRequests).toHaveLength(2);
    expect(d.agingBuckets).toEqual({ '0-7': 1, '8-14': 0, '15-30': 1, '>30': 0 });
    expect(d.turnaroundByKind.file).toMatchObject({ count: 1, meanDays: 20, medianDays: 20 });
    expect(d.turnaroundByKind.email).toMatchObject({ count: 2, meanDays: 7, medianDays: 7, maxDays: 10 });
    expect(d.turnaround.count).toBe(3);
    expect(d.turnaround.medianDays).toBe(10);
    expect(d.perMonth).toHaveLength(12);
    expect(d.perMonth[11]!.month).toBe('2026-11');
    expect(d.perMonth[10]).toMatchObject({ month: '2026-10', responded: 3 });
    // email clearances (cert 2026-10-20 + 30 = 2026-11-19) expire within 30 days; DC ones next year
    expect(d.expiringWithin).toEqual({ d30: 2, d60: 2, d90: 2 });
    expect(d.counts.approved).toBe(6);
    expect(d.counts.expiring).toBe(2);
    expect(d.counts.pending).toBe(2);
    expect(d.openReviewItems).toBe(0);
    expect(d.expiringSoon).toHaveLength(2);

    const watch = unwrap(await h.svc.vetting.expiryWatch({ withinDays: 30 }));
    expect(watch).toHaveLength(2);
    expect(watch[0]).toMatchObject({ expiresAt: '2026-11-19', daysLeft: 16, expiryAssumed: true });

    const n = h.auditCount();
    expect(errCode(await h.svc.vetting.exportExpiryCsv({ password: 'nope', destPath: '/x.csv' }))).toBe(
      'BAD_CREDENTIALS',
    );
    expect(h.files.store.has('/x.csv')).toBe(false);
    expect(h.auditCount()).toBe(n);
    const csv = await once(h, () =>
      h.svc.vetting.exportExpiryCsv({ password: PASSWORD, destPath: '/x.csv', withinDays: 400 }),
    );
    expect(csv.count).toBe(8);
    const text = new TextDecoder().decode(h.files.store.get('/x.csv')!);
    expect(text.split('\r\n')[0]).toContain('"name","status","expires_at"');
  });

  it('csv cells neutralise formulas', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-1')).toBe(`"'-1"`);
    expect(csvCell(null)).toBe('""');
  });
});
