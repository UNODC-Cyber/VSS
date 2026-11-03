// Identity integrity through the services: never guess, flag first; merge/split/undo restore exact pointers.
import { afterEach, describe, expect, it } from 'vitest';
import type { RequestSummary } from '@shared/ipc/contract';
import type { PersonInput } from '../../../src/main/db/repos';
import { keysOf } from '../../../src/main/services/people-ops';
import {
  storeTemplate,
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

const manual = (h: Harness, items: Parameters<typeof manualRequest>[0], over = {}): Promise<RequestSummary> =>
  once(h, () => h.svc.requests.createManual(manualRequest(items, over)));
const itemsOf = (h: Harness, id: string) => h.fx.repos.requests.listItems(id);

function personInput(over: Partial<PersonInput> = {}): PersonInput {
  const canonical = {
    surname: 'Testsurname',
    given: ['Synthetic'],
    raw: 'Testsurname Synthetic',
    script: 'Latn' as const,
  };
  return {
    canonical,
    ...keysOf(canonical),
    dob: '1990-03-12',
    dobPrecision: 'exact',
    sex: 'M',
    pob: { city: null, state: null, country: 'TESTLAND' },
    nationality: 'TESTLAND',
    ...over,
  };
}

/** Every pointer that a merge/split may move. */
function pointers(h: Harness): string {
  const q = (sql: string) => h.fx.db.prepare(sql).all();
  return JSON.stringify({
    items: q('SELECT id, person_id, link_state FROM request_item ORDER BY id'),
    rows: q('SELECT id, person_id, request_item_id FROM response_row ORDER BY id'),
    records: q('SELECT id, person_id FROM vetting_record ORDER BY id'),
    commanders: q('SELECT id, commander_person_id FROM unit_vetting_record ORDER BY id'),
    aliases: q('SELECT id, person_id FROM person_alias ORDER BY id'),
    identifiers: q('SELECT id, person_id FROM identifier ORDER BY id'),
    persons: q('SELECT id, state, merged_into FROM person ORDER BY id'),
  });
}

describe('linking rules', () => {
  it('same name, different DOB, same unit: flagged for review (T2), never auto-linked', async () => {
    h = harness();
    const a = await manual(h, [manualItem({ dob: '1990-03-12' })]);
    const b = await manual(h, [manualItem({ dob: '1985-07-01' })]);
    const [ia] = itemsOf(h, a.id);
    const [ib] = itemsOf(h, b.id);
    expect(ib!).toMatchObject({ linkState: 'pending-review', personId: null });
    const r = h.fx.repos.reviews.list({ offset: 0, limit: 5 }).items[0]!;
    expect(r.candidates[0]).toMatchObject({ targetId: ia!.personId, tier: 'T2' });
    expect(r.candidates[0]!.evidence).toContain('DOB_CONFLICT');
    await once(h, () => h.svc.review.resolve({ id: r.id, resolution: { action: 'not-same' } }));
    expect(h.count('person')).toBe(2);
    expect(h.fx.repos.requests.getItem(ib!.id)!.personId).not.toBe(ia!.personId);
  });

  it('same name, different DOB, other unit: two persons, never linked, never proposed as duplicates', async () => {
    h = harness();
    const a = await manual(h, [manualItem({ dob: '1990-03-12' })]);
    const b = await manual(h, [manualItem({ dob: '1985-07-01', unitName: 'Synthetic Unit Two' })]);
    const [ia] = itemsOf(h, a.id);
    const [ib] = itemsOf(h, b.id);
    expect(ib!.linkState).toBe('new-person');
    expect(ib!.personId).not.toBe(ia!.personId);
    expect(h.count('person')).toBe(2);
    const scan = await once(h, () => h.svc.persons.scanDuplicates());
    expect(scan.pairsFound).toBe(0);
    // merging them is still possible as an explicit act, but not-same blocks it
    await once(h, () => h.svc.persons.markNotSame({ a: ia!.personId!, b: ib!.personId! }));
    expect(
      errCode(await h.svc.persons.merge({ survivorId: ia!.personId!, mergedId: ib!.personId!, reason: 'x' })),
    ).toBe('CONFLICT');
  });

  it('two identical existing persons: the row is flagged with both candidates, nobody is created', async () => {
    h = harness();
    storeTemplate(h);
    // An equal passport makes both a T1 candidate (F-06: a cross-request T1 needs an ID or unit + POB place).
    const id = { type: 'passport' as const, value: 'TP1234567', valueFolded: 'TP1234567', issuingCountry: null };
    const p1 = h.fx.repos.persons.insert(personInput({ identifiers: [id] }));
    const p2 = h.fx.repos.persons.insert(personInput({ identifiers: [id] }));
    const s = await manual(h, [manualItem({ passport: 'TP1234567' })]);
    const [it1] = itemsOf(h, s.id);
    expect(it1!.linkState).toBe('pending-review');
    expect(it1!.personId).toBeNull();
    expect(h.count('person')).toBe(2);
    const reviews = h.fx.repos.reviews.list({ offset: 0, limit: 10, state: 'open' }).items;
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.kind).toBe('request-item-link');
    expect(reviews[0]!.candidates.map((c) => c.targetId).sort()).toEqual([p1.id, p2.id].sort());
    expect(reviews[0]!.candidates.every((c) => c.tier === 'T1')).toBe(true);
    // export is blocked by policy 'block' until resolved or overridden with a reason
    expect(errCode(await h.svc.requests.export({ requestId: s.id, mode: 'regenerate', destPath: '/o.xlsx' }))).toBe(
      'EXPORT_BLOCKED',
    );
    const pv = unwrap(await h.svc.requests.exportPreview({ requestId: s.id, mode: 'regenerate' }));
    expect(pv.blockingItemIds).toEqual([it1!.id]);
    const ex = await once(h, () =>
      h.svc.requests.export({
        requestId: s.id,
        mode: 'regenerate',
        destPath: '/o.xlsx',
        overrideReason: 'urgent course',
      }),
    );
    expect(ex.includedCount).toBe(1);
    // the duplicate scan flags the pair once
    const scan = await once(h, () => h.svc.persons.scanDuplicates());
    expect(scan.reviewItemsCreated).toBe(1);
    expect(unwrap(await h.svc.persons.scanDuplicates()).reviewItemsCreated).toBe(0);
    // resolve: merge the duplicates, then confirm the row
    const dup = h.fx.repos.reviews.list({ offset: 0, limit: 10, state: 'open', kinds: ['duplicate-persons'] })
      .items[0]!;
    await once(h, () =>
      h.svc.review.resolve({ id: dup.id, resolution: { action: 'merge', survivorId: p1.id, mergedId: p2.id } }),
    );
    const link = h.fx.repos.reviews.list({ offset: 0, limit: 10, state: 'open', kinds: ['request-item-link'] })
      .items[0]!;
    await once(h, () => h.svc.review.resolve({ id: link.id, resolution: { action: 'link', targetId: p1.id } }));
    expect(h.fx.repos.requests.getItem(it1!.id)!).toMatchObject({ personId: p1.id, linkState: 'confirmed' });
    expect(unwrap(await h.svc.review.counts()).open).toBe(0);
  });

  it('two near-identical rows in one batch are never two new persons', async () => {
    h = harness();
    const s = await manual(h, [manualItem(), manualItem({ sex: 'M' })]);
    const items = itemsOf(h, s.id);
    expect(items.every((i) => i.linkState === 'pending-review' && i.personId === null)).toBe(true);
    expect(h.count('person')).toBe(0);
    const reviews = h.fx.repos.reviews.list({ offset: 0, limit: 10 }).items;
    expect(reviews).toHaveLength(2);
    // first: new person; second: link via the other row
    const r0 = reviews.find((r) => r.subjectIds[0] === items[0]!.id)!;
    const r1 = reviews.find((r) => r.subjectIds[0] === items[1]!.id)!;
    await once(h, () => h.svc.review.resolve({ id: r0.id, resolution: { action: 'new-person' } }));
    await once(h, () => h.svc.review.resolve({ id: r1.id, resolution: { action: 'link', targetId: items[0]!.id } }));
    const after = itemsOf(h, s.id);
    expect(after[0]!.personId).toBe(after[1]!.personId);
    expect(h.count('person')).toBe(1);
  });

  it('not-same on a flagged row creates a separate person and records the negative pairs', async () => {
    h = harness();
    const p1 = h.fx.repos.persons.insert(personInput());
    const p2 = h.fx.repos.persons.insert(personInput());
    const s = await manual(h, [manualItem()]);
    const [it1] = itemsOf(h, s.id);
    const r = h.fx.repos.reviews.list({ offset: 0, limit: 10 }).items[0]!;
    await once(h, () => h.svc.review.resolve({ id: r.id, resolution: { action: 'not-same' } }));
    const linked = h.fx.repos.requests.getItem(it1!.id)!;
    expect(linked.personId).not.toBeNull();
    expect([p1.id, p2.id]).not.toContain(linked.personId);
    expect(h.fx.repos.negativePairs.has(linked.personId!, p1.id)).toBe(true);
    expect(h.fx.repos.negativePairs.has(linked.personId!, p2.id)).toBe(true);
    // skipping (dismiss) and re-resolving a closed item
    expect(errCode(await h.svc.review.resolve({ id: r.id, resolution: { action: 'dismiss' } }))).toBe('CONFLICT');
  });

  it('linkItem: explicit new person or explicit link', async () => {
    h = harness();
    const p1 = h.fx.repos.persons.insert(personInput());
    h.fx.repos.persons.insert(personInput());
    const s = await manual(h, [manualItem()]);
    const [it1] = itemsOf(h, s.id);
    const out = await once(h, () => h.svc.requests.linkItem({ itemId: it1!.id, personId: p1.id }));
    expect(out).toMatchObject({ personId: p1.id, linkState: 'confirmed' });
    expect(h.fx.repos.reviews.counts().open).toBe(0);
    const s2 = await manual(h, [manualItem()]);
    const [it2] = itemsOf(h, s2.id);
    const out2 = await once(h, () => h.svc.requests.linkItem({ itemId: it2!.id, personId: null }));
    expect(out2.linkState).toBe('new-person');
  });
});

