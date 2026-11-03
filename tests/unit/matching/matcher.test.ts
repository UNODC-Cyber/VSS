// Table tests for real-world patterns, with SYNTHETIC names only.
import { describe, expect, it } from 'vitest';
import {
  CONFLICT_EVIDENCE,
  InMemoryCandidateSource,
  NegativePairSet,
  assignTier,
  compareDob,
  compareNames,
  isPlaceholderDob,
  matchObservation,
  matchObservations,
  matchResponseRows,
  preselectedCandidate,
  subjectFromObserved,
  subjectFromRequestItem,
  swapDayMonth,
  targetFromPerson,
} from '../../../src/main/matching';
import type { MatchContext } from '../../../src/main/matching';
import { buildNameKey } from '../../../src/shared/names';
import { item, now, observed, person, rawDate, row } from './helpers';

const ctxWithin: MatchContext = { now };

describe('DOB comparison', () => {
  it('equal / swapped / conflict / missing / year-only / ambiguous', () => {
    const ex = (d: string | null) => ({ date: d, precision: d ? ('exact' as const) : ('unknown' as const) });
    expect(compareDob(ex('1990-03-07'), ex('1990-03-07'))).toBe('DOB_EQUAL');
    expect(compareDob(ex('1990-03-07'), ex('1990-07-03'))).toBe('DOB_SWAPPED');
    expect(compareDob(ex('1990-03-07'), ex('1990-03-08'))).toBe('DOB_CONFLICT');
    expect(compareDob(ex('1990-03-07'), ex(null))).toBe('DOB_MISSING');
    expect(compareDob({ date: '1990-01-01', precision: 'year-only' }, ex('1990-03-07'))).toBe('DOB_YEAR_EQUAL');
    expect(compareDob({ date: '1990-03-07', precision: 'ambiguous-dm' }, ex('1990-03-07'))).toBe('DOB_SWAPPED');
    expect(compareDob({ date: '1990-05-05', precision: 'ambiguous-dm' }, ex('1990-05-05'))).toBe('DOB_EQUAL');
    expect(swapDayMonth('1990-02-30')).toBeNull();
    expect(swapDayMonth('1990-03-31')).toBeNull();
    expect(swapDayMonth('1990-04-04')).toBeNull();
  });
});

describe('compareNames', () => {
  it('particle moved = full equal; extra particle = subset; initial = subset', () => {
    const a = buildNameKey('Qasrah bin Arkan Faizal');
    expect(compareNames(a, buildNameKey('Arkan Faizal bin Qasrah')).fullEqual).toBe(true);
    const p = compareNames(buildNameKey('Rajavel Nirmala Devi'), buildNameKey('Rajavel Nirmala Devi A/P'));
    expect(p.coreEqual).toBe(true);
    expect(p.fullEqual).toBe(false);
    expect(p.evidence).toContain('NAME_SUBSET_1');
    expect(compareNames(buildNameKey('Arkan J Velloso'), buildNameKey('Arkan Velloso')).evidence).toContain(
      'NAME_SUBSET_1',
    );
    expect(compareNames(buildNameKey('Arkan Velloso'), buildNameKey('Arkan Veloso')).evidence).toContain(
      'NAME_JW_HIGH',
    );
  });
  it('equivalent particle substitution (a/l vs s/o) is one difference, other substitutions two', () => {
    expect(compareNames(buildNameKey('Kumaran a/l Devan'), buildNameKey('Kumaran s/o Devan')).particleDistance).toBe(1);
    expect(compareNames(buildNameKey('Le Van Khiem'), buildNameKey('Do Van Khiem')).particleDistance).toBe(2);
  });
  it('surname evidence needs known surnames on both sides', () => {
    const a = { key: buildNameKey('Velloso Arkan'), surname: ['velloso'] };
    const b = { key: buildNameKey('Velloso Tomas'), surname: ['velloso'] };
    expect(compareNames(a, b).surnameEqual).toBe(true);
    expect(compareNames(a.key, b.key).surnameEqual).toBe(false);
  });
});

