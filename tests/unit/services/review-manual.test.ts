// review.manualValidate / review.editSubject / set-disposition / list context (lane K, R12). Synthetic data only.
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { AUDIT_DETAIL_KEYS } from '../../../src/main/services/audit';
import { errCode, harness, once, unwrap } from './helpers';
import type { Harness } from './helpers';
import { identityState, personNamed, requestWithItem, responseWithRows, rowInput } from './review-fixtures';

let h: Harness;
afterEach(() => h?.cleanup());

const REASON = 'DC answer confirmed by phone';
const lastAudit = () =>
  h.fx.db.prepare('SELECT type, details_json FROM audit ORDER BY seq DESC LIMIT 1').get() as {
    type: string;
    details_json: string;
  };
/** Every stored column of a row that a correction may touch (byte comparison for revert). */
const rowColumns = (id: string) =>
  h.fx.db
    .prepare(
      'SELECT name_raw, surname, given_json, core_key, dob, dob_raw, pob_city, pob_state, pob_country, unit_name, cert_date, expires, detail_json FROM response_row WHERE id = ?',
    )
    .get(id);

describe('review.manualValidate', () => {
  it('links the row to the chosen person and creates exactly one record from the row values', async () => {
    h = harness();
    const p = personNamed(h, 'Validsurname', ['Person']);
    const { reviews, rows } = responseWithRows(h, [rowInput('NOMATCH, Typo', { section: 'nonapproved-individual' })]);
    const counts = await once(h, () =>
      h.svc.review.manualValidate({ id: reviews[0]!.id, target: { kind: 'person', personId: p.id }, reason: REASON }),
    );
    expect(counts.open).toBe(0);
    const recs = h.fx.repos.vetting.listByResponseRow(rows[0]!.id);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      personId: p.id,
      disposition: 'non-approved',
      certDate: '2026-10-20',
      expiresAt: '2027-10-20',
      source: 'dc-file',
    });
    const row = h.fx.repos.responses.getRow(rows[0]!.id)!;
    expect(row.match).toMatchObject({ decision: 'confirmed', decidedBy: 'local-user' });
    expect(h.fx.repos.responses.rowLinks(row.id)).toEqual({ requestItemId: null, personId: p.id });
    const item = h.fx.repos.reviews.get(reviews[0]!.id)!;
    expect(item).toMatchObject({ state: 'resolved', resolution: 'manual-validate' });
    expect(h.fx.repos.reviews.resolutionNote(item.id)).toBe(REASON);

    const a = lastAudit();
    expect(a.type).toBe('review.manual-validate');
    const d = JSON.parse(a.details_json) as Record<string, unknown>;
    expect(d).toMatchObject({
      reviewItemId: item.id,
      rowId: row.id,
      targetKind: 'person',
      personId: p.id,
      disposition: 'non-approved',
      reasonLength: REASON.length,
    });
    for (const k of Object.keys(d)) expect(AUDIT_DETAIL_KEYS.has(k)).toBe(true);
    expect(a.details_json).not.toContain('phone');
    expect(a.details_json).not.toContain('NOMATCH');
    expect(h.audit.verifyChain()).toMatchObject({ ok: true });
  });

  it('creates a new person from the row when asked', async () => {
    h = harness();
    const { reviews, rows } = responseWithRows(h, [rowInput('BRANDNEW, Person')]);
    const before = h.count('person');
    await once(h, () =>
      h.svc.review.manualValidate({ id: reviews[0]!.id, target: { kind: 'new-person' }, reason: REASON }),
    );
    expect(h.count('person')).toBe(before + 1);
    const recs = h.fx.repos.vetting.listByResponseRow(rows[0]!.id);
    expect(recs).toHaveLength(1);
    expect(h.fx.repos.persons.get(recs[0]!.personId)!.canonical.surname).toBe('BRANDNEW');
  });

  it('validates against a request item: links the item and records with its unit', async () => {
    h = harness();
    const { req, item, unit } = requestWithItem(h);
    const { reviews, rows } = responseWithRows(h, [rowInput('TYPOSURNAME, Synthetic')], { requestId: req.id });
    await once(h, () =>
      h.svc.review.manualValidate({
        id: reviews[0]!.id,
        target: { kind: 'request-item', itemId: item.id },
        reason: REASON,
      }),
    );
    const linked = h.fx.repos.requests.getItem(item.id)!;
    expect(linked.personId).not.toBeNull();
    const recs = h.fx.repos.vetting.listByResponseRow(rows[0]!.id);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ personId: linked.personId, unitId: unit.id, requestId: req.id });
    expect(h.fx.repos.responses.rowLinks(rows[0]!.id)).toEqual({ requestItemId: item.id, personId: linked.personId });
  });

  it('refuses a missing or short reason, an unknown disposition and a linked row, changing nothing', async () => {
    h = harness();
    const p = personNamed(h, 'Validsurname', ['Person']);
    const { reviews, rows } = responseWithRows(h, [rowInput('NOMATCH, One'), rowInput('NOMATCH, Two')]);
    const before = identityState(h);
    const target = { kind: 'person' as const, personId: p.id };
    expect(errCode(await h.svc.review.manualValidate({ id: reviews[0]!.id, target, reason: '' }))).toBe(
      'REASON_REQUIRED',
    );
    expect(errCode(await h.svc.review.manualValidate({ id: reviews[0]!.id, target, reason: '  ab ' }))).toBe(
      'REASON_REQUIRED',
    );
    const unknown = h.fx.repos.responses.getRow(rows[1]!.id)!;
    h.fx.repos.responses.correctRow(unknown.id, { ...unknown, dispClass: 'unknown' });
    const b2 = identityState(h);
    expect(errCode(await h.svc.review.manualValidate({ id: reviews[1]!.id, target, reason: REASON }))).toBe(
      'BAD_REQUEST',
    );
    expect(identityState(h)).toEqual(b2);
    expect(before.audit).toBe(b2.audit);
    unwrap(await h.svc.review.manualValidate({ id: reviews[0]!.id, target, reason: REASON }));
    expect(errCode(await h.svc.review.manualValidate({ id: reviews[0]!.id, target, reason: REASON }))).toBe('CONFLICT');
    expect(h.fx.repos.vetting.listByResponseRow(rows[0]!.id)).toHaveLength(1);
  });
});

