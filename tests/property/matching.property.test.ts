import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CONFLICT_EVIDENCE,
  InMemoryCandidateSource,
  assignTier,
  matchObservation,
  matchResponseRows,
  subjectFromObserved,
  targetFromPerson,
} from '../../src/main/matching';
import type { MatchEvidence, RowMatch } from '../../src/shared/domain/types';
import { item, now, observed, person, rawDate, row } from '../unit/matching/helpers';

const ALL_EVIDENCE: MatchEvidence[] = [
  'NAME_CORE_EQUAL',
  'NAME_FULL_EQUAL',
  'NAME_SUBSET_1',
  'NAME_SURNAME_EQUAL',
  'NAME_JW_HIGH',
  'NAME_PHONETIC_EQUAL',
  'DOB_EQUAL',
  'DOB_SWAPPED',
  'DOB_YEAR_EQUAL',
  'DOB_CONFLICT',
  'DOB_MISSING',
  'POB_COUNTRY_EQUAL',
  'POB_CONFLICT',
  'UNIT_EQUAL',
  'UNIT_CONFLICT',
  'ID_EQUAL',
  'ID_CONFLICT',
  'SEX_CONFLICT',
  'POB_PLACE_EQUAL',
  'POB_PLACE_CONFLICT',
  'DOB_PLACEHOLDER',
  'FATHER_CONFLICT',
];

const SURNAMES = ['VELLOSO', 'QASRAH', 'PHENGLOM', 'BIN QASRAH', 'VELOSO'];
const GIVEN = ['ARKAN', 'NURIN', 'TIRAVAT', 'ARKAN FAIZAL', 'A/L ARKAN'];
const DOBS = [null, '1990-03-07', '1990-07-03', '1990-03-08', '1985-12-01', '1985-01-01'];
const COUNTRIES = [null, 'ATLANTIS', 'LEMURIA'];
const SEXES = ['M', 'F', ''];
const IDS = ['', 'AT1234567', 'AT7654321'];

const personArb = fc.record({
  surname: fc.constantFrom(...SURNAMES),
  given: fc.constantFrom(...GIVEN),
  dob: fc.constantFrom(...DOBS),
  country: fc.constantFrom(...COUNTRIES),
  sex: fc.constantFrom('M', 'F', null),
  id: fc.constantFrom(...IDS),
  unit: fc.constantFrom('U1', 'U2', null),
});
const obsArb = fc.record({
  surname: fc.constantFrom(...SURNAMES),
  given: fc.constantFrom(...GIVEN),
  dob: fc.constantFrom(...DOBS),
  ambiguous: fc.boolean(),
  country: fc.constantFrom(...COUNTRIES),
  sex: fc.constantFrom(...SEXES),
  id: fc.constantFrom(...IDS),
  unit: fc.constantFrom('U1', 'U2', null),
});

function assertSafe(m: RowMatch, subjectDobMissing: boolean): void {
  const t1 = m.candidates.filter((c) => c.tier === 'T1');
  for (const c of m.candidates) {
    if (c.evidence.some((e) => CONFLICT_EVIDENCE.includes(e) || e === 'DOB_MISSING')) expect(c.tier).not.toBe('T1');
  }
  if (m.decision === 'auto') {
    expect(t1).toHaveLength(1);
    expect(subjectDobMissing).toBe(false);
    const chosen = m.candidates.find((c) => c.targetId === m.chosen);
    expect(chosen?.tier).toBe('T1');
    expect(chosen?.evidence.some((e) => CONFLICT_EVIDENCE.includes(e))).toBe(false);
    expect(chosen?.evidence).toContain('DOB_EQUAL');
    expect(chosen?.evidence).not.toContain('DOB_PLACEHOLDER');
  } else {
    expect(m.chosen).toBeNull();
  }
}

describe('matcher safety properties', { timeout: 60_000 }, () => {
  it('assignTier: never T1 with conflict evidence, missing DOB or without DOB_EQUAL', () => {
    fc.assert(
      fc.property(
        fc.subarray(ALL_EVIDENCE),
        fc.constantFrom('cross-request' as const, 'within-request' as const),
        (ev, mode) => {
          if (assignTier(ev, mode) !== 'T1') return;
          expect(ev.some((e) => CONFLICT_EVIDENCE.includes(e))).toBe(false);
          expect(ev).not.toContain('DOB_MISSING');
          expect(ev).toContain('DOB_EQUAL');
          // F-06: placeholder DOBs and father conflicts never auto-link; cross-request needs a strong anchor
          expect(ev).not.toContain('DOB_PLACEHOLDER');
          expect(ev).not.toContain('FATHER_CONFLICT');
          if (mode === 'cross-request') {
            expect(ev).not.toContain('POB_PLACE_CONFLICT');
            expect(ev.includes('ID_EQUAL') || (ev.includes('UNIT_EQUAL') && ev.includes('POB_PLACE_EQUAL'))).toBe(true);
          }
        },
      ),
      { numRuns: 5000 },
    );
  });

  it('matchObservation: auto only for a single conflict-free T1 with DOB present', () => {
    fc.assert(
      fc.property(fc.array(personArb, { maxLength: 6 }), obsArb, (ps, o) => {
        const persons = ps.map((p, i) =>
          person(`P${i}`, p.surname, [p.given], p.dob, {
            pob: { city: null, state: null, country: p.country },
            sex: p.sex,
            identifiers: p.id ? [{ type: 'passport', value: p.id, valueFolded: p.id, issuingCountry: 'ATLANTIS' }] : [],
          }),
        );
        const source = new InMemoryCandidateSource(
          persons.map((p, i) => targetFromPerson(p, { unitIds: ps[i]?.unit ? [ps[i]!.unit!] : [] })),
        );
        const subject = subjectFromObserved(
          'S',
          observed({
            surname: o.surname,
            name1: o.given,
            dob: rawDate(o.dob, o.ambiguous),
            pobCountry: o.country ?? '',
            sex: o.sex,
            passport: o.id,
          }),
          { unitId: o.unit },
        );
        const m = matchObservation(subject, { source, now });
        assertSafe(m, o.dob === null);
        if (o.dob !== null && o.ambiguous) expect(m.decision).not.toBe('auto');
      }),
      { numRuns: 3000 },
    );
  });

  it('matchResponseRows: safe and one-to-one', () => {
    fc.assert(
      fc.property(
        fc.array(obsArb, { minLength: 1, maxLength: 5 }),
        fc.array(obsArb, { minLength: 1, maxLength: 5 }),
        (its, rs) => {
          const items = its.map((o, i) =>
            item(
              `I${i}`,
              observed({ surname: o.surname, name1: o.given, dob: rawDate(o.dob), pobCountry: o.country ?? '' }),
              'UNIT-A',
            ),
          );
          const rows = rs.map((o, i) =>
            row(`R${i}`, `${o.surname}, ${o.given}`, o.dob, { pobCountry: o.country, ambiguous: o.ambiguous }),
          );
          const ms = matchResponseRows(rows, items, { now });
          ms.forEach((m, i) => assertSafe(m, rs[i]?.dob === null));
          const chosen = ms.filter((m) => m.decision === 'auto').map((m) => m.chosen);
          expect(new Set(chosen).size).toBe(chosen.length);
        },
      ),
      { numRuns: 2000 },
    );
  });
});