describe('merge / split / undo', () => {
  async function seeded(h: Harness): Promise<{ a: string; b: string }> {
    // req-001 with a DC response gives records, rows, aliases, identifiers and a unit commander pointer.
    const p = unwrap(await h.svc.requests.importFile('r.xlsx', fixtureBytes('requests/req-001-basic.xlsx')));
    const s = unwrap(await h.svc.requests.importCommit(commitHeader(p.previewId)));
    unwrap(await h.svc.requests.export({ requestId: s.id, mode: 'regenerate', destPath: '/o.xlsx' }));
    unwrap(await h.svc.requests.markSentToDc({ id: s.id }));
    const pv = unwrap(
      await h.svc.responses.importFile('a.xlsx', fixtureBytes('responses/resp-001-all-approved.xlsx'), s.id),
    );
    unwrap(await h.svc.responses.importCommit({ previewId: pv.previewId, requestId: s.id }));
    const items = itemsOf(h, s.id);
    return {
      a: items.find((i) => i.observed.surname === 'Siarorikpon')!.personId!,
      b: items.find((i) => i.observed.surname === 'Buthasak')!.personId!,
    };
  }

  it('merge then unmerge restores every pointer exactly', async () => {
    h = harness();
    const { a, b } = await seeded(h);
    const before = pointers(h);
    const d = await once(h, () => h.svc.persons.merge({ survivorId: a, mergedId: b, reason: 'test' }));
    expect(d.records).toHaveLength(2);
    expect(d.person.aliases.length).toBeGreaterThan(0);
    expect(h.fx.repos.persons.get(b)).toMatchObject({ state: 'merged', mergedInto: a });
    expect(h.fx.repos.requests.itemsByPerson(b)).toHaveLength(0);
    expect(errCode(await h.svc.persons.merge({ survivorId: a, mergedId: b, reason: 'again' }))).toBe('CONFLICT');
    const logId = d.mergeHistory[0]!.id;
    await once(h, () => h.svc.persons.unmerge({ mergeLogId: logId }));
    expect(pointers(h)).toBe(before);
    expect(errCode(await h.svc.persons.unmerge({ mergeLogId: logId }))).toBe('CONFLICT');
  });

  it('split moves one request item (and what hangs off it) to a new person; undo restores', async () => {
    h = harness();
    const s1 = await manual(h, [manualItem({ unitName: 'Synthetic Unit One' })]);
    const s2 = await manual(h, [manualItem({ unitName: 'Synthetic Unit One' })]);
    const [i1] = itemsOf(h, s1.id);
    const [i2] = itemsOf(h, s2.id);
    expect(i2!.linkState).toBe('auto');
    expect(i2!.personId).toBe(i1!.personId);
    await once(h, () => h.svc.requests.markSentToDc({ id: s2.id, at: '2026-11-03T09:00:00.000Z' }));
    unwrap(
      await h.svc.requests.markRespondedByEmail({
        requestId: s2.id,
        itemIds: [i2!.id],
        certDate: '2026-11-03',
        expiresAt: null,
        disposition: 'approved',
        note: '',
      }),
    );
    const before = pointers(h);
    const d = await once(h, () =>
      h.svc.persons.split({ personId: i1!.personId!, itemIds: [i2!.id], reason: 'different person' }),
    );
    expect(d.person.id).not.toBe(i1!.personId);
    expect(d.records).toHaveLength(1); // the email clearance followed its item
    expect(h.fx.repos.requests.getItem(i2!.id)!.personId).toBe(d.person.id);
    expect(h.fx.repos.negativePairs.has(d.person.id, i1!.personId!)).toBe(true);
    await once(h, () => h.svc.persons.unmerge({ mergeLogId: d.mergeHistory[0]!.id }));
    const after = JSON.parse(pointers(h)) as Record<string, unknown[]>;
    const prev = JSON.parse(before) as Record<string, unknown[]>;
    for (const k of ['items', 'rows', 'records', 'commanders', 'aliases', 'identifiers'])
      expect(after[k]).toEqual(prev[k]);
    expect(h.fx.repos.negativePairs.has(d.person.id, i1!.personId!)).toBe(false);
  });

  it('purge needs the password and removes personal data', async () => {
    h = harness();
    const s = await manual(h, [manualItem()]);
    const pid = itemsOf(h, s.id)[0]!.personId!;
    const n = h.auditCount();
    expect(errCode(await h.svc.persons.purge({ id: pid, password: 'wrong' }))).toBe('BAD_CREDENTIALS');
    expect(h.auditCount()).toBe(n);
    await once(h, () => h.svc.persons.purge({ id: pid, password: PASSWORD }));
    const p = h.fx.repos.persons.get(pid)!;
    expect(p).toMatchObject({ state: 'purged', dob: null, canonical: { surname: '', given: [] } });
    expect(itemsOf(h, s.id)[0]!.observed.surname).toBe('');
    const found = unwrap(await h.svc.persons.list({ offset: 0, limit: 10, text: 'Testsurname' }));
    expect(found.total).toBe(0);
  });
});