describe('review.editSubject', () => {
  it('corrects a DOB typo: keeps the DC original, records the edit, candidates reappear but never auto-link', async () => {
    h = harness();
    const { req, item } = requestWithItem(h);
    const typo = { kind: 'text' as const, value: '1990-12-03', parsed: '1990-12-03', ambiguousDayMonth: false };
    const { reviews, rows } = responseWithRows(h, [rowInput('TESTSURNAME, Synthetic', { dob: typo })], {
      requestId: req.id,
    });
    const rowId = rows[0]!.id;
    const original = rowColumns(rowId);
    const detail = await once(h, () =>
      h.svc.review.editSubject({
        id: reviews[0]!.id,
        subject: { kind: 'response-row', rowId, patch: { dob: '1990-03-12' } },
        reason: 'DC typo in the DOB',
      }),
    );
    const subj = detail.subjects.find((s) => s.id === rowId)!;
    expect(subj).toMatchObject({ dob: '1990-03-12', edited: true, original: { dob: '1990-12-03' } });
    expect(h.fx.repos.responses.originalRow(rowId)!.dob.parsed).toBe('1990-12-03');
    const edits = h.fx.repos.responses.listEdits(rowId);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({
      reason: 'DC typo in the DOB',
      diff: { dob: { from: '1990-12-03', to: '1990-03-12' } },
    });

    const row = h.fx.repos.responses.getRow(rowId)!;
    expect(row.match.candidates.map((c) => c.targetId)).toContain(item.id);
    expect(row.match).toMatchObject({ decision: 'pending', chosen: null, decidedBy: null });
    expect(h.fx.repos.responses.rowLinks(rowId)).toEqual({ requestItemId: null, personId: null });
    expect(h.fx.repos.vetting.listByResponseRow(rowId)).toHaveLength(0);
    expect(h.fx.repos.reviews.get(reviews[0]!.id)!.candidates.map((c) => c.targetId)).toContain(item.id);
    const a = lastAudit();
    expect(a.type).toBe('review.edit-subject');
    expect(JSON.parse(a.details_json)).toMatchObject({
      subjectKind: 'response-row',
      rowId,
      fields: 'dob',
      action: 'edit',
    });
    expect(a.details_json).not.toContain('1990');

    // then validate against the item with a reason
    await once(h, () =>
      h.svc.review.manualValidate({
        id: reviews[0]!.id,
        target: { kind: 'request-item', itemId: item.id },
        reason: REASON,
      }),
    );
    expect(h.fx.repos.vetting.listByResponseRow(rowId)).toHaveLength(1);
    // edits are refused once the row has a confirmed record
    expect(
      errCode(
        await h.svc.review.editSubject({
          id: reviews[0]!.id,
          subject: { kind: 'response-row', rowId, patch: { unitName: 'Other' } },
          reason: REASON,
        }),
      ),
    ).toBe('CONFLICT');
    expect(original).toBeTruthy();
  });

  it('an empty patch reverts to the DC original byte for byte (audited)', async () => {
    h = harness();
    const { reviews, rows } = responseWithRows(h, [rowInput('TESTSURNAEM, Synthetic')]);
    const rowId = rows[0]!.id;
    const original = rowColumns(rowId);
    const id = reviews[0]!.id;
    unwrap(
      await h.svc.review.editSubject({
        id,
        subject: { kind: 'response-row', rowId, patch: { nameRaw: 'TESTSURNAME, Synthetic', unitName: 'Fixed Unit' } },
        reason: 'name typo',
      }),
    );
    unwrap(
      await h.svc.review.editSubject({
        id,
        subject: { kind: 'response-row', rowId, patch: { certDate: '2026-10-21', dispClass: 'non-approved' } },
        reason: 'second fix',
      }),
    );
    expect(rowColumns(rowId)).not.toEqual(original);
    expect(h.fx.repos.responses.getRow(rowId)!.dispClass).toBe('non-approved');
    // the original is from the first edit only
    expect(h.fx.repos.responses.originalRow(rowId)!.nameRaw).toBe('TESTSURNAEM, Synthetic');
    const d = await once(h, () =>
      h.svc.review.editSubject({ id, subject: { kind: 'response-row', rowId, patch: {} }, reason: 'undo all' }),
    );
    expect(rowColumns(rowId)).toEqual(original);
    expect(d.subjects[0]!.edited).toBe(false);
    expect(h.fx.repos.responses.listEdits(rowId)).toHaveLength(3);
    expect(JSON.parse(lastAudit().details_json)).toMatchObject({ action: 'revert' });
    expect(
      errCode(
        await h.svc.review.editSubject({ id, subject: { kind: 'response-row', rowId, patch: {} }, reason: 'again' }),
      ),
    ).toBe('BAD_REQUEST');
  });

  it('corrects the linked person with provenance; refuses persons outside the item and a short reason', async () => {
    h = harness();
    const p = personNamed(h, 'Personsurname', ['Edit']);
    const stranger = personNamed(h, 'Stranger', ['Other']);
    const { rows } = responseWithRows(h, [rowInput('PERSONSURNAME, Edit')], { kind: 'response-row-match' });
    const item = h.fx.repos.reviews.insert({
      kind: 'response-row-match',
      subjectIds: [rows[0]!.id],
      candidates: [{ targetKind: 'person', targetId: p.id, tier: 'T2', evidence: ['NAME_CORE_EQUAL'], score: 0.8 }],
    });
    const patch = { dob: '1990-03-21' };
    const d = await once(h, () =>
      h.svc.review.editSubject({
        id: item.id,
        subject: { kind: 'person', personId: p.id, patch },
        reason: 'wrong DOB',
      }),
    );
    expect(h.fx.repos.persons.get(p.id)!.dob).toBe('1990-03-21');
    expect(d.subjects.find((s) => s.id === p.id)).toMatchObject({ edited: true, original: { dob: '1990-03-12' } });
    const pe = h.fx.db.prepare('SELECT reason, diff_json FROM person_edit WHERE person_id = ?').all(p.id) as {
      reason: string;
      diff_json: string;
    }[];
    expect(pe).toHaveLength(1);
    expect(pe[0]!.reason).toBe('wrong DOB');
    expect(
      errCode(
        await h.svc.review.editSubject({
          id: item.id,
          subject: { kind: 'person', personId: stranger.id, patch },
          reason: 'not mine',
        }),
      ),
    ).toBe('BAD_REQUEST');
    expect(
      errCode(
        await h.svc.review.editSubject({
          id: item.id,
          subject: { kind: 'person', personId: p.id, patch },
          reason: 'x',
        }),
      ),
    ).toBe('REASON_REQUIRED');
  });

  it('property: no sequence of corrections and reverts ever links a row or creates a record', async () => {
    h = harness();
    const { req } = requestWithItem(h);
    personNamed(h, 'Testsurname', ['Synthetic']);
    const { reviews, rows } = responseWithRows(h, [rowInput('TESTSURNAME, Synthetic')], { requestId: req.id });
    const rowId = rows[0]!.id;
    const patchArb = fc.oneof(
      fc.constant({}),
      fc.record(
        {
          nameRaw: fc.constantFrom('TESTSURNAME, Synthetic', 'Synthetic Testsurname', 'OTHER, Name', 'สมชาย, ใจดี'),
          dob: fc.constantFrom('1990-03-12', '1990-12-03', null),
          unitName: fc.constantFrom('Synthetic Unit One', 'Elsewhere'),
          dispClass: fc.constantFrom('approved' as const, 'non-approved' as const),
        },
        { requiredKeys: [] },
      ),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(patchArb, { minLength: 1, maxLength: 6 }), async (patches) => {
        for (const patch of patches)
          await h.svc.review.editSubject({
            id: reviews[0]!.id,
            subject: { kind: 'response-row', rowId, patch },
            reason: 'property step',
          });
        const row = h.fx.repos.responses.getRow(rowId)!;
        expect(['pending', 'none']).toContain(row.match.decision);
        expect(row.match.chosen).toBeNull();
        expect(h.fx.repos.responses.rowLinks(rowId)).toEqual({ requestItemId: null, personId: null });
        expect(h.count('vetting_record')).toBe(0);
        expect(h.fx.repos.requests.get(req.id)!.items.every((i) => i.personId === null)).toBe(true);
      }),
      { numRuns: 25 },
    );
    expect(h.audit.verifyChain()).toMatchObject({ ok: true });
  });
});