describe('assignTier', () => {
  it('follows the plan with tightenings', () => {
    expect(assignTier(['NAME_FULL_EQUAL', 'NAME_CORE_EQUAL', 'DOB_EQUAL'], 'within-request')).toBe('T1');
    expect(assignTier(['NAME_FULL_EQUAL', 'NAME_CORE_EQUAL', 'DOB_EQUAL'], 'cross-request')).toBe('T2');
    // F-06: birth country alone is no cross-request anchor any more
    expect(assignTier(['NAME_FULL_EQUAL', 'NAME_CORE_EQUAL', 'DOB_EQUAL', 'POB_COUNTRY_EQUAL'], 'cross-request')).toBe(
      'T2',
    );
    expect(
      assignTier(
        ['NAME_FULL_EQUAL', 'NAME_CORE_EQUAL', 'DOB_EQUAL', 'POB_COUNTRY_EQUAL', 'POB_PLACE_EQUAL', 'UNIT_EQUAL'],
        'cross-request',
      ),
    ).toBe('T1');
    expect(assignTier(['NAME_FULL_EQUAL', 'NAME_CORE_EQUAL', 'DOB_EQUAL', 'ID_EQUAL'], 'cross-request')).toBe('T1');
    expect(assignTier(['NAME_CORE_EQUAL', 'DOB_EQUAL', 'POB_COUNTRY_EQUAL'], 'cross-request')).toBe('T3');
    expect(assignTier(['NAME_FULL_EQUAL', 'NAME_CORE_EQUAL', 'DOB_EQUAL', 'SEX_CONFLICT'], 'within-request')).toBe(
      'T3',
    );
    expect(
      assignTier(['NAME_FULL_EQUAL', 'NAME_CORE_EQUAL', 'DOB_EQUAL', 'POB_CONFLICT', 'UNIT_EQUAL'], 'cross-request'),
    ).toBe('T2');
    expect(assignTier(['NAME_CORE_EQUAL', 'DOB_SWAPPED'], 'within-request')).toBe('T2');
    expect(assignTier(['NAME_CORE_EQUAL', 'DOB_CONFLICT', 'UNIT_EQUAL'], 'within-request')).toBe('T2');
    expect(assignTier(['NAME_CORE_EQUAL', 'DOB_CONFLICT'], 'cross-request')).toBeNull();
    expect(assignTier(['ID_EQUAL', 'DOB_EQUAL'], 'cross-request')).toBe('T2');
    expect(assignTier(['ID_EQUAL', 'DOB_CONFLICT'], 'cross-request')).toBe('T3');
    expect(assignTier(['NAME_SURNAME_EQUAL', 'DOB_EQUAL'], 'cross-request')).toBe('T3');
    expect(assignTier(['NAME_JW_HIGH', 'DOB_YEAR_EQUAL'], 'cross-request')).toBe('T3');
    expect(assignTier(['NAME_PHONETIC_EQUAL', 'DOB_EQUAL'], 'cross-request')).toBe('T3');
    expect(assignTier(['NAME_FULL_EQUAL', 'NAME_CORE_EQUAL', 'DOB_MISSING'], 'within-request')).toBe('T4');
    expect(assignTier(['NAME_SURNAME_EQUAL', 'DOB_CONFLICT'], 'cross-request')).toBeNull();
  });
});

