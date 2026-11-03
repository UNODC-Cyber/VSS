// Property: one batch never auto-links two subjects to the same person (pure matcher and through the service).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ObservedPerson } from '@shared/domain/types';
import { matchObservations } from '../../../src/main/matching/matcher';
import { subjectFromObserved, targetFromPerson } from '../../../src/main/matching/records';
import { InMemoryCandidateSource } from '../../../src/main/matching/source';
import type { Person } from '@shared/domain/types';
import { harness, manualItem, manualRequest, unwrap } from './helpers';

const SURNAMES = ['Alphaname', 'Betaname', 'Gammaname'];
const GIVEN = ['Synth', 'Synthia'];
const DOBS = ['1980-01-02', '1980-02-01', '1985-05-05'];
const COUNTRIES = ['TESTLAND', 'OTHERLAND'];

const obsArb = fc.record({
  surname: fc.constantFrom(...SURNAMES),
  given: fc.constantFrom(...GIVEN),
  dob: fc.constantFrom(...DOBS),
  pob: fc.constantFrom(...COUNTRIES),
  sex: fc.constantFrom('M', 'F', ''),
});
interface Obs {
  surname: string;
  given: string;
  dob: string;
  pob: string;
  sex: string;
}

function observed(o: Obs, i: number): ObservedPerson {
  return {
    rowRef: `Data!${10 + i}`,
    unitName: 'Synthetic Unit One',
    isHeadOfUnit: false,
    surname: o.surname,
    name1: o.given,
    name2: '',
    name3: '',
    name4: '',
    passport: '',
    nationalId: '',
    titleRank: '',
    fatherName: '',
    motherName: '',
    dob: { kind: 'text', value: o.dob, parsed: o.dob, ambiguousDayMonth: false },
    pobCity: '',
    pobState: '',
    pobCountry: o.pob,
    nationality: o.pob,
    searchCountry: o.pob,
    sex: o.sex,
  };
}
function person(o: Obs, i: number): Person {
  return {
    id: `P${String(i).padStart(25, '0')}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    canonical: { surname: o.surname, given: [o.given], raw: `${o.surname} ${o.given}`, script: 'Latn' },
    aliases: [],
    dob: o.dob,
    dobPrecision: 'exact',
    sex: o.sex === 'M' || o.sex === 'F' ? o.sex : null,
    pob: { city: null, state: null, country: o.pob },
    nationality: o.pob,
    identifiers: [],
    state: 'active',
    mergedInto: null,
    notes: '',
  };
}

describe('one-to-one auto links', () => {
  it('matchObservations never auto-links two batch rows to one person', () => {
    fc.assert(
      fc.property(
        fc.array(obsArb, { minLength: 0, maxLength: 6 }),
        fc.array(obsArb, { minLength: 1, maxLength: 8 }),
        (ps, batch) => {
          const source = new InMemoryCandidateSource(ps.map((p, i) => targetFromPerson(person(p, i))));
          const ms = matchObservations(
            batch.map((o, i) => subjectFromObserved(`I${String(i).padStart(25, '0')}`, observed(o, i))),
            { source, mode: 'cross-request' },
          );
          const chosen = ms.filter((m) => m.decision === 'auto').map((m) => m.chosen);
          expect(new Set(chosen).size).toBe(chosen.length);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('through the requests service: at most one auto-linked item per person per request', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(obsArb, { minLength: 1, maxLength: 4 }),
        fc.array(obsArb, { minLength: 1, maxLength: 5 }),
        async (first, second) => {
          const h = harness();
          try {
            const toItem = (o: Obs) =>
              manualItem({
                surname: o.surname,
                givenNames: [o.given],
                dob: o.dob,
                pobCountry: o.pob,
                sex: o.sex === '' ? null : (o.sex as 'M' | 'F'),
              });
            unwrap(await h.svc.requests.createManual(manualRequest(first.map(toItem))));
            const s = unwrap(await h.svc.requests.createManual(manualRequest(second.map(toItem))));
            const autos = h.fx.repos.requests
              .listItems(s.id)
              .filter((i) => i.linkState === 'auto')
              .map((i) => i.personId);
            expect(new Set(autos).size).toBe(autos.length);
            // nobody is created for a flagged row
            for (const it of h.fx.repos.requests.listItems(s.id))
              if (it.linkState === 'pending-review') expect(it.personId).toBeNull();
          } finally {
            h.cleanup();
          }
        },
      ),
      { numRuns: 15 },
    );
  });
});