describe('persons and units queries', () => {
  it('search, filters, detail, update, unit merge', async () => {
    h = harness();
    const p = unwrap(await h.svc.requests.importFile('r.xlsx', fixtureBytes('requests/req-001-basic.xlsx')));
    const s = unwrap(await h.svc.requests.importCommit(commitHeader(p.previewId)));
    const found = unwrap(await h.svc.persons.list({ offset: 0, limit: 10, text: 'Siarorikpon' }));
    expect(found.total).toBe(1);
    expect(found.items[0]!.status).toBe('unknown');
    const all = unwrap(await h.svc.persons.list({ offset: 0, limit: 2, sort: 'name' }));
    expect(all.total).toBe(6);
    expect(all.items).toHaveLength(2);
    const d = unwrap(await h.svc.persons.get({ id: found.items[0]!.id }));
    expect(d.requests.map((r) => r.id)).toEqual([s.id]);
    await once(h, () => h.svc.persons.update({ id: d.person.id, patch: { notes: 'checked' }, reason: 'x' }));
    const units = unwrap(await h.svc.units.list({ offset: 0, limit: 10 }));
    expect(units.total).toBe(2);
    const [u1, u2] = units.items;
    const merged = await once(h, () => h.svc.units.merge({ survivorId: u1!.id, mergedId: u2!.id }));
    expect(merged.personIds).toHaveLength(6);
    expect(h.count('unit')).toBe(1);
    await once(h, () => h.svc.units.addAlias({ id: u1!.id, alias: 'Another Unit Name' }));
  });
});
