import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { searchIds } from '../../../src/main/db/search';
import { undoRequest } from '../../../src/main/db/undo';
import type { Unit } from '@shared/domain/types';
import { freshDb, itemInput, observed, personInput, requestInput } from './helpers';
import type { Fixture } from './helpers';

let fx: Fixture;
beforeEach(() => {
  fx = freshDb();
});
afterEach(() => fx.cleanup());

const unitIn = (
  name: string,
  createdByRequestId: string | null = null,
): Omit<Unit, 'id' | 'aliases'> & { createdByRequestId: string | null } => ({
  name,
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
  createdByRequestId,
});

/** A pre-existing person and unit, then an import that creates one new person + unit and links both people. */
function scenario() {
  const oldPerson = fx.repos.persons.insert(
    personInput({ canonical: { surname: 'Preexisting', given: ['Kept'], raw: 'PREEXISTING, Kept', script: 'Latn' } }),
  );
  const oldUnit = fx.repos.units.insert(unitIn('Preexisting Unit'));
  const srcFile = fx.repos.files.put({ originalName: 'req.xlsx', content: new Uint8Array([1, 2, 3, 4]) });
  const req = fx.repos.requests.insert(requestInput({ sourceFileId: srcFile.id, eventName: 'Undoable Import Event' }));
  const newUnit = fx.repos.units.insert(unitIn('Fresh Import Unit', req.id));
  const newPerson = fx.repos.persons.insert(
    personInput({
      canonical: { surname: 'Freshimport', given: ['Gone'], raw: 'FRESHIMPORT, Gone', script: 'Latn' },
      createdByRequestId: req.id,
    }),
  );
  const items = fx.repos.requests.addItems(req.id, [
    itemInput({
      observed: observed({ surname: 'Preexisting' }),
      personId: oldPerson.id,
      unitId: oldUnit.id,
      linkState: 'auto',
    }),
    itemInput({
      observed: observed({ surname: 'Freshimport', rowRef: 'Data!A21' }),
      personId: newPerson.id,
      unitId: newUnit.id,
      linkState: 'new-person',
    }),
  ]);
  fx.repos.persons.addAlias(oldPerson.id, {
    surname: 'Importalias',
    given: [],
    raw: 'IMPORTALIAS',
    script: 'Latn',
    sourceKind: 'request-item',
    sourceId: items[0]!.id,
  });
  fx.repos.vetting.insert({
    personId: oldPerson.id,
    unitId: null,
    requestId: req.id,
    responseRowId: null,
    disposition: 'email-cleared',
    certDate: '2026-06-01',
    expiresAt: '2026-07-01',
    expiryAssumed: true,
    source: 'email',
    recordedAt: '2026-06-01T00:00:00.000Z',
    recordedBy: 't',
    note: '',
  });
  fx.repos.reviews.insert({ kind: 'request-item-link', subjectIds: [items[1]!.id], candidates: [] });
  const outFile = fx.repos.files.put({ originalName: 'out.xlsx', content: new Uint8Array([5]) });
  fx.repos.exports.insert({
    requestId: req.id,
    mode: 'regenerate',
    fileId: outFile.id,
    policy: null,
    includedItemIds: [],
    sha256: outFile.sha256,
  });
  return { oldPerson, oldUnit, newPerson, newUnit, req, items, srcFile, outFile };
}

const count = (t: string) => (fx.db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;

describe('undoRequest', () => {
  it('deletes the request and what it created, keeps pre-existing data', () => {
    const s = scenario();
    const auditBefore = count('audit');
    const r = undoRequest(fx.db, s.req.id);
    expect(r).toMatchObject({
      itemsDeleted: 2,
      vettingRecordsDeleted: 1,
      exportsDeleted: 1,
      reviewItemsDeleted: 1,
      filesDeleted: 2,
    });
    expect(r.personsDeleted).toEqual([s.newPerson.id]);
    expect(r.unitsDeleted).toEqual([s.newUnit.id]);
    expect(fx.repos.requests.get(s.req.id)).toBeNull();
    expect(fx.repos.persons.get(s.newPerson.id)).toBeNull();
    expect(fx.repos.units.get(s.newUnit.id)).toBeNull();
    const kept = fx.repos.persons.get(s.oldPerson.id)!;
    expect(kept.aliases).toEqual([]); // alias contributed by the import is gone
    expect(fx.repos.units.get(s.oldUnit.id)).not.toBeNull();
    expect(count('stored_file')).toBe(0);
    expect(count('vetting_record')).toBe(0);
    expect(count('review_item')).toBe(0);
    expect(count('audit')).toBe(auditBefore);
    expect(searchIds(fx.db, 'request', 'undoable')).toEqual([]);
    expect(searchIds(fx.db, 'person', 'freshimport')).toEqual([]);
    expect(searchIds(fx.db, 'person', 'importalias')).toEqual([]);
    expect(searchIds(fx.db, 'person', 'preexisting')).toEqual([s.oldPerson.id]);
  });

  it('keeps a created person that something else now references', () => {
    const s = scenario();
    const other = fx.repos.requests.insert(requestInput(), [
      itemInput({ personId: s.newPerson.id, linkState: 'confirmed' }),
    ]);
    const r = undoRequest(fx.db, s.req.id);
    expect(r.personsDeleted).toEqual([]);
    expect(r.personsKept).toEqual([s.newPerson.id]);
    expect(fx.repos.persons.keys(s.newPerson.id)?.createdByRequestId).toBeNull();
    expect(fx.repos.requests.get(other.id)).not.toBeNull();
  });

  it('rolls back everything on failure', () => {
    const s = scenario();
    const before = [
      'request',
      'request_item',
      'person',
      'unit',
      'stored_file',
      'export',
      'vetting_record',
      'review_item',
      'person_alias',
    ].map(count);
    expect(() =>
      undoRequest(fx.db, s.req.id, {
        beforeCommit: () => {
          throw new Error('injected failure');
        },
      }),
    ).toThrow('injected failure');
    const after = [
      'request',
      'request_item',
      'person',
      'unit',
      'stored_file',
      'export',
      'vetting_record',
      'review_item',
      'person_alias',
    ].map(count);
    expect(after).toEqual(before);
    expect(searchIds(fx.db, 'request', 'undoable')).toEqual([s.req.id]);
    expect(searchIds(fx.db, 'person', 'freshimport')).toEqual([s.newPerson.id]);
  });

  it('refuses when responses are linked unless includeResponses', () => {
    const s = scenario();
    const f = fx.repos.files.put({ originalName: 'resp.xlsx', content: new Uint8Array([8]) });
    fx.repos.responses.insert({
      batchId: 'B',
      post: 'P',
      resultsAsOf: '2026-06-01',
      assistanceLine: '',
      sourceFileId: f.id,
      importedAt: '2026-06-02T00:00:00.000Z',
      requestId: s.req.id,
    });
    expect(() => undoRequest(fx.db, s.req.id)).toThrow(expect.objectContaining({ code: 'IN_USE' }));
    expect(fx.repos.requests.exists(s.req.id)).toBe(true);
    const r = undoRequest(fx.db, s.req.id, { includeResponses: true });
    expect(r.responsesDeleted).toBe(1);
    expect(count('response')).toBe(0);
    expect(count('stored_file')).toBe(0);
  });

  it('NOT_FOUND for an unknown request', () => {
    expect(() => undoRequest(fx.db, '01J00000000000000000000000')).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
  });
});
