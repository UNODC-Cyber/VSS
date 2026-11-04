// persons.suggest (lane K, R11): tolerant person suggestions for the picker. Read-only: never links anything.
// All names are synthetic.
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { personNameFromRequest } from '@shared/names/personName';
import { searchTokens, SUGGEST_MAX_LIMIT } from '../../../src/main/services/suggest';
import { harness, once, unwrap } from './helpers';
import type { Harness } from './helpers';
import { identityState, personNamed, requestWithItem, responseWithRows, rowInput } from './review-fixtures';

let h: Harness;
afterEach(() => h?.cleanup());

const names = (s: { person: { displayName: string } }[]) => s.map((x) => x.person.displayName);

/** A review item whose subject shares nothing with the seeded persons, so hits come from the text search only. */
function neutralItem(): string {
  const { reviews } = responseWithRows(h, [
    rowInput('QQQUNRELATED, Nobodyx', { dob: { kind: 'empty', value: '', parsed: null, ambiguousDayMonth: false } }),
  ]);
  return reviews[0]!.id;
}

describe('searchTokens', () => {
  it('folds, splits on commas and whitespace, drops particles and duplicates', () => {
    expect(searchTokens('TESTSURNAME, Synthetic')).toEqual(['testsurname', 'synthetic']);
    expect(searchTokens('  Ahmad   bin   Ismail ')).toEqual(['ahmad', 'ismail']);
    // "van" is a configured particle (Dutch), so it is dropped like "bin"
    expect(searchTokens('Nguyễn, Văn An')).toEqual(['nguyen', 'an']);
    expect(searchTokens('Van')).toEqual(['van']);
    expect(searchTokens('ใจดี, สมชาย')).toEqual(['ใจดี', 'สมชาย']);
    expect(searchTokens('a, a; A')).toEqual(['a']);
    expect(searchTokens(' , ; ')).toEqual([]);
  });
});

