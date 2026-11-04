// End-to-end service flow on a real encrypted temp DB with the synthetic lane B fixtures.
import { afterEach, describe, expect, it } from 'vitest';
import { isConfidentSuggestion } from '@shared/domain/request-suggest';
import type { RequestSummary } from '@shared/ipc/contract';
import { parseInvestc } from '../../../src/main/formats/investc/parse';
import {
  storeTemplate,
  commitHeader,
  errCode,
  manualItem,
  manualRequest,
  fixtureBytes,
  fixtureJson,
  harness,
  once,
  unwrap,
} from './helpers';
import type { Harness } from './helpers';

let h: Harness;
afterEach(() => h?.cleanup());

async function importRequest(h: Harness, name: string, eventStart = '2026-11-20'): Promise<RequestSummary> {
  const p = unwrap(await h.svc.requests.importFile(`${name}.xlsx`, fixtureBytes(`requests/${name}.xlsx`)));
  expect(p.canCommit).toBe(true);
  return once(h, () => h.svc.requests.importCommit(commitHeader(p.previewId, eventStart)));
}

async function exportAndSend(h: Harness, id: string, sentAt: string): Promise<void> {
  const ex = await once(h, () =>
    h.svc.requests.export({ requestId: id, mode: 'filter-original', destPath: `/out/${id}.xlsx` }),
  );
  expect(ex.mode).toBe('filter-original');
  await once(h, () => h.svc.requests.markSentToDc({ id, at: sentAt }));
}

const personIdsOf = (h: Harness, requestId: string): string[] =>
  h.fx.repos.requests.listItems(requestId).map((i) => i.personId!);

describe('request import', () => {
  it('previews without writing, commits everything in one go, detects duplicates', async () => {
    h = harness();
    const bytes = fixtureBytes('requests/req-001-basic.xlsx');
    const p = unwrap(await h.svc.requests.importFile('req-001-basic.xlsx', bytes));
    expect(p.items).toHaveLength(6);
    expect(p.errorCount).toBe(0);
    expect(p.items.every((i) => i.linkState === 'new-person' && i.exportDecision === 'include')).toBe(true);
    for (const t of ['person', 'request', 'request_item', 'unit', 'stored_file', 'review_item', 'audit'])
      expect(h.count(t)).toBe(0);

    const s = await once(h, () => h.svc.requests.importCommit(commitHeader(p.previewId)));
    expect(s.itemCount).toBe(6);
    expect(s.unitCount).toBe(2);
    expect(s.status).toBe('validated');
    expect(h.count('person')).toBe(6);
    expect(h.count('unit')).toBe(2);
    expect(h.fx.repos.requests.get(s.id)!.sourceFile!.sha256).toBe(p.sha256);
    // a commit consumes the preview
    expect(errCode(await h.svc.requests.importCommit(commitHeader(p.previewId)))).toBe('PREVIEW_EXPIRED');

    const again = unwrap(await h.svc.requests.importFile('copy.xlsx', bytes));
    expect(again.duplicateOfRequestId).toBe(s.id);
    expect(again.canCommit).toBe(false);
    expect(errCode(await h.svc.requests.importCommit(commitHeader(again.previewId)))).toBe('CONFLICT');
  });

  it('a later request naming a known person auto-links and creates nobody new', async () => {
    h = harness();
    const a = await importRequest(h, 'req-001-basic');
    const known = h.fx.repos.requests.listItems(a.id).find((i) => i.observed.surname === 'Siarorikpon')!;
    const s = await once(h, () =>
      h.svc.requests.createManual(
        manualRequest([
          manualItem({
            surname: 'Siarorikpon',
            givenNames: ['Bachop'],
            dob: '1996-12-11',
            pobCountry: 'THAILAND',
            pobCity: 'Nojammat',
            nationality: 'THAILAND',
            unitName: 'Example Highway Patrol Unit 1',
            unitCountry: 'THAILAND',
          }),
        ]),
      ),
    );
    const item = h.fx.repos.requests.listItems(s.id)[0]!;
    expect(item.linkState).toBe('auto');
    expect(item.personId).toBe(known.personId);
    expect(h.count('person')).toBe(6);
    expect(item.prior?.status).toBe('unknown');
  });

  it('previews expire', async () => {
    h = harness();
    const p = unwrap(await h.svc.requests.importFile('r.xlsx', fixtureBytes('requests/req-001-basic.xlsx')));
    h.setNow('2026-11-03T10:00:00.000Z');
    expect(errCode(await h.svc.requests.importCommit(commitHeader(p.previewId)))).toBe('PREVIEW_EXPIRED');
  });

  it('error rows block the export until they are excluded', async () => {
    h = harness();
    const p = unwrap(await h.svc.requests.importFile('e.xlsx', fixtureBytes('requests/req-004-errors.xlsx')));
    expect(p.errorCount).toBeGreaterThan(0);
    expect(p.canCommit).toBe(true);
    const s = await once(h, () => h.svc.requests.importCommit(commitHeader(p.previewId)));
    expect(s.status).toBe('received');
    const r = await h.svc.requests.export({ requestId: s.id, mode: 'regenerate', destPath: '/out/e.xlsx' });
    expect(errCode(r)).toBe('EXPORT_BLOCKED');
    expect(h.files.store.size).toBe(0);
  });

  it('a non-xlsx file is refused at commit', async () => {
    h = harness();
    const p = unwrap(await h.svc.requests.importFile('x.xlsx', new TextEncoder().encode('not a workbook')));
    expect(p.canCommit).toBe(false);
    expect(errCode(await h.svc.requests.importCommit(commitHeader(p.previewId)))).toBe('FILE_INVALID');
    expect(h.count('request')).toBe(0);
  });
});

