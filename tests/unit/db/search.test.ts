import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultFoldForSearch,
  dobVariants,
  foldForSearch,
  rebuildAllSearch,
  searchAll,
  searchIds,
  setSearchFolder,
} from '../../../src/main/db/search';
import { freshDb, itemInput, observed, personInput, requestInput } from './helpers';
import type { Fixture } from './helpers';

let fx: Fixture;
beforeEach(() => {
  fx = freshDb();
});
afterEach(() => {
  setSearchFolder(null);
  fx.cleanup();
});

const personIds = (text: string) => searchIds(fx.db, 'person', text);

describe('foldForSearch', () => {
  it('NFKC, casefold, strips Latin diacritics and Thai tone marks, keeps Thai vowels', () => {
    expect(defaultFoldForSearch('ＮＧＵＹỄＮ  Thị')).toBe('nguyen thi');
    expect(defaultFoldForSearch('Straße Øster Đức')).toBe('strasse oster duc');
    expect(defaultFoldForSearch('ทดสอบ่้')).toBe('ทดสอบ');
    expect(defaultFoldForSearch('กิน')).toBe('กิน'); // vowel sign (Mn) kept
  });
  it('dobVariants', () => {
    expect(dobVariants('1990-03-12')).toEqual(['1990-03-12', '12/03/1990', '03/12/1990']);
    expect(dobVariants(null)).toEqual([]);
  });
});

