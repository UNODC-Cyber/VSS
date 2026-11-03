/** Spec model for synthetic request fixtures plus the expected parse results derived from it (not from the parser). */
import type { IsoDate, ObservedPerson, ObservedUnit, RawDate } from '../../src/shared/domain/types.ts';
import { isoToSerial } from '../../src/main/formats/ooxml/dates.ts';
import { chance, genName, genPlace, genWord, int, pick, cultureCountry, type Culture, type Rng } from './grammar.ts';

export type DobSpec =
  | { kind: 'serial'; iso: IsoDate }
  | { kind: 'text'; text: string; parsed: IsoDate | null; ambiguous: boolean }
  | { kind: 'empty' };

export interface UnitSpec {
  name: string;
  type: string;
  country: string;
  unitIdNo?: string;
  alias?: string;
  location?: string;
  description?: string;
  englishDescription?: string;
  branchName?: string;
  branchDescription?: string;
  parentOrg?: string;
  subordinateOrg?: string;
  orgLevel?: string;
}

export interface PersonSpec {
  unit: string;
  /** null leaves the cell empty. */
  isHead: boolean | null;
  surname: string;
  names: string[];
  passport?: string;
  nationalId?: string;
  titleRank?: string;
  father?: string;
  mother?: string;
  dob: DobSpec;
  pobCity?: string;
  pobState?: string;
  pobCountry: string;
  nationality?: string;
  searchCountry: string;
  sex: string;
  culture?: Culture;
}

export interface ExpectedIssue {
  rule: string;
  code: string;
  severity: 'error' | 'warning' | 'info';
  rowRef: string | null;
  field: string | null;
}

export interface RequestSpec {
  id: string;
  description: string;
  /** Unit block rows in file order; null is a blank row inside the block. */
  unitRows: (UnitSpec | null)[];
  people: PersonSpec[];
  /** Overrides for the version cells of the instructions sheet. */
  versionCells?: { a2?: string; c2?: string };
  /** Structural issues (R-01..R-05) that parseInvestc must report. */
  parseIssues: ExpectedIssue[];
  /** Value issues (R-06..R-14) that validateRequest must report with no lookups. */
  validationIssues: ExpectedIssue[];
  /** For the error fixture: rule id to the rows that violate it. */
  ruleMap?: Record<string, string[]>;
}

export const unitRowRef = (unitIndex: number): string => `Data!${4 + unitIndex}`;
/** Row of person `i` for a block with `unitRows` unit rows (X-04 row map). */
export const personRowRef = (unitRows: number, i: number): string => `Data!${4 + unitRows + 4 + i}`;

const emptyRaw: RawDate = { kind: 'empty', value: '', parsed: null, ambiguousDayMonth: false };

export function rawDate(d: DobSpec): RawDate {
  switch (d.kind) {
    case 'empty':
      return emptyRaw;
    case 'serial': {
      const s = isoToSerial(d.iso);
      if (s === null) throw new Error(`bad DOB ${d.iso}`);
      return { kind: 'serial', value: String(s), parsed: d.iso, ambiguousDayMonth: false };
    }
    case 'text':
      return { kind: 'text', value: d.text, parsed: d.parsed, ambiguousDayMonth: d.ambiguous };
  }
}

export function expectedUnit(u: UnitSpec, rowRef: string): ObservedUnit {
  return {
    rowRef,
    name: u.name,
    unitIdNo: u.unitIdNo ?? '',
    type: u.type,
    alias: u.alias ?? '',
    location: u.location ?? '',
    description: u.description ?? '',
    englishDescription: u.englishDescription ?? '',
    branchName: u.branchName ?? '',
    branchDescription: u.branchDescription ?? '',
    parentOrg: u.parentOrg ?? '',
    subordinateOrg: u.subordinateOrg ?? '',
    orgLevel: u.orgLevel ?? '',
    country: u.country,
  };
}

export function expectedPerson(p: PersonSpec, rowRef: string): ObservedPerson {
  return {
    rowRef,
    unitName: p.unit,
    isHeadOfUnit: p.isHead,
    surname: p.surname,
    name1: p.names[0] ?? '',
    name2: p.names[1] ?? '',
    name3: p.names[2] ?? '',
    name4: p.names[3] ?? '',
    passport: p.passport ?? '',
    nationalId: p.nationalId ?? '',
    titleRank: p.titleRank ?? '',
    fatherName: p.father ?? '',
    motherName: p.mother ?? '',
    dob: rawDate(p.dob),
    pobCity: p.pobCity ?? '',
    pobState: p.pobState ?? '',
    pobCountry: p.pobCountry,
    nationality: p.nationality ?? '',
    searchCountry: p.searchCountry,
    sex: p.sex,
  };
}