describe('export', () => {
  it('filters the original known template, stores the export and sets status', async () => {
    h = harness();
    const s = await importRequest(h, 'req-001-basic');
    const pv = unwrap(await h.svc.requests.exportPreview({ requestId: s.id, mode: 'filter-original' }));
    expect(pv.filterOriginalAvailable).toBe(true);
    expect(pv.includedCount).toBe(6);
    expect(pv.unitsWritten).toBe(2);
    expect(pv.blockingItemIds).toEqual([]);
    const ex = await once(h, () =>
      h.svc.requests.export({ requestId: s.id, mode: 'filter-original', destPath: '/out/a.xlsx' }),
    );
    expect(h.exporter.calls).toHaveLength(1);
    expect(h.exporter.calls[0]!.mode).toBe('filter-original');
    expect(h.exporter.calls[0]!.source).toBeInstanceOf(Uint8Array);
    expect(h.exporter.calls[0]!.people).toHaveLength(6);
    expect(h.files.store.get('/out/a.xlsx')).toBeDefined();
    expect(h.fx.repos.exports.get(ex.exportId)!.includedItemIds).toHaveLength(6);
    expect(h.fx.repos.requests.getHeader(s.id)!.status).toBe('exported');
    // regenerate when asked
    const ex2 = await once(h, () =>
      h.svc.requests.export({ requestId: s.id, mode: 'regenerate', destPath: '/out/b.xlsx' }),
    );
    expect(ex2.mode).toBe('regenerate');
    expect(h.exporter.calls[1]!.source).toBeUndefined();
  });

  it('manual requests (no source) always regenerate; excluded items are not written', async () => {
    h = harness();
    const s = await once(h, () =>
      h.svc.requests.createManual({
        requestor: { name: 'Requestor Placeholder', email: null, organisation: null },
        eventName: 'Manual',
        eventStart: null,
        eventEnd: null,
        eventLocation: null,
        sentToDcAt: null,
        notes: '',
        items: [
          {
            surname: 'Alphaname',
            givenNames: ['Synth'],
            dob: '1980-01-02',
            dobPrecision: 'exact',
            sex: 'F',
            unitName: 'Synthetic Unit One',
            unitType: 'Police',
            unitCountry: 'TESTLAND',
            pobCountry: 'TESTLAND',
            nationality: 'TESTLAND',
            isHeadOfUnit: true,
          },
          {
            surname: 'Betaname',
            givenNames: ['Synth'],
            dob: '1981-01-02',
            dobPrecision: 'exact',
            sex: 'M',
            unitName: 'Synthetic Unit One',
            unitType: 'Police',
            unitCountry: 'TESTLAND',
            pobCountry: 'TESTLAND',
            nationality: 'TESTLAND',
            isHeadOfUnit: false,
          },
        ],
      }),
    );
    const items = h.fx.repos.requests.listItems(s.id);
    await once(h, () =>
      h.svc.requests.setItemDecision({ itemId: items[1]!.id, decision: 'manual-exclude', reason: 'not attending' }),
    );
    // No original to filter and no template in the vault: an actionable error, nothing written.
    const missing = await h.svc.requests.export({ requestId: s.id, mode: 'filter-original', destPath: '/out/m.xlsx' });
    expect(errCode(missing)).toBe('TEMPLATE_MISSING');
    expect(missing.ok ? '' : missing.error.message).toMatch(/Settings > Templates/);
    expect(h.files.store.has('/out/m.xlsx')).toBe(false);
    const tpl = storeTemplate(h);
    expect(unwrap(await h.svc.requests.exportPreview({ requestId: s.id, mode: 'regenerate' })).templateAvailable).toBe(
      true,
    );
    const ex = await once(h, () =>
      h.svc.requests.export({ requestId: s.id, mode: 'filter-original', destPath: '/out/m.xlsx' }),
    );
    expect(ex.mode).toBe('regenerate');
    expect(h.exporter.calls[0]!.template).toEqual(tpl);
    expect(ex.includedCount).toBe(1);
    expect(h.exporter.calls[0]!.people.map((p) => p.surname)).toEqual(['Alphaname']);
  });
});