describe('within-request: response rows vs one request', () => {
  const qasrah = item('I1', observed({ surname: 'BIN QASRAH', name1: 'ARKAN', name2: 'FAIZAL' }));

  it("'Bin X' surname moved to the end of given names auto-links", () => {
    const [m] = matchResponseRows([row('R1', 'QASRAH, ARKAN FAIZAL BIN ', '1990-03-07')], [qasrah], ctxWithin);
    expect(m?.decision).toBe('auto');
    expect(m?.chosen).toBe('I1');
    expect(m?.decidedAt).toBe('2026-11-03T00:00:00.000Z');
  });

  it("DC-added 'A/P' is T2 review, pre-selected, not auto", () => {
    const it1 = item('I2', observed({ surname: 'RAJAVEL', name1: 'NIRMALA', name2: 'DEVI', sex: 'F' }));
    const [m] = matchResponseRows([row('R2', 'RAJAVEL, NIRMALA DEVI A/P', '1990-03-07')], [it1], ctxWithin);
    expect(m?.decision).toBe('pending');
    expect(m?.candidates[0]?.tier).toBe('T2');
    expect(preselectedCandidate(m!)?.targetId).toBe('I2');
  });

  it('reordered multi-token surname auto-links', () => {
    const it1 = item('I3', observed({ surname: 'VELLOSO DIAZ', name1: 'ARKAN' }));
    const [m] = matchResponseRows([row('R3', 'DIAZ VELLOSO, ARKAN', '1990-03-07')], [it1], ctxWithin);
    expect(m?.decision).toBe('auto');
  });

  it('swapped day/month DOB is flagged (T2), never auto', () => {
    const [m] = matchResponseRows([row('R4', 'QASRAH, ARKAN FAIZAL BIN', '1990-07-03')], [qasrah], ctxWithin);
    expect(m?.decision).toBe('pending');
    expect(m?.candidates[0]?.evidence).toContain('DOB_SWAPPED');
  });

  it('Thai-script tokens match with tone-mark differences', () => {
    const tone = String.fromCodePoint(0x0e48);
    const it1 = item('I5', observed({ surname: 'ทองปอง', name1: 'สมศรี' }));
    const [m] = matchResponseRows([row('R5', `ทองป${tone}อง, สมศรี`, '1990-03-07')], [it1], ctxWithin);
    expect(m?.decision).toBe('auto');
  });

  it('same name, different DOB, same unit: T2 review only', () => {
    const [m] = matchResponseRows([row('R6', 'QASRAH, ARKAN FAIZAL BIN', '1991-11-21')], [qasrah], ctxWithin);
    expect(m?.decision).toBe('pending');
    expect(m?.candidates[0]?.evidence).toContain('DOB_CONFLICT');
  });

  it('identical duplicate request items: ambiguity veto', () => {
    const dup = item('I7', observed({ surname: 'BIN QASRAH', name1: 'ARKAN', name2: 'FAIZAL' }));
    const [m] = matchResponseRows([row('R7', 'QASRAH, ARKAN FAIZAL BIN', '1990-03-07')], [qasrah, dup], ctxWithin);
    expect(m?.decision).toBe('pending');
    expect(m?.candidates.filter((c) => c.tier === 'T1')).toHaveLength(2);
  });

  it('identical duplicate response rows: one-to-one check flags both', () => {
    const rows = [
      row('R8', 'QASRAH, ARKAN FAIZAL BIN', '1990-03-07'),
      row('R9', 'QASRAH, ARKAN FAIZAL BIN', '1990-03-07'),
    ];
    const ms = matchResponseRows(rows, [qasrah], ctxWithin);
    expect(ms.map((m) => m.decision)).toEqual(['pending', 'pending']);
    expect(ms.every((m) => m.chosen === null)).toBe(true);
  });

  it('ambiguous text DOB never auto-links', () => {
    const [m] = matchResponseRows(
      [row('R10', 'QASRAH, ARKAN FAIZAL BIN', '1990-03-07', { ambiguous: true })],
      [qasrah],
      ctxWithin,
    );
    expect(m?.decision).toBe('pending');
  });

  it('missing DOB: T4 info, pending, never auto', () => {
    const [m] = matchResponseRows([row('R11', 'QASRAH, ARKAN FAIZAL BIN', null)], [qasrah], ctxWithin);
    expect(m?.decision).toBe('pending');
    expect(m?.candidates[0]?.tier).toBe('T4');
  });

  it('unrelated row: none', () => {
    const [m] = matchResponseRows([row('R12', 'PHENGLOM, TIRAVAT', '1985-01-15')], [qasrah], ctxWithin);
    expect(m?.decision).toBe('none');
    expect(m?.candidates).toEqual([]);
  });

  it('different unit within the request blocks T1', () => {
    const [m] = matchResponseRows(
      [row('R13', 'QASRAH, ARKAN FAIZAL BIN', '1990-03-07', { unitName: 'Synthetic Unit Beta' })],
      [qasrah],
      ctxWithin,
    );
    expect(m?.decision).toBe('pending');
  });

  it('Vietnamese-style particles are real name parts: Le Van X vs Do Van X never auto', () => {
    const it1 = item('I14', observed({ surname: 'LE', name1: 'VAN', name2: 'KHIEM' }));
    const [m] = matchResponseRows([row('R14', 'DO, VAN KHIEM', '1990-03-07')], [it1], ctxWithin);
    expect(m?.decision).not.toBe('auto');
  });
});