describe('set-disposition and list context', () => {
  it('a disposition-unclear row gets the stated disposition, the DC original kept', async () => {
    h = harness();
    const { reviews, rows } = responseWithRows(h, [rowInput('UNCLEAR, Disp', { disp: 'MAYBE' })], {
      kind: 'disposition-unclear',
    });
    await once(h, () =>
      h.svc.review.resolve({
        id: reviews[0]!.id,
        resolution: { action: 'set-disposition', disposition: 'non-approved' },
      }),
    );
    const row = h.fx.repos.responses.getRow(rows[0]!.id)!;
    expect(row.dispClass).toBe('non-approved');
    expect(h.fx.repos.responses.originalRow(row.id)!.dispClass).toBe('approved');
    expect(h.fx.repos.reviews.get(reviews[0]!.id)!.resolution).toBe('set-disposition:non-approved');
  });

  it('review.list names the subject and its request / response context', async () => {
    h = harness();
    const { req, item } = requestWithItem(h);
    h.fx.repos.reviews.insert({ kind: 'request-item-link', subjectIds: [item.id], candidates: [] });
    const { resp } = responseWithRows(h, [rowInput('LISTSURNAME, Shown')]);
    const page = unwrap(await h.svc.review.list({ offset: 0, limit: 10, state: 'open' }));
    const byKind = Object.fromEntries(page.items.map((i) => [i.kind, i]));
    expect(byKind['request-item-link']).toMatchObject({
      subjectName: 'Testsurname, Synthetic',
      subjectDob: '1990-03-12',
      unitName: 'Synthetic Unit One',
      context: { requestId: req.id, eventName: 'Synthetic Training Event' },
    });
    expect(byKind['unmatched-response-row']).toMatchObject({
      subjectName: 'LISTSURNAME, Shown',
      context: { responseId: resp.id, batchId: 'SYN-BATCH-1' },
    });
  });

  it('purge clears DC originals, edit diffs, person edits and validation reasons', async () => {
    h = harness();
    const p = personNamed(h, 'Purgesurname', ['Gone']);
    const { reviews, rows } = responseWithRows(h, [rowInput('PURGESURNAEM, Gone')]);
    const rowId = rows[0]!.id;
    unwrap(
      await h.svc.review.editSubject({
        id: reviews[0]!.id,
        subject: { kind: 'response-row', rowId, patch: { nameRaw: 'PURGESURNAME, Gone' } },
        reason: 'typo Purgesurname',
      }),
    );
    unwrap(await h.svc.persons.update({ id: p.id, patch: { dob: '1990-03-13' }, reason: 'Purgesurname dob' }));
    unwrap(
      await h.svc.review.manualValidate({
        id: reviews[0]!.id,
        target: { kind: 'person', personId: p.id },
        reason: 'Purgesurname confirmed',
      }),
    );
    unwrap(await h.svc.persons.purge({ id: p.id, password: 'correct horse battery staple' }));
    const dump = JSON.stringify([
      h.fx.db.prepare('SELECT * FROM response_row').all(),
      h.fx.db.prepare('SELECT * FROM response_row_edit').all(),
      h.fx.db.prepare('SELECT * FROM person_edit').all(),
      h.fx.db.prepare('SELECT * FROM review_item').all(),
    ]);
    expect(dump.toLowerCase()).not.toContain('purgesurna');
  });
});
