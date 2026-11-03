import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/domain/types';
import type { ResponseRow } from '@shared/domain/types';
import { isValid } from 'ulid';
import { freshDb, itemInput, KEY0, observed, personInput, requestInput } from './helpers';
import { APP_SCHEMA_VERSION } from '../../../src/main/db/migrations';
import type { Fixture } from './helpers';

let fx: Fixture;
beforeEach(() => {
  fx = freshDb();
});
afterEach(() => fx.cleanup());

describe('PersonRepo', () => {
  it('insert/get round-trips with aliases and identifiers; ULID ids', () => {
    const p = fx.repos.persons.insert(
      personInput({
        aliases: [
          { surname: 'Altname', given: ['Synthetic'], raw: 'ALTNAME, Synthetic', script: 'Latn', coreKey: 'alt core' },
        ],
        identifiers: [{ type: 'passport', value: 'X0000001', valueFolded: 'x0000001', issuingCountry: 'Testland' }],
      }),
    );
    expect(isValid(p.id)).toBe(true);
    const g = fx.repos.persons.get(p.id)!;
    expect(g.canonical).toEqual({
      surname: 'Testsurname',
      given: ['Synthetic', 'Example'],
      raw: 'TESTSURNAME, Synthetic Example',
      script: 'Latn',
    });
    expect(g.aliases).toHaveLength(1);
    expect(g.identifiers[0]).toEqual({
      type: 'passport',
      value: 'X0000001',
      valueFolded: 'x0000001',
      issuingCountry: 'Testland',
    });
    expect(g.state).toBe('active');
  });

  it('update, query helpers and delete', () => {
    const a = fx.repos.persons.insert(personInput({ dob: '1990-03-12' }));
    const b = fx.repos.persons.insert(personInput({ dob: '1990-12-03', coreKey: 'other key' }));
    fx.repos.persons.addIdentifier(b.id, {
      type: 'national-id',
      value: 'N-1',
      valueFolded: 'n1',
      issuingCountry: null,
    });
    fx.repos.persons.addAlias(b.id, {
      surname: 'Z',
      given: [],
      raw: 'Z',
      script: 'Latn',
      coreKey: 'example synthetic testsurname',
    });

    expect(
      fx.repos.persons
        .findByCoreKey('example synthetic testsurname')
        .map((p) => p.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
    expect(fx.repos.persons.findByDob('1990-03-12').map((p) => p.id)).toEqual([a.id]);
    expect(
      fx.repos.persons
        .findByDob('1990-03-12', { includeSwapped: true })
        .map((p) => p.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
    expect(fx.repos.persons.findByIdentifier('n1').map((p) => p.id)).toEqual([b.id]);
    expect(fx.repos.persons.findByIdentifier('n1', 'passport')).toEqual([]);

    const u = fx.repos.persons.update(a.id, { notes: 'note', sex: 'F', state: 'merged', mergedInto: b.id });
    expect(u).toMatchObject({ notes: 'note', sex: 'F', state: 'merged', mergedInto: b.id });
    expect(fx.repos.persons.findByDob('1990-03-12')).toEqual([]);
    expect(fx.repos.persons.findByDob('1990-03-12', { includeMerged: true })).toHaveLength(1);
    expect(() => fx.repos.persons.update('01J00000000000000000000000', { notes: '' })).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );

    fx.repos.persons.update(a.id, { mergedInto: null });
    fx.repos.persons.delete(a.id);
    expect(fx.repos.persons.get(a.id)).toBeNull();
    expect(fx.repos.persons.list({ offset: 0, limit: 10 }).total).toBe(1);
  });
});

describe('UnitRepo', () => {
  it('CRUD with aliases and folded name lookup', () => {
    const u = fx.repos.units.insert({
      name: 'Synthetic Unit Ünø',
      type: 'Police',
      country: 'Testland',
      unitIdNo: null,
      alias: null,
      location: null,
      description: null,
      englishDescription: null,
      branchName: null,
      branchDescription: null,
      parentOrg: null,
      subordinateOrg: null,
      orgLevel: null,
      aliases: ['SU-1'],
    });
    expect(fx.repos.units.findByName('synthetic unit uno').map((x) => x.id)).toEqual([u.id]);
    expect(fx.repos.units.findByName('su-1', 'Testland')).toHaveLength(1);
    expect(fx.repos.units.findByName('su-1', 'Elsewhere')).toHaveLength(0);
    fx.repos.units.addAlias(u.id, 'Second Alias');
    expect(fx.repos.units.update(u.id, { location: 'Fictioncity' }).aliases).toEqual(['second alias', 'su-1']);
    expect(fx.repos.units.list({ offset: 0, limit: 10, type: 'Police' }).total).toBe(1);
    fx.repos.units.delete(u.id);
    expect(fx.repos.units.get(u.id)).toBeNull();
  });
});

describe('StoredFileRepo', () => {
  it('stores blobs with sha256', () => {
    const content = new TextEncoder().encode('synthetic file body');
    const f = fx.repos.files.put({ originalName: 'synthetic.xlsx', content });
    expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fx.repos.files.content(f.id)!.toString()).toBe('synthetic file body');
    expect(fx.repos.files.verify(f.id)).toBe(true);
    expect(fx.repos.files.findBySha256(f.sha256)).toHaveLength(1);
    expect(fx.repos.files.isReferenced(f.id)).toBe(false);
    fx.repos.files.delete(f.id);
    expect(fx.repos.files.get(f.id)).toBeNull();
  });
});

describe('RequestRepo + items', () => {
  it('insert with items, status, list filters, outstanding, timings, stats', () => {
    const file = fx.repos.files.put({ originalName: 'req.xlsx', content: new Uint8Array([1, 2, 3]) });
    const p = fx.repos.persons.insert(personInput());
    const r1 = fx.repos.requests.insert(requestInput({ sourceFileId: file.id }), [
      itemInput({ personId: p.id, linkState: 'auto' }),
      itemInput({
        observed: observed({ rowRef: 'Data!A21', surname: 'Othersurname' }),
        issues: [{ code: 'DOB_TEXT', severity: 'error', rowRef: 'Data!A21', field: 'dob', message: 'x' }],
      }),
    ]);
    expect(r1.items).toHaveLength(2);
    expect(r1.sourceFile?.sha256).toBe(file.sha256);
    expect(r1.items[0]!.nameKey.coreTokens).toEqual(['synthetic', 'testsurname']);
    expect(fx.repos.requests.findBySourceSha256(file.sha256).map((x) => x.id)).toEqual([r1.id]);

    const r2 = fx.repos.requests.insert(requestInput({ receivedAt: '2026-07-10T00:00:00.000Z' }));
    fx.repos.requests.setStatus(r1.id, 'sent-to-dc', '2026-05-02T00:00:00.000Z');
    expect(fx.repos.requests.outstanding().map((x) => x.id)).toEqual([r1.id]);
    expect(fx.repos.requests.pendingPersonIds().has(p.id)).toBe(true);
    expect(fx.repos.requests.list({ offset: 0, limit: 10, statuses: ['sent-to-dc'] }).items.map((x) => x.id)).toEqual([
      r1.id,
    ]);
    expect(
      fx.repos.requests.list({ offset: 0, limit: 10, from: '2026-07-01', to: '2026-07-31' }).items.map((x) => x.id),
    ).toEqual([r2.id]);
    expect(fx.repos.requests.list({ offset: 0, limit: 10, outstandingOnly: true }).total).toBe(1);
    expect(fx.repos.requests.list({ offset: 0, limit: 10, ids: [] }).total).toBe(0);

    fx.repos.requests.setStatus(r1.id, 'responded', '2026-05-12T00:00:00.000Z');
    expect(fx.repos.requests.responseTimings()).toEqual([
      { requestId: r1.id, sentToDcAt: '2026-05-02T00:00:00.000Z', respondedAt: '2026-05-12T00:00:00.000Z' },
    ]);
    expect(fx.repos.requests.responseTimings('2026-06-01T00:00:00.000Z')).toEqual([]);

    const stats = fx.repos.requests.itemStats([r1.id, r2.id]);
    expect(stats.get(r1.id)).toEqual({
      itemCount: 2,
      errorCount: 1,
      openIssueCount: 1,
      unresolvedLinkCount: 1,
      answeredCount: 0,
    });
    expect(stats.get(r2.id)!.itemCount).toBe(0);

    const it2 = r1.items[1]!;
    const upd = fx.repos.requests.updateItem(it2.id, {
      exportDecision: 'manual-exclude',
      exportReason: 'r',
      personId: p.id,
      linkState: 'confirmed',
    });
    expect(upd).toMatchObject({ exportDecision: 'manual-exclude', personId: p.id, linkState: 'confirmed' });
    expect(fx.repos.requests.itemsByPerson(p.id)).toHaveLength(2);
    expect(fx.repos.requests.requestIdsForPerson(p.id)).toEqual([r1.id]);
    expect(fx.repos.requests.update(r1.id, { notes: 'n', batchId: 'B-1' })).toMatchObject({
      notes: 'n',
      batchId: 'B-1',
    });
  });
});

describe('Export, Response, Vetting, Review, NegativePair, MergeLog, Settings, Meta', () => {
  it('round-trips the remaining repositories', () => {
    const p = fx.repos.persons.insert(personInput());
    const req = fx.repos.requests.insert(requestInput(), [itemInput({ personId: p.id, linkState: 'auto' })]);
    const item = req.items[0]!;

    const ef = fx.repos.files.put({ originalName: 'out.xlsx', content: new Uint8Array([9]) });
    const ex = fx.repos.exports.insert({
      requestId: req.id,
      mode: 'regenerate',
      fileId: ef.id,
      policy: DEFAULT_SETTINGS.exportPolicy,
      includedItemIds: [item.id],
      sha256: ef.sha256,
    });
    expect(fx.repos.exports.get(ex.id)).toEqual(ex);
    expect(fx.repos.exports.latestForRequest(req.id)?.id).toBe(ex.id);

    const rf = fx.repos.files.put({ originalName: 'resp.xlsx', content: new Uint8Array([7]) });
    const row: Omit<ResponseRow, 'id' | 'responseId'> = {
      rowRef: 'Final_Results!A9',
      section: 'approved-individual',
      disp: 'APPROVED',
      nameRaw: 'TESTSURNAME, Synthetic',
      name: { surname: 'Testsurname', given: ['Synthetic'], raw: 'TESTSURNAME, Synthetic', script: 'Latn' },
      nameKey: { ...KEY0, coreTokens: ['synthetic', 'testsurname'] },
      dob: { kind: 'text', value: '12-MAR-1990', parsed: '1990-03-12', ambiguousDayMonth: false },
      pob: { city: 'Fictioncity', state: null, country: 'Testland' },
      unitType: 'Police',
      unitName: 'Synthetic Unit One',
      certDate: { kind: 'text', value: '01-JUN-2026', parsed: '2026-06-01', ambiguousDayMonth: false },
      expires: { kind: 'text', value: '01-JUN-2027', parsed: '2027-06-01', ambiguousDayMonth: false },
      match: {
        candidates: [
          {
            targetKind: 'request-item',
            targetId: item.id,
            tier: 'T1',
            evidence: ['NAME_CORE_EQUAL', 'DOB_EQUAL'],
            score: 1,
          },
        ],
        decision: 'auto',
        chosen: item.id,
        decidedBy: 'system',
        decidedAt: '2026-06-02T00:00:00.000Z',
      },
    };
    const resp = fx.repos.responses.insert(
      {
        batchId: 'B-1',
        post: 'Synthetic Post',
        resultsAsOf: '2026-06-01',
        assistanceLine: 'Synthetic line',
        sourceFileId: rf.id,
        importedAt: '2026-06-02T00:00:00.000Z',
        requestId: req.id,
      },
      [row],
    );
    expect(resp.rows[0]).toMatchObject({ ...row, responseId: resp.id });
    expect(resp.sourceFile.sha256).toBe(rf.sha256);
    const rowId = resp.rows[0]!.id;
    expect(fx.repos.responses.rowLinks(rowId)).toEqual({ requestItemId: item.id, personId: null });
    expect(fx.repos.responses.rowsByRequestItem(item.id)).toHaveLength(1);
    expect(fx.repos.requests.itemStats([req.id]).get(req.id)!.answeredCount).toBe(1);
    fx.repos.responses.setRowMatch(rowId, { ...row.match, decision: 'rejected', chosen: null });
    expect(fx.repos.responses.rowLinks(rowId)).toEqual({ requestItemId: null, personId: null });
    expect(fx.repos.responses.listByRequest(req.id)).toHaveLength(1);

    const v1 = fx.repos.vetting.insert({
      personId: p.id,
      unitId: null,
      requestId: req.id,
      responseRowId: rowId,
      disposition: 'approved',
      certDate: '2026-06-01',
      expiresAt: '2027-06-01',
      expiryAssumed: false,
      source: 'dc-file',
      recordedAt: '2026-06-02T00:00:00.000Z',
      recordedBy: 'tester',
      note: '',
    });
    const v2 = fx.repos.vetting.insert({
      personId: p.id,
      unitId: null,
      requestId: null,
      responseRowId: null,
      disposition: 'email-cleared',
      certDate: '2026-08-01',
      expiresAt: '2026-08-31',
      expiryAssumed: true,
      source: 'email',
      recordedAt: '2026-08-01T00:00:00.000Z',
      recordedBy: 'tester',
      note: '',
    });
    expect(fx.repos.vetting.get(v1.id)).toEqual(v1);
    expect(fx.repos.vetting.latestByPerson(p.id)?.id).toBe(v2.id);
    expect(fx.repos.vetting.latestByPersons([p.id]).get(p.id)?.id).toBe(v2.id);
    expect(fx.repos.vetting.expiringBetween('2026-08-01', '2026-09-01').map((r) => r.id)).toEqual([v2.id]);

    const u = fx.repos.units.insert({
      name: 'U',
      type: 'Military',
      country: 'Testland',
      unitIdNo: null,
      alias: null,
      location: null,
      description: null,
      englishDescription: null,
      branchName: null,
      branchDescription: null,
      parentOrg: null,
      subordinateOrg: null,
      orgLevel: null,
    });
    const uv = fx.repos.unitVetting.insert({
      unitId: u.id,
      requestId: req.id,
      responseRowId: null,
      commanderPersonId: p.id,
      disposition: 'approved',
      certDate: null,
      expiresAt: null,
      recordedAt: '2026-06-02T00:00:00.000Z',
    });
    expect(fx.repos.unitVetting.latestByUnit(u.id)).toEqual(uv);

    const ri = fx.repos.reviews.insert({ kind: 'response-row-match', subjectIds: [rowId], candidates: [] });
    expect(fx.repos.reviews.counts()).toEqual({ open: 1, byKind: { 'response-row-match': 1 } });
    expect(fx.repos.reviews.openForSubject(rowId).map((x) => x.id)).toEqual([ri.id]);
    fx.repos.reviews.resolve(ri.id, 'resolved', 'link');
    expect(fx.repos.reviews.list({ offset: 0, limit: 5, state: 'resolved' }).total).toBe(1);
    expect(fx.repos.reviews.counts().open).toBe(0);

    const q = fx.repos.persons.insert(personInput());
    fx.repos.negativePairs.add(q.id, p.id);
    expect(fx.repos.negativePairs.has(p.id, q.id)).toBe(true);
    expect(fx.repos.negativePairs.partnersOf(p.id)).toEqual([q.id]);
    fx.repos.negativePairs.remove(p.id, q.id);
    expect(fx.repos.negativePairs.has(p.id, q.id)).toBe(false);

    const ml = fx.repos.mergeLog.insert({
      actor: 'tester',
      survivorId: p.id,
      mergedId: q.id,
      reason: 'same',
      snapshot: { a: 1 },
    });
    expect(fx.repos.mergeLog.listForPerson(q.id)).toEqual([ml]);
    expect(fx.repos.mergeLog.snapshot(ml.id)).toEqual({ a: 1 });

    expect(fx.repos.settings.getAll()).toEqual(DEFAULT_SETTINGS);
    fx.repos.settings.update({
      autoLockMinutes: 5,
      exportPolicy: { ...DEFAULT_SETTINGS.exportPolicy, expiringWithinDays: 30 },
    });
    expect(fx.repos.settings.get('autoLockMinutes')).toBe(5);
    expect(fx.repos.settings.get('exportPolicy').expiringWithinDays).toBe(30);
    expect(fx.repos.settings.get('exportPolicy').includeFlaggedUnresolved).toBe('block');
    fx.repos.settings.set('redactionMode', true);
    expect(fx.repos.settings.getAll().redactionMode).toBe(true);

    fx.repos.meta.set('x', 'y');
    expect(fx.repos.meta.get('x')).toBe('y');
    expect(fx.repos.meta.schemaVersion()).toBe(APP_SCHEMA_VERSION);
  });
});