describe('request suggestion for a response file (UI review O-03)', () => {
  it('needs both a confident score and at least one matched person row', () => {
    expect(isConfidentSuggestion({ score: 0.06, matchedRows: 0 })).toBe(false);
    expect(isConfidentSuggestion({ score: 0.9, matchedRows: 0 })).toBe(false); // batch ID alone, nobody matches
    expect(isConfidentSuggestion({ score: 0.45, matchedRows: 4 })).toBe(false);
    expect(isConfidentSuggestion({ score: 0.5, matchedRows: 1 })).toBe(true);
    expect(isConfidentSuggestion(undefined)).toBe(false);
  });

  it('never suggests a request on which no response row matches anybody', async () => {
    h = harness();
    const s = await importRequest(h, 'req-001-basic');
    await exportAndSend(h, s.id, '2026-11-05T08:00:00.000Z');
    for (const f of ['resp-003-nonapproved', 'resp-004-thai', 'resp-008-mixed-script-names']) {
      const hint = unwrap(await h.svc.responses.importFile(`${f}.xlsx`, fixtureBytes(`responses/${f}.xlsx`)));
      const best = hint.requestCandidates[0];
      if (!best || best.matchedRows === 0) expect(hint.suggestedRequestId).toBeNull();
      else expect(hint.suggestedRequestId).toBe(isConfidentSuggestion(best) ? best.requestId : null);
      if (hint.previewId) await h.svc.responses.discardPreview({ previewId: hint.previewId });
    }
  });
});