// ---- Generation ---------------------------------------------------------------------------------------------------

/** Reference "today" for DOB generation (matches the `now` used in goldens). */
export const FIXTURE_NOW = '2026-11-03';

export interface Counters {
  passport: number;
  nationalId: number;
  unit: number;
}
export const newCounters = (): Counters => ({ passport: 0, nationalId: 0, unit: 0 });

const RANKS = ['Captain', 'Inspector', 'Sergeant', 'Officer', 'Investigator', 'Analyst'];

export function genDob(rng: Rng): IsoDate {
  const year = Number(FIXTURE_NOW.slice(0, 4)) - int(rng, 21, 59);
  const month = int(rng, 1, 12);
  const day = int(rng, 1, 28);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export interface PersonOptions {
  culture: Culture;
  unit: string;
  searchCountry: string;
  isHead: boolean;
  withId?: boolean;
  sex?: 'M' | 'F';
}

/** One synthetic individual. Passport numbers run ZZ000001.., national IDs ZN000001.. */
export function genPerson(rng: Rng, c: Counters, o: PersonOptions): PersonSpec {
  const n = genName(rng, o.culture, o.sex);
  const place = genPlace(rng, o.culture);
  const country = cultureCountry(o.culture, rng);
  const withId = o.withId ?? chance(rng, 0.5);
  const passport = withId && chance(rng, 0.8) ? `ZZ${String(++c.passport).padStart(6, '0')}` : undefined;
  const nationalId = withId && !passport ? `ZN${String(++c.nationalId).padStart(6, '0')}` : undefined;
  const p: PersonSpec = {
    unit: o.unit,
    isHead: o.isHead,
    surname: n.surname,
    names: n.names,
    dob: { kind: 'serial', iso: genDob(rng) },
    pobCity: place.city,
    pobCountry: country,
    searchCountry: o.searchCountry,
    sex: n.sex,
    culture: o.culture,
  };
  if (chance(rng, 0.6)) p.pobState = place.state;
  if (passport) p.passport = passport;
  if (nationalId) p.nationalId = nationalId;
  if (passport || nationalId || chance(rng, 0.5)) p.nationality = country;
  if (chance(rng, 0.4)) p.titleRank = pick(rng, RANKS);
  if (chance(rng, 0.3)) p.father = genWord(rng, o.culture, 2);
  if (chance(rng, 0.3)) p.mother = genWord(rng, o.culture, 2);
  return p;
}

const UNIT_KINDS = [
  'Provincial Police',
  'Border Police',
  'Cyber Crime',
  'Highway Patrol',
  'Forensic Services',
  'Narcotics Suppression',
  'Anti-Fraud',
  'Digital Evidence',
];
const UNIT_FORMS = ['Division', 'Bureau', 'Unit', 'Battalion', 'Directorate', 'Section'];

/** "Example Provincial Police Division 7" style unit with a unique name (index folded into the number). */
export function genUnit(rng: Rng, c: Counters, country: string, type = 'Police'): UnitSpec {
  const n = ++c.unit;
  const u: UnitSpec = {
    name: `Example ${pick(rng, UNIT_KINDS)} ${pick(rng, UNIT_FORMS)} ${n}`,
    type,
    country,
  };
  if (chance(rng, 0.4)) u.unitIdNo = `EX-${String(n).padStart(4, '0')}`;
  if (chance(rng, 0.3)) u.location = `Example Province ${int(rng, 1, 9)}`;
  return u;
}

/** A unit with `n` people of the given cultures (round-robin); the first is head of unit. */
export function genUnitPeople(
  rng: Rng,
  c: Counters,
  unit: UnitSpec,
  n: number,
  cultures: readonly Culture[],
): PersonSpec[] {
  const out: PersonSpec[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      genPerson(rng, c, {
        culture: cultures[i % cultures.length] as Culture,
        unit: unit.name,
        searchCountry: unit.country,
        isHead: i === 0,
      }),
    );
  }
  return out;
}