describe('cross-request: observations vs persons', () => {
  const p1 = person('P1', 'VELLOSO', ['ARKAN'], '1990-03-07');
  const base = (over = {}) => subjectFromObserved('X1', observed({ surname: 'VELLOSO', name1: 'ARKAN', ...over }));
  const ctx = (persons: ReturnType<typeof person>[], extra: Partial<MatchContext> = {}): MatchContext => ({
    source: new InMemoryCandidateSource(persons.map((p) => targetFromPerson(p))),
    now,
    ...extra,
  });

  it('name + DOB + POB country equal: review (T2), not auto (F-06)', () => {
    const m = matchObservation(base(), ctx([p1]));
    expect(m.decision).toBe('pending');
    expect(m.candidates[0]?.tier).toBe('T2');
  });

  it('name + DOB + passport equal: auto', () => {
    const id = { type: 'passport' as const, value: 'AT1234567', valueFolded: 'AT1234567', issuingCountry: 'ATLANTIS' };
    const m = matchObservation(base({ passport: 'AT1234567' }), ctx([{ ...p1, identifiers: [id] }]));
    expect(m.decision).toBe('auto');
    expect(m.chosen).toBe('P1');
  });

  it('same name, different DOB: no candidate (must not link)', () => {
    const m = matchObservation(base({ dob: rawDate('1984-12-01') }), ctx([p1]));
    expect(m.decision).toBe('none');
  });

  it('same name + DOB but different unit and different POB: flagged, not auto', () => {
    const p = targetFromPerson(
      person('P2', 'VELLOSO', ['ARKAN'], '1990-03-07', { pob: { city: null, state: null, country: 'LEMURIA' } }),
      {
        unitIds: ['UNIT-Z'],
      },
    );
    const s = subjectFromObserved('X2', observed({ surname: 'VELLOSO', name1: 'ARKAN' }), { unitId: 'UNIT-A' });
    const m = matchObservation(s, { source: new InMemoryCandidateSource([p]), now });
    expect(m.decision).toBe('pending');
    expect(m.candidates[0]?.evidence).toEqual(expect.arrayContaining(['POB_CONFLICT', 'UNIT_CONFLICT']));
  });

  it('same name + DOB, no anchor at all (POB unknown): flagged', () => {
    const p = person('P3', 'VELLOSO', ['ARKAN'], '1990-03-07', { pob: { city: null, state: null, country: null } });
    const m = matchObservation(base(), ctx([p]));
    expect(m.decision).toBe('pending');
    expect(m.candidates[0]?.tier).toBe('T2');
  });

  it('sex conflict and ID conflict block auto', () => {
    expect(matchObservation(base({ sex: 'F' }), ctx([p1])).decision).toBe('pending');
    const withId = person('P4', 'VELLOSO', ['ARKAN'], '1990-03-07', {
      identifiers: [{ type: 'passport', value: 'AT1234567', valueFolded: 'AT1234567', issuingCountry: 'ATLANTIS' }],
    });
    const m = matchObservation(base({ passport: 'AT7654321' }), ctx([withId]));
    expect(m.decision).toBe('pending');
    expect(m.candidates[0]?.evidence).toContain('ID_CONFLICT');
  });

  it('ID alone is T3', () => {
    const withId = person('P5', 'PHENGLOM', ['TIRAVAT'], '1975-05-20', {
      identifiers: [{ type: 'passport', value: 'AT1234567', valueFolded: 'AT1234567', issuingCountry: 'ATLANTIS' }],
    });
    const m = matchObservation(base({ passport: 'at 1234567' }), ctx([withId]));
    expect(m.candidates[0]?.tier).toBe('T3');
    expect(m.decision).toBe('pending');
  });

  it('two persons at T1: ambiguity veto', () => {
    const m = matchObservation(base(), ctx([p1, person('P6', 'VELLOSO', ['ARKAN'], '1990-03-07')]));
    expect(m.decision).toBe('pending');
  });

  it('T1 plus a T2 alternative (possible duplicate person): veto', () => {
    const m = matchObservation(base(), ctx([p1, person('P7', 'VELLOSO', ['ARKAN'], '1990-07-03')]));
    expect(m.decision).toBe('pending');
  });

  it('negative pair suppresses re-proposal', () => {
    const m = matchObservation(base(), ctx([p1], { negativePairs: new NegativePairSet([['X1', 'P1']]) }));
    expect(m.decision).toBe('none');
  });

  it('merged persons are ignored', () => {
    const m = matchObservation(base(), ctx([person('P8', 'VELLOSO', ['ARKAN'], '1990-03-07', { state: 'merged' })]));
    expect(m.decision).toBe('none');
  });

  it('alias names are matched', () => {
    const p = person('P9', 'VELLOSO', ['ARKAN'], '1990-03-07', {
      aliases: [{ surname: 'QASRAH', given: ['NURIN'], raw: 'QASRAH NURIN', script: 'Latn' }],
    });
    const m = matchObservation(subjectFromObserved('X3', observed({ surname: 'QASRAH', name1: 'NURIN' })), ctx([p]));
    expect(m.candidates[0]?.targetId).toBe('P9');
    expect(m.candidates[0]?.evidence).toContain('NAME_FULL_EQUAL');
  });

  it('surname + DOB with different given names: T3; typo in surname: T3 via JW', () => {
    const m = matchObservation(base({ name1: 'TOMAS' }), ctx([p1]));
    expect(m.candidates[0]?.tier).toBe('T3');
    const t = matchObservation(base({ surname: 'VELOSO' }), ctx([p1]));
    expect(t.candidates[0]?.tier).toBe('T3');
    expect(t.candidates[0]?.evidence).toContain('NAME_JW_HIGH');
  });

  it('never auto-creates a person and never auto-links two batch items to one person', () => {
    const a = subjectFromRequestItem(item('IA', observed({ surname: 'VELLOSO', name1: 'ARKAN' })));
    const b = subjectFromRequestItem(item('IB', observed({ surname: 'VELLOSO', name1: 'ARKAN' })));
    const ms = matchObservations([a, b], ctx([p1]));
    expect(ms.map((m) => m.decision)).toEqual(['pending', 'pending']);
    const unknown = matchObservation(
      subjectFromObserved('X9', observed({ surname: 'ZORVAN', name1: 'KELI' })),
      ctx([p1]),
    );
    expect(unknown.decision).toBe('none');
    expect(unknown.chosen).toBeNull();
  });
});