describe('response flow', () => {
  it('all-approved: auto-links one-to-one, stores DC dates verbatim, marks responded, statuses approved', async () => {
    h = harness();
    const s = await importRequest(h, 'req-001-basic');
    await exportAndSend(h, s.id, '2026-11-05T08:00:00.000Z');
    const pids = personIdsOf(h, s.id);
    const pend = unwrap(await h.svc.vetting.statusOf(pids[0]!));
    expect(pend.status).toBe('pending');

    h.setNow('2026-11-25T08:00:00.000Z');
    const bytes = fixtureBytes('responses/resp-001-all-approved.xlsx');
    const hint = unwrap(await h.svc.responses.importFile('resp-001.xlsx', bytes));
    expect(hint.requestCandidates[0]!.requestId).toBe(s.id);
    expect(hint.matchedRequestId).toBeNull(); // never auto-chosen
    // UI review O-03: a suggestion needs a confident score AND matched person rows; this one has both.
    expect(hint.requestCandidates[0]!.matchedRows).toBeGreaterThan(0);
    expect(hint.suggestedRequestId).toBe(isConfidentSuggestion(hint.requestCandidates[0]) ? s.id : null);
    expect(h.count('response')).toBe(0);

    const pv = unwrap(await h.svc.responses.importFile('resp-001.xlsx', bytes, s.id));
    expect(pv.autoMatchedCount).toBe(6);
    expect(pv.needsReviewCount).toBe(0);
    expect(pv.unansweredItemIds).toEqual([]);
    const out = await once(h, () => h.svc.responses.importCommit({ previewId: pv.previewId, requestId: s.id }));
    expect(out.recordsCreated).toBe(8); // 6 individuals + 2 units
    expect(out.reviewItemsCreated).toBe(0);
    expect(out.responseDays).toBe(20);

    const req = h.fx.repos.requests.getHeader(s.id)!;
    expect(req.status).toBe('finished'); // every item answered => derived Finished (lane D)
    expect(req.responseKind).toBe('dc-file');
    expect(req.batchId).toBe('SYNTH-0000000001');
    for (const pid of pids) {
      const recs = h.fx.repos.vetting.listByPerson(pid);
      expect(recs).toHaveLength(1);
      expect(recs[0]).toMatchObject({
        disposition: 'approved',
        certDate: '2026-10-20',
        expiresAt: '2027-10-20',
        expiryAssumed: false,
        source: 'dc-file',
      });
      expect(unwrap(await h.svc.vetting.statusOf(pid)).status).toBe('approved');
    }
    const units = h.fx.repos.unitVetting.listByRequest(s.id);
    expect(units).toHaveLength(2);
    expect(units.every((u) => u.expiresAt === null)).toBe(true);
    // the named commander of unit 1 is linked
    expect(units.filter((u) => u.commanderPersonId !== null)).toHaveLength(1);
    // same file twice is refused
    const dup = unwrap(await h.svc.responses.importFile('again.xlsx', bytes, s.id));
    expect(dup.duplicateOfResponseId).toBe(out.response.id);
    expect(errCode(await h.svc.responses.importCommit({ previewId: dup.previewId, requestId: s.id }))).toBe('CONFLICT');
  });

  it('reformatted: swapped DOB and added particle stay pending review, never auto-linked', async () => {
    h = harness();
    const s = await importRequest(h, 'req-002-malay-particles');
    await exportAndSend(h, s.id, '2026-11-05T08:00:00.000Z');
    const pv = unwrap(
      await h.svc.responses.importFile('r2.xlsx', fixtureBytes('responses/resp-002-reformatted.xlsx'), s.id),
    );
    const tahus = pv.rows.find((r) => r.nameRaw.startsWith('Tahus'))!;
    expect(tahus.decision).toBe('pending');
    expect(tahus.chosenRequestItemId).toBeNull();
    expect(tahus.candidates[0]!.evidence).toContain('DOB_SWAPPED');
    const lishair = pv.rows.find((r) => r.nameRaw.startsWith('Lishair'))!;
    expect(lishair.decision).toBe('pending');
    expect(pv.autoMatchedCount).toBe(4);
    const moved = pv.rows.find((r) => r.nameRaw.startsWith('Mated'))!;
    expect(moved.decision).toBe('auto'); // surname moved but full token set equal

    const out = await once(h, () => h.svc.responses.importCommit({ previewId: pv.previewId, requestId: s.id }));
    expect(out.recordsCreated).toBe(5); // 4 individuals + 1 unit
    const reviews = h.fx.repos.reviews.list({ offset: 0, limit: 50, state: 'open' }).items;
    expect(reviews.map((r) => r.kind).sort()).toEqual(['response-row-match', 'response-row-match']);

    const items = h.fx.repos.requests.listItems(s.id);
    const tahusItem = items.find((i) => i.observed.surname === 'Tahus')!;
    expect(h.fx.repos.vetting.listByPerson(tahusItem.personId!)).toHaveLength(0);
    expect(unwrap(await h.svc.vetting.statusOf(tahusItem.personId!)).status).toBe('unknown');
    // the unit expiry is the short one stated by the DC
    expect(h.fx.repos.unitVetting.listByRequest(s.id)[0]!.expiresAt).toBe('2027-01-18');

    // reviewer confirms the swapped-DOB row: record is created as stated
    const rowId = h.fx.repos.responses.listRows(out.response.id).find((r) => r.nameRaw.startsWith('Tahus'))!.id;
    const rev = reviews.find((r) => r.subjectIds[0] === rowId)!;
    const detail = unwrap(await h.svc.review.get({ id: rev.id }));
    expect(detail.subjects.map((x) => x.kind).sort()).toEqual(['request-item', 'response-row']);
    const counts = await once(h, () =>
      h.svc.review.resolve({ id: rev.id, resolution: { action: 'link', targetId: tahusItem.id } }),
    );
    expect(counts.open).toBe(1);
    const rec = h.fx.repos.vetting.listByPerson(tahusItem.personId!);
    expect(rec).toHaveLength(1);
    expect(rec[0]!.expiresAt).toBe('2027-10-20');
    // the other one: reviewer says it is nobody on the list
    const other = h.fx.repos.reviews.list({ offset: 0, limit: 50, state: 'open' }).items[0]!;
    await once(h, () => h.svc.review.resolve({ id: other.id, resolution: { action: 'not-same' } }));
    const lishairItem = items.find((i) => i.observed.surname === 'Lishair')!;
    expect(h.fx.repos.negativePairs.has(other.subjectIds[0]!, lishairItem.id)).toBe(true);
    expect(h.fx.repos.reviews.counts().byKind['unmatched-response-row']).toBe(1);
  });

  it('explicit decisions: item, new person, skip; one item cannot take two rows', async () => {
    h = harness();
    const s = await importRequest(h, 'req-002-malay-particles');
    await exportAndSend(h, s.id, '2026-11-05T08:00:00.000Z');
    const pv = unwrap(
      await h.svc.responses.importFile('r2.xlsx', fixtureBytes('responses/resp-002-reformatted.xlsx'), s.id),
    );
    const idOf = (prefix: string): string => pv.rowIds[pv.rows.findIndex((r) => r.nameRaw.startsWith(prefix))]!;
    const items = h.fx.repos.requests.listItems(s.id);
    const tahusItem = items.find((i) => i.observed.surname === 'Tahus')!;
    const matedItem = items.find((i) => i.observed.name1 === 'Mated')!;
    expect(
      errCode(
        await h.svc.responses.importCommit({
          previewId: pv.previewId,
          requestId: s.id,
          decisions: { [idOf('Tahus')]: matedItem.id },
        }),
      ),
    ).toBe('BAD_REQUEST');
    const persons = h.count('person');
    const out = await once(h, () =>
      h.svc.responses.importCommit({
        previewId: pv.previewId,
        requestId: s.id,
        decisions: { [idOf('Tahus')]: tahusItem.id, [idOf('Lishair')]: 'new' },
      }),
    );
    expect(out.recordsCreated).toBe(7);
    expect(h.count('person')).toBe(persons + 1); // only the explicit 'new'
    // the Lishair request item was not answered by any committed row
    expect(h.fx.repos.reviews.counts().byKind['unanswered-request-item']).toBe(1);
  });

  it('Thai script names auto-link', async () => {
    h = harness();
    const s = await importRequest(h, 'req-003-thai-script');
    await exportAndSend(h, s.id, '2026-11-05T08:00:00.000Z');
    const pv = unwrap(await h.svc.responses.importFile('r4.xlsx', fixtureBytes('responses/resp-004-thai.xlsx'), s.id));
    expect(pv.autoMatchedCount).toBe(6);
    const out = await once(h, () => h.svc.responses.importCommit({ previewId: pv.previewId, requestId: s.id }));
    expect(out.reviewItemsCreated).toBe(0);
    for (const pid of personIdsOf(h, s.id)) expect(unwrap(await h.svc.vetting.statusOf(pid)).status).toBe('approved');
  });

  it('non-approved section yields non-approved status; unknown section warns and its row goes to review', async () => {
    h = harness();
    const s = await importRequest(h, 'req-001-basic');
    await exportAndSend(h, s.id, '2026-11-05T08:00:00.000Z');
    const pv = unwrap(
      await h.svc.responses.importFile('r3.xlsx', fixtureBytes('responses/resp-003-nonapproved.xlsx'), s.id),
    );
    await once(h, () => h.svc.responses.importCommit({ previewId: pv.previewId, requestId: s.id }));
    const items = h.fx.repos.requests.listItems(s.id);
    const t = items.find((i) => i.observed.surname === 'Thaikhamum')!;
    expect(unwrap(await h.svc.vetting.statusOf(t.personId!)).status).toBe('non-approved');
    // R-15 then warns on a later request naming this person, and policy excludes them
    // Owner decision (PLAN-ALPHA section 17.1): an unknown section label warns; rows are classified by DISP and an
    // unclear one ("Pending") becomes a disposition-unclear review item with no vetting record.
    const unk = unwrap(
      await h.svc.responses.importFile('r5.xlsx', fixtureBytes('responses/resp-005-unknown-section.xlsx'), s.id),
    );
    expect(unk.canCommit).toBe(true);
    expect(unk.issues.find((i) => i.message.includes('UNKNOWN_SECTION'))?.severity).toBe('warning');
    const pending = unk.rows.find((r) => r.disp === 'Pending')!;
    expect(pending.dispClass).toBe('unknown');
    await once(h, () => h.svc.responses.importCommit({ previewId: unk.previewId, requestId: s.id }));
    const unclear = h.fx.repos.reviews.openForSubject(pending.rowId).filter((r) => r.kind === 'disposition-unclear');
    expect(unclear).toHaveLength(1);
    expect(h.fx.repos.vetting.listByResponseRow(pending.rowId)).toEqual([]);
    // A request workbook picked in the response importer cannot be committed.
    const bad = unwrap(
      await h.svc.responses.importFile('r11.xlsx', fixtureBytes('responses/resp-011-request-workbook.xlsx'), s.id),
    );
    expect(bad.canCommit).toBe(false);
    expect(bad.fileKindGuess).toBe('investc-request');
    expect(errCode(await h.svc.responses.importCommit({ previewId: bad.previewId, requestId: s.id }))).toBe(
      'FILE_INVALID',
    );
  });
});