describe('search', () => {
  it('finds Thai substrings, diacritic-insensitive Latin, identifiers and DOB in all three formats', () => {
    const thai = fx.repos.persons.insert(
      personInput({
        canonical: { surname: 'ทดสอบสมมติ', given: ['ตัวอย่าง'], raw: 'ทดสอบสมมติ ตัวอย่าง', script: 'Thai' },
        dob: '1985-11-04',
      }),
    );
    const latin = fx.repos.persons.insert(
      personInput({
        canonical: { surname: 'Zébulonix', given: ['Quàrtzé'], raw: 'ZÉBULONIX, Quàrtzé', script: 'Latn' },
        identifiers: [{ type: 'passport', value: 'SYN998877', valueFolded: 'syn998877', issuingCountry: null }],
      }),
    );
    expect(personIds('สอบสม')).toEqual([thai.id]); // substring in the middle
    expect(personIds('ทดสอบ่')).toEqual([thai.id]); // tone mark in query is ignored
    expect(personIds('zebulon')).toEqual([latin.id]);
    expect(personIds('ZÉBÜLONIX quartze')).toEqual([latin.id]);
    expect(personIds('998877')).toEqual([latin.id]);
    expect(personIds('1985-11-04')).toEqual([thai.id]);
    expect(personIds('04/11/1985')).toEqual([thai.id]);
    expect(personIds('11/04/1985')).toEqual([thai.id]);
    expect(personIds('nothing-like-this')).toEqual([]);
  });

  it('short queries fall back to LIKE; grouped results with totals and paging', () => {
    fx.repos.persons.insert(
      personInput({ canonical: { surname: 'Ab', given: ['Qz'], raw: 'AB, Qz', script: 'Latn' } }),
    );
    fx.repos.persons.insert(
      personInput({ canonical: { surname: 'Abx', given: ['Yy'], raw: 'ABX, Yy', script: 'Latn' } }),
    );
    const r = searchAll(fx.db, 'ab', { kinds: ['person'] }, { offset: 0, limit: 1 });
    expect(r.mode).toBe('like');
    expect(r.groups[0]!.total).toBe(2);
    expect(r.groups[0]!.hits).toHaveLength(1);
    expect(searchAll(fx.db, '   ').mode).toBe('empty');
    expect(searchAll(fx.db, '100%_').groups.every((g) => g.total === 0)).toBe(true);
    expect(searchAll(fx.db, 'qz ab', { kinds: ['person'] }).groups[0]!.total).toBe(1);
  });

  it('indexes units, requests and responses; merged persons hidden unless asked; reindexes on update and unit rename', () => {
    const u = fx.repos.units.insert({
      name: 'Synthetic Harbour Patrol',
      type: 'Police',
      country: 'Testland',
      unitIdNo: 'SHP-7',
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
    const p = fx.repos.persons.insert(personInput());
    const req = fx.repos.requests.insert(requestInput({ eventName: 'Imaginary Workshop Kappa' }), [
      itemInput({ observed: observed({ surname: 'Rowsurnameonly' }), personId: p.id, unitId: u.id }),
    ]);
    const res = searchAll(fx.db, 'harbour');
    expect(res.groups.find((g) => g.kind === 'unit')!.hits.map((h) => h.id)).toEqual([u.id]);
    expect(res.groups.find((g) => g.kind === 'person')!.hits.map((h) => h.id)).toEqual([p.id]); // unit name in person blob
    expect(searchIds(fx.db, 'request', 'workshop kappa')).toEqual([req.id]);
    expect(searchIds(fx.db, 'request', 'rowsurname')).toEqual([req.id]);

    fx.repos.units.update(u.id, { name: 'Renamed Lighthouse Squad' });
    expect(personIds('lighthouse')).toEqual([p.id]);
    expect(personIds('harbour')).toEqual([]);

    fx.repos.persons.update(p.id, {
      canonical: { surname: 'Newsurnamex', given: [], raw: 'NEWSURNAMEX', script: 'Latn' },
    });
    expect(personIds('newsurnamex')).toEqual([p.id]);
    expect(personIds('testsurname')).toEqual([]);
    fx.repos.persons.update(p.id, { state: 'merged' });
    expect(personIds('newsurnamex')).toEqual([]);
    expect(searchIds(fx.db, 'person', 'newsurnamex', 10, { includeMerged: true })).toEqual([p.id]);
    fx.repos.persons.update(p.id, { state: 'purged' });
    expect(searchIds(fx.db, 'person', 'newsurnamex', 10, { includeMerged: true })).toEqual([]);
  });

  it('swappable folder + rebuild', () => {
    const p = fx.repos.persons.insert(
      personInput({ canonical: { surname: 'Mohd', given: ['Synthetic'], raw: 'MOHD Synthetic', script: 'Latn' } }),
    );
    setSearchFolder((s) => defaultFoldForSearch(s).replace(/\bmohd\b/g, 'muhammad'));
    expect(foldForSearch('Mohd')).toBe('muhammad');
    rebuildAllSearch(fx.db);
    expect(personIds('muhammad')).toEqual([p.id]);
  });

  it('1,200 person inserts, then search < 150 ms', () => {
    const t0 = performance.now();
    fx.db.transaction(() => {
      for (let i = 0; i < 1200; i++) {
        fx.repos.persons.insert(
          personInput({
            canonical: {
              surname: `Synthsur${i.toString(36)}`,
              given: ['Given', `Gn${i}`],
              raw: `SYNTHSUR${i}`,
              script: 'Latn',
            },
            dob: `19${String(50 + (i % 50)).padStart(2, '0')}-0${1 + (i % 9)}-1${i % 10}`,
            identifiers: [
              { type: 'passport', value: `PP${100000 + i}`, valueFolded: `pp${100000 + i}`, issuingCountry: null },
            ],
          }),
        );
      }
    });
    const insertMs = performance.now() - t0;
    const t1 = performance.now();
    const r = searchAll(fx.db, 'synthsur', {}, { offset: 0, limit: 50 });
    const r2 = searchAll(fx.db, 'pp100777');
    const r3 = searchAll(fx.db, 'gn');
    const searchMs = performance.now() - t1;
    expect(r.groups[0]!.total).toBe(1200);
    expect(r2.groups[0]!.total).toBe(1);
    expect(r3.mode).toBe('like');
    expect(searchMs).toBeLessThan(150);
    expect(insertMs).toBeLessThan(10_000);
    console.info(`[perf] 1200 inserts ${insertMs.toFixed(0)} ms; 3 searches ${searchMs.toFixed(1)} ms`);
  });
});