describe('persons.suggest', () => {
  it('lists the matcher candidates for a review subject immediately (no text), candidates first', async () => {
    h = harness();
    const same = personNamed(h, 'Testsurname', ['Synthetic']);
    personNamed(h, 'Othername', ['Different'], { dob: '1970-01-01' });
    const { reviews } = responseWithRows(h, [rowInput('TESTSURNAME, Synthetic')]);
    const s = unwrap(await h.svc.persons.suggest({ forSubject: { kind: 'review-item', id: reviews[0]!.id } }));
    expect(s[0]).toMatchObject({ person: { id: same.id }, why: 'candidate' });
    expect(s[0]!.tier).not.toBeNull();
    expect(s[0]!.evidence.length).toBeGreaterThan(0);
    expect(names(s)).not.toContain('Othername, Different');
  });

  it('finds a person whatever the token order, commas or case', async () => {
    h = harness();
    const p = personNamed(h, 'Testsurname', ['Synthetic', 'Example']);
    const id = neutralItem();
    for (const text of [
      'TESTSURNAME, Synthetic',
      'Synthetic Testsurname',
      'example, testsurname synthetic',
      'testsurname',
      'Testsur', // partial
      'Testsurname Missingword', // tolerant: most tokens
    ]) {
      const s = unwrap(await h.svc.persons.suggest({ forSubject: { kind: 'review-item', id }, text }));
      expect(
        s.map((x) => x.person.id),
        text,
      ).toContain(p.id);
      expect(s.find((x) => x.person.id === p.id)!.why).toBe('search');
    }
  });

  it('is diacritic tolerant and drops name particles', async () => {
    h = harness();
    const viet = personNamed(h, 'Nguyễn', ['Văn', 'Antest']);
    const malay = personNamed(h, 'Ismailtest', ['Ahmadtest', 'bin']);
    const id = neutralItem();
    const find = async (text: string) =>
      unwrap(await h.svc.persons.suggest({ forSubject: { kind: 'review-item', id }, text })).map((x) => x.person.id);
    expect(await find('nguyen van antest')).toContain(viet.id);
    expect(await find('ANTEST, Nguyen')).toContain(viet.id);
    expect(await find('Ahmadtest bin Ismailtest')).toContain(malay.id);
    expect(await find('ismailtest binti ahmadtest')).toContain(malay.id);
  });

  it('handles Thai tokens and mixed-script queries', async () => {
    h = harness();
    const thai = personNamed(h, 'สมชาย', ['ใจดี']);
    const mixed = personNamed(h, 'Jaideetest', ['Somchaitest']);
    const alias = personNameFromRequest('สมศักดิ์', 'ทดสอบ');
    h.fx.repos.persons.addAlias(mixed.id, {
      ...alias,
      coreKey: null,
      sourceKind: 'manual',
      sourceId: mixed.id,
      seenAt: '2026-10-01T08:00:00.000Z',
    });
    const id = neutralItem();
    const find = async (text: string) =>
      unwrap(await h.svc.persons.suggest({ forSubject: { kind: 'review-item', id }, text })).map((x) => x.person.id);
    expect(await find('ใจดี สมชาย')).toContain(thai.id);
    expect(await find('สมชาย, ใจดี')).toContain(thai.id);
    expect(await find('Somchaitest สมศักดิ์')).toContain(mixed.id);
  });

  it('never suggests merged persons, nor the subject itself', async () => {
    h = harness();
    const a = personNamed(h, 'Mergetest', ['Alpha']);
    const b = personNamed(h, 'Mergetest', ['Alpha', 'B'], { dob: '1991-01-01' });
    unwrap(await h.svc.persons.merge({ survivorId: a.id, mergedId: b.id, reason: 'same person' }));
    const id = neutralItem();
    const s = unwrap(await h.svc.persons.suggest({ forSubject: { kind: 'review-item', id }, text: 'Mergetest' }));
    expect(s.map((x) => x.person.id)).toEqual([a.id]);
    const dup = h.fx.repos.reviews.insert({ kind: 'duplicate-persons', subjectIds: [a.id], candidates: [] });
    const own = unwrap(
      await h.svc.persons.suggest({ forSubject: { kind: 'review-item', id: dup.id }, text: 'Mergetest' }),
    );
    expect(own.map((x) => x.person.id)).not.toContain(a.id);
  });

  it('offers persons of the same request as recent', async () => {
    h = harness();
    const { req, item } = requestWithItem(h, 'Recentsurname', 'Kept');
    const p = personNamed(h, 'Recentsurname', ['Kept']);
    unwrap(await h.svc.requests.linkItem({ itemId: item.id, personId: p.id }));
    const { reviews } = responseWithRows(h, [rowInput('QQQUNRELATED, Nobodyx')], { requestId: req.id });
    const s = unwrap(await h.svc.persons.suggest({ forSubject: { kind: 'review-item', id: reviews[0]!.id } }));
    expect(s.find((x) => x.person.id === p.id)?.why).toBe('recent');
  });

  it('is bounded: default 20, never more than 50', async () => {
    h = harness();
    for (let i = 0; i < 60; i++) personNamed(h, 'Boundsurname', [`Given${String.fromCharCode(97 + (i % 26))}${i}`]);
    const id = neutralItem();
    const d = unwrap(await h.svc.persons.suggest({ forSubject: { kind: 'review-item', id }, text: 'Boundsurname' }));
    expect(d).toHaveLength(20);
    const m = unwrap(
      await h.svc.persons.suggest({ forSubject: { kind: 'review-item', id }, text: 'Boundsurname', limit: 500 }),
    );
    expect(m).toHaveLength(SUGGEST_MAX_LIMIT);
    expect(new Set(m.map((x) => x.person.id)).size).toBe(m.length);
  });

  it('answers NOT_FOUND for an unknown subject', async () => {
    h = harness();
    const r = await h.svc.persons.suggest({ forSubject: { kind: 'response-row', id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' } });
    expect(r.ok).toBe(false);
  });

  it('property: suggest never changes identity state and never audits', async () => {
    h = harness();
    personNamed(h, 'Testsurname', ['Synthetic']);
    personNamed(h, 'สมชาย', ['ใจดี']);
    const { item } = requestWithItem(h);
    const { reviews, rows } = responseWithRows(h, [rowInput('TESTSURNAME, Synthetic')]);
    const before = identityState(h);
    const subjects = [
      { kind: 'review-item' as const, id: reviews[0]!.id },
      { kind: 'request-item' as const, id: item.id },
      { kind: 'response-row' as const, id: rows[0]!.id },
    ];
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...subjects),
        fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
        fc.option(fc.integer({ min: 1, max: 50 }), { nil: undefined }),
        async (forSubject, text, limit) => {
          const r = await h.svc.persons.suggest({
            forSubject,
            ...(text !== undefined ? { text } : {}),
            ...(limit !== undefined ? { limit } : {}),
          });
          expect(r.ok).toBe(true);
          if (r.ok) expect(r.value.length).toBeLessThanOrEqual(limit ?? 20);
        },
      ),
      { numRuns: 60 },
    );
    expect(identityState(h)).toEqual(before);
    // a write after the property still audits normally (sanity check of the harness)
    await once(h, () => h.svc.review.resolve({ id: reviews[0]!.id, resolution: { action: 'dismiss' } }));
  });
});