describe('undo and atomicity', () => {
  it('undo cascades response then request back to an empty database (audit kept)', async () => {
    h = harness();
    const s = await importRequest(h, 'req-001-basic');
    await exportAndSend(h, s.id, '2026-11-05T08:00:00.000Z');
    const pv = unwrap(
      await h.svc.responses.importFile('r.xlsx', fixtureBytes('responses/resp-001-all-approved.xlsx'), s.id),
    );
    const out = await once(h, () => h.svc.responses.importCommit({ previewId: pv.previewId, requestId: s.id }));

    expect(errCode(await h.svc.requests.undoImport({ id: s.id }))).toBe('CONFLICT');
    const u = await once(h, () => h.svc.responses.undoImport({ id: out.response.id }));
    expect(u.recordsDeleted).toBe(6);
    expect(u.unitRecordsDeleted).toBe(2);
    expect(h.count('response')).toBe(0);
    expect(h.count('vetting_record')).toBe(0);
    const req = h.fx.repos.requests.getHeader(s.id)!;
    expect(req.status).toBe('sent-to-dc');
    expect(req.respondedAt).toBeNull();
    expect(req.sentToDcAt).toBe('2026-11-05T08:00:00.000Z');

    const r = await once(h, () => h.svc.requests.undoImport({ id: s.id }));
    expect(r.personsDeleted).toHaveLength(6);
    expect(r.unitsDeleted).toHaveLength(2);
    for (const t of [
      'person',
      'person_alias',
      'identifier',
      'unit',
      'request',
      'request_item',
      'stored_file',
      'export',
      'review_item',
    ])
      expect(h.count(t)).toBe(0);
    expect(h.audit.verifyChain().ok).toBe(true);
  });

  it('undo with includeResponses removes everything in one step', async () => {
    h = harness();
    const s = await importRequest(h, 'req-001-basic');
    await exportAndSend(h, s.id, '2026-11-05T08:00:00.000Z');
    const pv = unwrap(
      await h.svc.responses.importFile('r.xlsx', fixtureBytes('responses/resp-001-all-approved.xlsx'), s.id),
    );
    await once(h, () => h.svc.responses.importCommit({ previewId: pv.previewId, requestId: s.id }));
    await once(h, () => h.svc.requests.undoImport({ id: s.id, includeResponses: true }));
    for (const t of [
      'person',
      'person_alias',
      'unit',
      'request',
      'response',
      'response_row',
      'vetting_record',
      'unit_vetting_record',
      'stored_file',
    ])
      expect(h.count(t)).toBe(0);
  });

  it('a failing step rolls the whole commit back (request import, response import, export)', async () => {
    h = harness();
    const p = unwrap(await h.svc.requests.importFile('r.xlsx', fixtureBytes('requests/req-001-basic.xlsx')));
    h.fault.step = 'requests.importCommit';
    expect(errCode(await h.svc.requests.importCommit(commitHeader(p.previewId)))).toBe('INTERNAL');
    for (const t of ['person', 'unit', 'request', 'request_item', 'stored_file', 'review_item', 'audit'])
      expect(h.count(t)).toBe(0);
    h.fault.step = null;
    const s = await once(h, () => h.svc.requests.importCommit(commitHeader(p.previewId)));

    h.fault.step = 'requests.export';
    expect(errCode(await h.svc.requests.export({ requestId: s.id, mode: 'regenerate', destPath: '/out/x.xlsx' }))).toBe(
      'INTERNAL',
    );
    expect(h.count('export')).toBe(0);
    expect(h.files.store.has('/out/x.xlsx')).toBe(false);
    expect(h.fx.repos.requests.getHeader(s.id)!.status).toBe('validated');
    h.fault.step = null;
    await exportAndSend(h, s.id, '2026-11-05T08:00:00.000Z');

    const pv = unwrap(
      await h.svc.responses.importFile('r.xlsx', fixtureBytes('responses/resp-001-all-approved.xlsx'), s.id),
    );
    const audits = h.auditCount();
    h.fault.step = 'responses.importCommit';
    expect(errCode(await h.svc.responses.importCommit({ previewId: pv.previewId, requestId: s.id }))).toBe('INTERNAL');
    for (const t of ['response', 'response_row', 'vetting_record', 'unit_vetting_record']) expect(h.count(t)).toBe(0);
    expect(h.count('stored_file')).toBe(2); // request source + export; the response blob rolled back
    expect(h.fx.repos.requests.getHeader(s.id)!.status).toBe('sent-to-dc');
    expect(h.auditCount()).toBe(audits);
    h.fault.step = null;
    await once(h, () => h.svc.responses.importCommit({ previewId: pv.previewId, requestId: s.id }));
  });
});