describe('F-06 cross-request anchors, placeholder DOBs, extra conflicts', () => {
  const at = (s: string) => ({ city: s.split('/')[0] || null, state: s.split('/')[1] || null, country: 'ATLANTIS' });
  const target = (dob: string, pob = '/', units: string[] = ['UNIT-A'], fatherNames: string[] = []) =>
    targetFromPerson(person('P1', 'VELLOSO', ['ARKAN'], dob, { pob: at(pob) }), { unitIds: units, fatherNames });
  const subject = (dob: string, over: Record<string, string> = {}, unitId: string | null = 'UNIT-A') =>
    subjectFromObserved('X1', observed({ surname: 'VELLOSO', name1: 'ARKAN', dob: rawDate(dob), ...over }), {
      unitId,
    });
  const run = (s: ReturnType<typeof subject>, t: ReturnType<typeof target>) =>
    matchObservation(s, { source: new InMemoryCandidateSource([t]), now });

  it('same unit + same POB city: auto; same unit + country only: review', () => {
    expect(run(subject('1990-03-07', { pobCity: 'Port Velo' }), target('1990-03-07', 'PORT VELO/')).decision).toBe(
      'auto',
    );
    const m = run(subject('1990-03-07'), target('1990-03-07'));
    expect(m.decision).toBe('pending');
    expect(m.candidates[0]?.evidence).toEqual(expect.arrayContaining(['UNIT_EQUAL', 'POB_COUNTRY_EQUAL']));
  });

  it('POB city equal but different unit: review (unit and place are both needed without an ID)', () => {
    const m = run(subject('1990-03-07', { pobCity: 'Port Velo' }, 'UNIT-B'), target('1990-03-07', 'PORT VELO/'));
    expect(m.decision).toBe('pending');
  });

  it('different POB city (same country): POB_PLACE_CONFLICT, never auto even with an equal ID', () => {
    const id = { type: 'passport' as const, value: 'AT1234567', valueFolded: 'AT1234567', issuingCountry: 'ATLANTIS' };
    const t = targetFromPerson(
      person('P1', 'VELLOSO', ['ARKAN'], '1990-03-07', { pob: at('NORTHPORT/'), identifiers: [id] }),
      { unitIds: ['UNIT-A'] },
    );
    const m = run(subject('1990-03-07', { pobCity: 'Southport', passport: 'AT1234567' }), t);
    expect(m.decision).toBe('pending');
    expect(m.candidates[0]?.evidence).toContain('POB_PLACE_CONFLICT');
  });

  for (const dob of ['1990-01-01', '1990-07-01', '1990-12-31', '1900-03-07']) {
    it(`placeholder DOB ${dob} never auto-links, even with an equal passport`, () => {
      const id = {
        type: 'passport' as const,
        value: 'AT1234567',
        valueFolded: 'AT1234567',
        issuingCountry: 'ATLANTIS',
      };
      const t = targetFromPerson(
        person('P1', 'VELLOSO', ['ARKAN'], dob, { pob: at('PORT VELO/'), identifiers: [id] }),
        { unitIds: ['UNIT-A'] },
      );
      const m = run(subject(dob, { pobCity: 'Port Velo', passport: 'AT1234567' }), t);
      expect(m.decision).toBe('pending');
      expect(m.candidates[0]?.evidence).toContain('DOB_PLACEHOLDER');
      expect(isPlaceholderDob(dob)).toBe(true);
    });
  }

  it('placeholder DOB also blocks auto within one request', () => {
    const it1 = item('I1', observed({ surname: 'VELLOSO', name1: 'ARKAN', dob: rawDate('1990-01-01') }));
    const [m] = matchResponseRows([row('R1', 'VELLOSO, ARKAN', '1990-01-01')], [it1], { now });
    expect(m?.decision).toBe('pending');
  });

  it("different father's name: FATHER_CONFLICT (conflict evidence), never auto", () => {
    const m = run(
      subject('1990-03-07', { pobCity: 'Port Velo', fatherName: 'Tomas Velloso' }),
      target('1990-03-07', 'PORT VELO/', ['UNIT-A'], ['Rafael Velloso Quintas']),
    );
    expect(m.decision).toBe('auto'); // shares a token (velloso): not a conflict
    const c = run(
      subject('1990-03-07', { pobCity: 'Port Velo', fatherName: 'Tomas Arno' }),
      target('1990-03-07', 'PORT VELO/', ['UNIT-A'], ['Rafael Quintas']),
    );
    expect(c.decision).toBe('pending');
    expect(c.candidates[0]?.evidence).toContain('FATHER_CONFLICT');
    expect(CONFLICT_EVIDENCE).toContain('FATHER_CONFLICT');
  });

  it('different passport numbers are ID_CONFLICT and cap the candidate at T3', () => {
    const id = { type: 'passport' as const, value: 'AT1234567', valueFolded: 'AT1234567', issuingCountry: 'ATLANTIS' };
    const t = targetFromPerson(
      person('P1', 'VELLOSO', ['ARKAN'], '1990-03-07', { pob: at('PORT VELO/'), identifiers: [id] }),
      { unitIds: ['UNIT-A'] },
    );
    const m = run(subject('1990-03-07', { pobCity: 'Port Velo', passport: 'AT7654321' }), t);
    expect(m.decision).toBe('pending');
    expect(m.candidates[0]?.tier).toBe('T3');
    expect(m.candidates[0]?.evidence).toContain('ID_CONFLICT');
  });
});
