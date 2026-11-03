// Benchmark: 1,200 synthetic observations against 20,000 synthetic persons (in-memory source).
import { describe, expect, it } from 'vitest';
import {
  InMemoryCandidateSource,
  matchObservations,
  subjectFromObserved,
  targetFromPerson,
} from '../../../src/main/matching';
import type { Person } from '../../../src/shared/domain/types';
import { observed, person, rawDate } from './helpers';

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYL = ['ka', 'ri', 'to', 'mu', 'sa', 'le', 'vo', 'na', 'phe', 'qua', 'zen', 'dar', 'lo', 'mi', 'tha', 'rek'];

describe('matcher benchmark', () => {
  it('1,200 observations x 20,000 persons in a few seconds', () => {
    const r = rng(42);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
    const word = (n: number) =>
      Array.from({ length: n }, () => pick(SYL))
        .join('')
        .toUpperCase();
    const surnames = Array.from({ length: 600 }, () => word(3));
    const givens = Array.from({ length: 900 }, () => word(2));
    const date = () => {
      const y = 1960 + Math.floor(r() * 45);
      const m = 1 + Math.floor(r() * 12);
      const d = 1 + Math.floor(r() * 28);
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    };
    // Each person carries a synthetic passport number: a cross-request auto-link needs an ID (or unit + POB place).
    const passport = (i: number) => `BX${String(i).padStart(7, '0')}`;
    const persons: Person[] = Array.from({ length: 20_000 }, (_, i) =>
      person(`P${String(i).padStart(6, '0')}`, pick(surnames), [pick(givens), pick(givens)], date(), {
        identifiers: [{ type: 'passport', value: passport(i), valueFolded: passport(i), issuingCountry: 'ATLANTIS' }],
      }),
    );
    const source = new InMemoryCandidateSource(persons.map((p) => targetFromPerson(p)));

    const subjects = Array.from({ length: 1200 }, (_, i) => {
      if (i % 2 === 0) {
        const idx = Math.floor(r() * persons.length);
        const p = persons[idx] as Person;
        return subjectFromObserved(
          `S${i}`,
          observed({
            surname: p.canonical.surname,
            name1: p.canonical.given[0] ?? '',
            name2: p.canonical.given[1] ?? '',
            dob: rawDate(p.dob),
            passport: passport(idx),
          }),
        );
      }
      return subjectFromObserved(
        `S${i}`,
        observed({ surname: pick(surnames), name1: pick(givens), dob: rawDate(date()) }),
      );
    });

    const t0 = performance.now();
    const results = matchObservations(subjects, { source, now: () => '2026-11-03T00:00:00.000Z' });
    const ms = performance.now() - t0;
    console.log(`matcher benchmark: ${results.length} observations x ${persons.length} persons in ${ms.toFixed(0)} ms`);
    expect(results).toHaveLength(1200);
    expect(ms).toBeLessThan(10_000);
    const autos = results.filter((m) => m.decision === 'auto').length;
    expect(autos).toBeGreaterThan(400);
  }, 60_000);
});