describe('audit hygiene', () => {
  it('no audit detail carries personal data from the fixtures', async () => {
    h = harness();
    const s = await importRequest(h, 'req-002-malay-particles');
    await exportAndSend(h, s.id, '2026-11-05T08:00:00.000Z');
    const pv = unwrap(
      await h.svc.responses.importFile('r2.xlsx', fixtureBytes('responses/resp-002-reformatted.xlsx'), s.id),
    );
    await once(h, () => h.svc.responses.importCommit({ previewId: pv.previewId, requestId: s.id }));
    const r = h.fx.repos.reviews.list({ offset: 0, limit: 10, state: 'open' }).items[0]!;
    await once(h, () => h.svc.review.resolve({ id: r.id, resolution: { action: 'dismiss' } }));
    const spec = fixtureJson<{
      people: {
        surname: string;
        name1: string;
        passport: string;
        nationalId: string;
        dob: { parsed: string | null; value: string };
      }[];
    }>('requests/req-002-malay-particles.expected.json');
    const needles = spec.people
      .flatMap((p) => [p.surname, p.name1, p.passport, p.nationalId, p.dob.parsed ?? '', p.dob.value])
      .filter((x) => x.length >= 4)
      .map((x) => x.toLowerCase());
    const events = h.audit.list({ offset: 0, limit: 500 }).items;
    expect(events.length).toBeGreaterThanOrEqual(5);
    for (const e of events) {
      const text = JSON.stringify(e.details).toLowerCase();
      for (const n of needles) expect(text.includes(n), `${e.type} leaks a fixture value`).toBe(false);
    }
    expect(h.audit.verifyChain().ok).toBe(true);
  });
});

describe('remaining mutators audit exactly once', () => {
  it('update, setStatus, setRowMatch, recordManual, remove', async () => {
    h = harness();
    const s = await importRequest(h, 'req-002-malay-particles');
    await once(h, () => h.svc.requests.update({ id: s.id, patch: { notes: 'n', batchId: 'SYNTH-X' } }));
    await once(h, () => h.svc.requests.setStatus({ id: s.id, status: 'sent-to-dc', at: '2026-11-04T00:00:00.000Z' }));
    const pv = unwrap(
      await h.svc.responses.importFile('r2.xlsx', fixtureBytes('responses/resp-002-reformatted.xlsx'), s.id),
    );
    const out = await once(h, () => h.svc.responses.importCommit({ previewId: pv.previewId, requestId: s.id }));
    const rows = h.fx.repos.responses.listRows(out.response.id);
    const tahusRow = rows.find((r) => r.nameRaw.startsWith('Tahus'))!;
    const tahusItem = h.fx.repos.requests.listItems(s.id).find((i) => i.observed.surname === 'Tahus')!;
    const linked = await once(h, () =>
      h.svc.responses.setRowMatch({ rowId: tahusRow.id, chosen: tahusItem.id, decision: 'confirmed' }),
    );
    expect(linked.match.decision).toBe('confirmed');
    expect(h.fx.repos.vetting.listByResponseRow(tahusRow.id)).toHaveLength(1);
    await once(h, () => h.svc.responses.setRowMatch({ rowId: tahusRow.id, chosen: null, decision: 'rejected' }));
    expect(h.fx.repos.vetting.listByResponseRow(tahusRow.id)).toHaveLength(0);
    const rec = await once(h, () =>
      h.svc.responses.recordManual({
        personId: tahusItem.personId!,
        unitId: null,
        disposition: 'approved',
        certDate: '2026-11-01',
        expiresAt: '2027-11-01',
        note: '',
      }),
    );
    expect(h.fx.repos.vetting.get(rec.recordIds[0]!)!.source).toBe('manual');
    expect(errCode(await h.svc.requests.remove({ id: s.id }))).toBe('CONFLICT');
    await once(h, () => h.svc.responses.undoImport({ id: out.response.id }));
    // the manual record keeps the person alive; request removal still succeeds
    await once(h, () => h.svc.requests.remove({ id: s.id }));
    expect(h.fx.repos.persons.get(tahusItem.personId!)).not.toBeNull();
    expect(h.audit.verifyChain().ok).toBe(true);
  });
});

describe('export templates kept in the vault', () => {
  it('the first valid import captures a sanitised blank template; later imports do not replace it', async () => {
    h = harness();
    expect(unwrap(await h.svc.templates.list()).active).toBeNull();
    const a = await importRequest(h, 'req-001-basic');
    expect(a.templateCaptured).toMatchObject({ source: 'auto-capture', templateVersion: '1.11.0', active: true });
    expect(a.templateCaptured!.originalName).toBe('req-001-basic.xlsx');
    const ev = h.audit.list({ offset: 0, limit: 5 }).items.find((e) => e.type === 'request.import')!;
    expect(ev.details).toMatchObject({ action: 'template-captured', templateVersion: '1.11.0' });
    const bytes = h.fx.repos.templates.content(a.templateCaptured!.id)!;
    const blank = parseInvestc(bytes);
    expect(blank.units).toEqual([]);
    expect(blank.people).toEqual([]);
    const txt = Buffer.from(bytes).toString('latin1');
    expect(txt).not.toContain('Siarorikpon'); // compressed anyway; the parse above is the real check
    const b = await importRequest(h, 'req-003-thai-script');
    expect(b.templateCaptured).toBeUndefined();
    const list = unwrap(await h.svc.templates.list());
    expect(list.active!.id).toBe(a.templateCaptured!.id);
    expect(list.history).toEqual([]);
  });

  it('an unknown-version file is imported but not captured', async () => {
    h = harness();
    const s = await importRequest(h, 'req-008-unknown-version');
    expect(s.templateCaptured).toBeUndefined();
    expect(unwrap(await h.svc.templates.list()).active).toBeNull();
    // ...and its export then cannot fall back: actionable error
    const r = await h.svc.requests.export({ requestId: s.id, mode: 'filter-original', destPath: '/out/x.xlsx' });
    expect(errCode(r)).toBe('TEMPLATE_MISSING');
  });

  it('manual import replaces the active template, keeps history, and can re-activate or remove', async () => {
    h = harness();
    await importRequest(h, 'req-001-basic');
    h.files.store.set('/in/blank.xlsx', fixtureBytes('requests/req-002-malay-particles.xlsx'));
    const imp = await once(h, () => h.svc.templates.import({ path: '/in/blank.xlsx' }));
    expect(imp.template).toMatchObject({ source: 'manual', originalName: 'blank.xlsx', active: true });
    expect(imp.list.history).toHaveLength(1);
    expect(imp.list.history[0]!.replacedAt).not.toBeNull();
    const old = imp.list.history[0]!.id;
    const back = await once(h, () => h.svc.templates.setActive({ id: old }));
    expect(back.active!.id).toBe(old);
    expect(back.history.map((t) => t.id)).toEqual([imp.template.id]);
    const gone = await once(h, () => h.svc.templates.remove({ id: old }));
    expect(gone.active).toBeNull();
    expect(gone.history).toHaveLength(1);
    expect(errCode(await h.svc.templates.remove({ id: old }))).toBe('NOT_FOUND');
    h.files.store.set('/in/bad.xlsx', fixtureBytes('responses/resp-001-all-approved.xlsx'));
    const bad = await h.svc.templates.import({ path: '/in/bad.xlsx' });
    expect(errCode(bad)).toBe('FILE_INVALID');
    expect(bad.ok ? '' : bad.error.message).toMatch(/cannot be used as a template/);
    expect(errCode(await h.svc.templates.import({ path: '/in/missing.xlsx' }))).toBe('FILE_UNREADABLE');
  });

  it('regenerate passes the vault template to the exporter; without one it fails before writing', async () => {
    h = harness();
    const s = await importRequest(h, 'req-001-basic');
    const list = unwrap(await h.svc.templates.list());
    await once(h, () => h.svc.templates.remove({ id: list.active!.id }));
    const r = await h.svc.requests.export({ requestId: s.id, mode: 'regenerate', destPath: '/out/r.xlsx' });
    expect(errCode(r)).toBe('TEMPLATE_MISSING');
    expect(r.ok ? '' : r.error.message).toMatch(/filter the original/);
    expect(h.exporter.calls).toHaveLength(0);
    const tpl = storeTemplate(h);
    const ex = await once(h, () =>
      h.svc.requests.export({ requestId: s.id, mode: 'regenerate', destPath: '/out/r.xlsx' }),
    );
    expect(ex.mode).toBe('regenerate');
    expect(h.exporter.calls[0]!.template).toEqual(tpl);
  });
});
