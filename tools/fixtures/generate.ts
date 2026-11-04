/**
 * Deterministic generator for ALL synthetic fixtures (requests, responses, goldens).
 *
 *   node tools/fixtures/generate.ts          writes fixtures/requests, fixtures/responses, the *.expected.json goldens
 *                                            and fixtures/purity-allowlist.json
 *   node tools/fixtures/generate.ts --check  regenerates in memory and fails if the committed files differ
 *
 * Every name, place, unit and number comes from the seeded grammars in grammar.ts. Request workbooks are written from
 * scratch by investc-workbook.ts (no third-party template is involved). The expected files are derived from the
 * fixture specs, never from the parsers, so they are an independent oracle for the parser tests.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { addDays } from '../../src/main/formats/ooxml/dates.ts';
import { coreKey } from '../../src/main/formats/investc/names.ts';
import { createRng, genWord, type Culture, type Rng } from './grammar.ts';
import {
  expectedPerson,
  expectedUnit,
  genPerson,
  genUnit,
  genUnitPeople,
  newCounters,
  personRowRef,
  unitRowRef,
  type Counters,
  type ExpectedIssue,
  type PersonSpec,
  type RequestSpec,
  type UnitSpec,
} from './model.ts';
import { blankStrings } from './investc-workbook.ts';
import { buildRequestWorkbook } from './request-builder.ts';
import {
  buildResponseWorkbook,
  type ResponseRowSpec,
  type ResponseSectionSpec,
  type ResponseWorkbookSpec,
} from './response-builder.ts';

export const FIXTURE_NOW_ISO = '2026-11-03';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = resolve(here, '../../fixtures');

/**
 * canonicalJson, laid out the way Prettier prints JSON (printWidth 120): objects expanded, arrays of primitives on one
 * line when they fit. The response goldens use it so `npm run format:check` and `generate.ts --check` agree.
 */
export function prettyCanonicalJson(value: unknown, width = 120): string {
  const sorted = JSON.parse(canonicalJson(value, 0)) as unknown;
  const prim = (v: unknown): boolean => v === null || typeof v !== 'object';
  const print = (v: unknown, indent: string, prefix: string, comma: string): string => {
    if (prim(v)) return `${indent}${prefix}${JSON.stringify(v)}${comma}`;
    const inner = `${indent}  `;
    if (Array.isArray(v)) {
      if (v.length === 0) return `${indent}${prefix}[]${comma}`;
      if (v.every(prim)) {
        const one = `${indent}${prefix}[${v.map((x) => JSON.stringify(x)).join(', ')}]${comma}`;
        if (one.length <= width) return one;
      }
      const items = v.map((x, i) => print(x, inner, '', i < v.length - 1 ? ',' : ''));
      return `${indent}${prefix}[\n${items.join('\n')}\n${indent}]${comma}`;
    }
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return `${indent}${prefix}{}${comma}`;
    const items = entries.map(([k, x], i) =>
      print(x, inner, `${JSON.stringify(k)}: `, i < entries.length - 1 ? ',' : ''),
    );
    return `${indent}${prefix}{\n${items.join('\n')}\n${indent}}${comma}`;
  };
  return `${print(sorted, '', '', '')}\n`;
}

/** Stable JSON: object keys sorted, 2-space indent. */
export function canonicalJson(value: unknown, indent = 2): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(sort(value), null, indent) + '\n';
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export interface FixtureFile {
  /** Path relative to the fixtures directory. */
  path: string;
  data: Uint8Array | string;
}
export interface GeneratedFixtures {
  files: FixtureFile[];
  /** Strings written into each generated workbook beyond the template's own (path -> strings). */
  xlsxStrings: Map<string, Set<string>>;
}

// ---- Small helpers -------------------------------------------------------------------------------------------------

const serialDob = (iso: string) => ({ kind: 'serial', iso }) as const;
const issue = (
  rule: string,
  code: string,
  severity: ExpectedIssue['severity'],
  rowRef: string | null,
  field: string | null,
): ExpectedIssue => ({ rule, code, severity, rowRef, field });

/** Person with a unique (core name + DOB) inside `seen`. */
function uniquePerson(rng: Rng, c: Counters, seen: Set<string>, o: Parameters<typeof genPerson>[2]): PersonSpec {
  for (let i = 0; i < 50; i++) {
    const p = genPerson(rng, c, o);
    const key = `${coreKey(p.surname, ...p.names)}|${p.dob.kind === 'serial' ? p.dob.iso : ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      return p;
    }
  }
  throw new Error('could not draw a unique person');
}

// ---- Request specs --------------------------------------------------------------------------------------------------

function specBasic(): RequestSpec {
  const rng = createRng('vss-fixtures/req-001-basic');
  const c = newCounters();
  const u1 = genUnit(rng, c, 'THAILAND', 'Police');
  const u2 = genUnit(rng, c, 'LAOS', 'Military');
  const people = [...genUnitPeople(rng, c, u1, 3, ['thai']), ...genUnitPeople(rng, c, u2, 3, ['lao'])];
  return {
    id: 'req-001-basic',
    description: 'Two units, six people, serial DOBs, no violations.',
    unitRows: [u1, u2],
    people,
    parseIssues: [],
    validationIssues: [],
  };
}

function specMalay(): RequestSpec {
  const rng = createRng('vss-fixtures/req-002-malay-particles');
  const c = newCounters();
  const unit = genUnit(rng, c, 'MALAYSIA', 'Police');
  const mk = (culture: Culture, sex: 'M' | 'F', head: boolean): PersonSpec =>
    genPerson(rng, c, { culture, unit: unit.name, searchCountry: 'MALAYSIA', isHead: head, sex });
  const p3 = mk('malay', 'M', false);
  p3.dob = serialDob('1988-11-02'); // day and month both <= 12: the response swaps them
  const p6 = mk('malay', 'M', false);
  p6.names = p6.names.filter((n) => n !== 'bin' && n !== 'binti'); // no particle: the response adds one
  return {
    id: 'req-002-malay-particles',
    description: 'Malay bin/binti and Tamil-Malaysian a/l a/p names; one Malay name without a particle.',
    unitRows: [unit],
    people: [
      mk('malay', 'M', true),
      mk('malay', 'F', false),
      p3,
      mk('tamil-my', 'M', false),
      mk('tamil-my', 'F', false),
      p6,
    ],
    parseIssues: [],
    validationIssues: [],
  };
}

function specThai(): RequestSpec {
  const rng = createRng('vss-fixtures/req-003-thai-script');
  const c = newCounters();
  const u1 = genUnit(rng, c, 'THAILAND', 'Police');
  const u2 = genUnit(rng, c, 'THAILAND', 'Police');
  const mk = (culture: Culture, unit: UnitSpec, head: boolean): PersonSpec =>
    genPerson(rng, c, { culture, unit: unit.name, searchCountry: 'THAILAND', isHead: head });
  const mixed = mk('thai-script', u1, false);
  mixed.names = [genWord(rng, 'thai', 2)]; // Latin given name with a Thai-script surname
  return {
    id: 'req-003-thai-script',
    description: 'Thai-script names, Latin-transliterated Thai names and one mixed-script name.',
    unitRows: [u1, u2],
    people: [
      mk('thai-script', u1, true),
      mk('thai-script', u1, false),
      mixed,
      mk('thai', u2, true),
      mk('thai-script', u2, false),
      mk('thai', u2, false),
    ],
    parseIssues: [],
    validationIssues: [],
  };
}

function specErrors(): RequestSpec {
  const rng = createRng('vss-fixtures/req-004-errors');
  const c = newCounters();
  const seen = new Set<string>();
  const unitBase = (n: number): UnitSpec => ({ name: `Example Errors Unit ${n}`, type: 'Police', country: 'THAILAND' });
  const u0 = unitBase(1);
  const u1 = unitBase(2);
  const u2 = { ...u0 }; // duplicate of u0 (R-09)
  const u3 = unitBase(4); // never used (R-09)
  const u4: UnitSpec = { ...unitBase(5), type: 'Navy', country: 'ATLANTIS' }; // R-07 x2
  const u5: UnitSpec = { ...unitBase(6), country: '' }; // R-06 country
  const u6 = unitBase(7); // used by a person who is not head (R-10 none)
  const u7: UnitSpec = { ...unitBase(8), name: '' }; // R-06 name
  const base = (unit: UnitSpec, head: boolean | null): PersonSpec => {
    const p = uniquePerson(rng, c, seen, {
      culture: 'western',
      unit: unit.name,
      searchCountry: 'THAILAND',
      isHead: false,
    });
    p.isHead = head;
    p.pobCountry = 'UNITED KINGDOM';
    p.nationality = 'UNITED KINGDOM';
    delete p.passport;
    delete p.nationalId;
    delete p.titleRank;
    return p;
  };
  const P: PersonSpec[] = [];
  P[0] = base(u0, true); // clean
  P[1] = base(u0, false);
  P[1].surname = ''; // R-06 surname
  P[2] = base(u0, false);
  P[2].sex = 'X'; // R-07 sex
  P[2].pobCountry = 'ATLANTIS'; // R-07 country
  P[3] = base(u0, false);
  P[3].sex = 'm'; // R-07 warnings
  P[3].searchCountry = 'thailand';
  P[4] = base(u1, true);
  P[4].dob = serialDob('2012-05-10'); // R-08 under 18
  P[5] = base(u1, false);
  P[5].dob = serialDob('2030-01-01'); // R-08 future
  P[6] = base(u1, false);
  P[6].dob = { kind: 'text', text: 'not a date', parsed: null, ambiguous: false }; // R-08 invalid
  P[7] = base(u1, false);
  P[7].dob = { kind: 'text', text: '03/04/1990', parsed: '1990-03-04', ambiguous: true }; // R-08 ambiguous
  P[8] = base(u1, false);
  P[8].unit = 'Example Errors Unit 9'; // R-09 not declared
  P[9] = base(u1, true); // second head (R-10)
  P[10] = base(u0, false);
  P[10].passport = 'ZZ900001';
  delete P[10].nationality; // R-11
  P[11] = base(u0, false);
  P[11].surname = 'Ex'.repeat(64) + 'a'; // 129 chars, R-12
  P[12] = base(u0, false);
  P[12].surname = P[0].surname.toUpperCase();
  P[12].names = [...P[0].names].reverse().map((n) => n.toUpperCase());
  P[12].dob = P[0].dob; // R-13
  P[13] = base(u0, false);
  P[13].names = [`Dr. ${P[13].names[0]}`]; // R-14
  P[14] = base(u4, true);
  P[15] = base(u5, true);
  P[16] = base(u6, false);
  P[17] = base(u0, null); // R-06 IsHeadOfUnit

  const unitRows: (UnitSpec | null)[] = [u0, u1, u2, u3, u4, u5, u6, u7];
  const nU = unitRows.length;
  const ur = unitRowRef;
  const pr = (i: number): string => personRowRef(nU, i);
  const issues: ExpectedIssue[] = [
    issue('R-09', 'UNIT_DUPLICATE', 'error', ur(2), 'name'),
    issue('R-09', 'UNIT_UNUSED', 'warning', ur(3), 'name'),
    issue('R-07', 'UNIT_TYPE_INVALID', 'error', ur(4), 'type'),
    issue('R-07', 'COUNTRY_NOT_IN_LIST', 'error', ur(4), 'country'),
    issue('R-06', 'REQUIRED_MISSING', 'error', ur(5), 'country'),
    issue('R-06', 'REQUIRED_MISSING', 'error', ur(7), 'name'),
    issue('R-10', 'HEAD_OF_UNIT_MULTIPLE', 'error', ur(1), 'name'),
    issue('R-10', 'HEAD_OF_UNIT_NONE', 'warning', ur(6), 'name'),
    issue('R-06', 'REQUIRED_MISSING', 'error', pr(1), 'surname'),
    issue('R-07', 'SEX_INVALID', 'error', pr(2), 'sex'),
    issue('R-07', 'COUNTRY_NOT_IN_LIST', 'error', pr(2), 'pobCountry'),
    issue('R-07', 'SEX_INVALID', 'warning', pr(3), 'sex'),
    issue('R-07', 'COUNTRY_NOT_IN_LIST', 'warning', pr(3), 'searchCountry'),
    issue('R-08', 'DOB_UNDER_18', 'error', pr(4), 'dob'),
    issue('R-08', 'DOB_FUTURE', 'error', pr(5), 'dob'),
    issue('R-08', 'DOB_INVALID', 'error', pr(6), 'dob'),
    issue('R-08', 'DOB_TEXT', 'info', pr(7), 'dob'),
    issue('R-08', 'DOB_AMBIGUOUS_DM', 'warning', pr(7), 'dob'),
    issue('R-09', 'UNIT_NOT_DECLARED', 'error', pr(8), 'unitName'),
    issue('R-11', 'ID_WITHOUT_NATIONALITY', 'error', pr(10), 'nationality'),
    issue('R-12', 'CHAR_LIMIT', 'error', pr(11), 'surname'),
    issue('R-13', 'DUPLICATE_ROW', 'error', pr(12), 'surname'),
    issue('R-14', 'NAME_HAS_HONORIFIC', 'warning', pr(13), 'name1'),
    issue('R-06', 'REQUIRED_MISSING', 'error', pr(17), 'isHeadOfUnit'),
  ];
  const ruleMap: Record<string, string[]> = {};
  for (const i of issues) {
    const list = (ruleMap[i.rule] ??= []);
    if (i.rowRef && !list.includes(i.rowRef)) list.push(i.rowRef);
  }
  return {
    id: 'req-004-errors',
    description: 'One planted violation per request rule R-06..R-14; ruleMap lists the rows per rule.',
    unitRows,
    people: P,
    parseIssues: [],
    validationIssues: issues,
    ruleMap,
  };
}

function specShifted(): RequestSpec {
  const rng = createRng('vss-fixtures/req-005-shifted-layout');
  const c = newCounters();
  const u1 = genUnit(rng, c, 'CAMBODIA', 'Police');
  const u2 = genUnit(rng, c, 'CAMBODIA', 'Police');
  return {
    id: 'req-005-shifted-layout',
    description: 'Four unit rows including two blank ones, so every later block is shifted down.',
    unitRows: [u1, null, u2, null],
    people: [...genUnitPeople(rng, c, u1, 2, ['khmer']), ...genUnitPeople(rng, c, u2, 2, ['khmer', 'western'])],
    parseIssues: [],
    validationIssues: [],
  };
}

function specLarge(): RequestSpec {
  const rng = createRng('vss-fixtures/req-006-large');
  const c = newCounters();
  const seen = new Set<string>();
  const cultures: Culture[] = ['malay', 'tamil-my', 'thai', 'lao', 'khmer', 'vietnamese', 'western'];
  const countries = ['MALAYSIA', 'THAILAND', 'LAOS', 'CAMBODIA', 'VIETNAM'];
  const types = ['Police', 'Military', 'Prison', 'Other'];
  const units: UnitSpec[] = [];
  const people: PersonSpec[] = [];
  for (let u = 0; u < 50; u++) {
    const unit = genUnit(rng, c, countries[u % countries.length] as string, types[u % types.length] as string);
    units.push(unit);
    for (let i = 0; i < 24; i++) {
      people.push(
        uniquePerson(rng, c, seen, {
          culture: cultures[(u + i) % cultures.length] as Culture,
          unit: unit.name,
          searchCountry: unit.country,
          isHead: i === 0,
        }),
      );
    }
  }
  return {
    id: 'req-006-large',
    description: '50 units and 1200 individuals for the performance test.',
    unitRows: units,
    people,
    parseIssues: [],
    validationIssues: [],
  };
}

function specTextDates(): RequestSpec {
  const rng = createRng('vss-fixtures/req-007-text-dates');
  const c = newCounters();
  const unit = genUnit(rng, c, 'THAILAND', 'Police');
  const seen = new Set<string>();
  const people = genUnitPeople(rng, c, unit, 6, ['thai']);
  people.forEach((p) => seen.add(coreKey(p.surname, ...p.names)));
  const text = (t: string, parsed: string, ambiguous: boolean) =>
    ({ kind: 'text', text: t, parsed, ambiguous }) as const;
  people[0]!.dob = text('25/03/1985', '1985-03-25', false); // only DD/MM is a real date
  people[1]!.dob = text('03/04/1985', '1985-03-04', true); // both readings valid
  people[2]!.dob = text('1985-07-19', '1985-07-19', false);
  people[3]!.dob = text('07/19/1985', '1985-07-19', false); // only MM/DD is a real date
  people[4]!.dob = serialDob('1987-02-14');
  people[5]!.dob = text('12/12/1990', '1990-12-12', false); // both readings equal
  const pr = (i: number): string => personRowRef(1, i);
  return {
    id: 'req-007-text-dates',
    description: 'DOBs stored as text in DD/MM and MM/DD form, one ambiguous, one ISO, one serial.',
    unitRows: [unit],
    people,
    parseIssues: [],
    validationIssues: [
      issue('R-08', 'DOB_TEXT', 'info', pr(0), 'dob'),
      issue('R-08', 'DOB_TEXT', 'info', pr(1), 'dob'),
      issue('R-08', 'DOB_AMBIGUOUS_DM', 'warning', pr(1), 'dob'),
      issue('R-08', 'DOB_TEXT', 'info', pr(2), 'dob'),
      issue('R-08', 'DOB_TEXT', 'info', pr(3), 'dob'),
      issue('R-08', 'DOB_TEXT', 'info', pr(5), 'dob'),
    ],
  };
}

function specUnknownVersion(): RequestSpec {
  const rng = createRng('vss-fixtures/req-008-unknown-version');
  const c = newCounters();
  const unit = genUnit(rng, c, 'THAILAND', 'Police');
  return {
    id: 'req-008-unknown-version',
    description: 'Version cells say 9.0.0 / 9.9.9: R-02 warns and the file is read as the current template.',
    unitRows: [unit],
    people: genUnitPeople(rng, c, unit, 3, ['thai']),
    versionCells: { a2: 'Version 9.0.0', c2: 'INVESTc Template Version 9.9.9' },
    parseIssues: [issue('R-02', 'TEMPLATE_VERSION_UNKNOWN', 'warning', null, 'Template Instructions!C2')],
    validationIssues: [],
  };
}

export const REQUEST_SPECS: readonly (() => RequestSpec)[] = [
  specBasic,
  specMalay,
  specThai,
  specErrors,
  specShifted,
  specLarge,
  specTextDates,
  specUnknownVersion,
];

// ---- Response specs --------------------------------------------------------------------------------------------------

const us = (iso: string): string => {
  const [y, m, d] = iso.split('-') as [string, string, string];
  return `${Number(m)}/${Number(d)}/${y}`;
};
const usSwapped = (iso: string): string => {
  const [y, m, d] = iso.split('-') as [string, string, string];
  return `${Number(d)}/${Number(m)}/${y}`;
};

type NameStyle = 'title' | 'upper';
function dcName(p: PersonSpec, style: NameStyle, trailing: number, extra?: { insert?: string }): string {
  let given = [...p.names];
  if (extra?.insert) given = [...given, extra.insert];
  const text = `${p.surname}, ${given.join(' ')}`;
  return (style === 'upper' ? text.toUpperCase() : text) + ' '.repeat(trailing);
}

interface PobOpts {
  blankCity?: boolean;
  blankState?: boolean;
  blankAll?: boolean;
}
function pobParts(p: PersonSpec, o: PobOpts): { city: string | null; state: string | null; country: string | null } {
  if (o.blankAll) return { city: null, state: null, country: null };
  return {
    city: o.blankCity || !p.pobCity ? null : p.pobCity.toUpperCase(),
    state: o.blankState || !p.pobState ? null : p.pobState.toUpperCase(),
    country: p.pobCountry,
  };
}
const pobText = (x: { city: string | null; state: string | null; country: string | null }): string =>
  `${x.city ?? ''} - ${x.state ?? ''} - ${x.country ?? ''}`;

interface RowBuild {
  row: ResponseRowSpec;
  expect: {
    surname: string;
    given: string[];
    unknownCommander: boolean;
    dobParsed: string | null;
    pob: { city: string | null; state: string | null; country: string | null };
    certParsed: string | null;
    expiresParsed: string | null;
  };
  /** Set when the spec states a disposition other than "DISP agrees with its section" (lane C variants). */
  disp?: { cls: DispClassX; issue: 'DISP_UNRECOGNISED' | 'DISP_SECTION_CONFLICT' | null };
}

type DispClassX = 'approved' | 'non-approved' | 'unknown';
const dispAs = (
  rb: RowBuild,
  cls: DispClassX,
  issue: 'DISP_UNRECOGNISED' | 'DISP_SECTION_CONFLICT' | null = null,
): RowBuild => ({ ...rb, disp: { cls, issue } });

function personRow(
  p: PersonSpec,
  unitType: string,
  disp: string,
  cert: string,
  opts: {
    style?: NameStyle;
    trailing?: number;
    insertParticle?: string;
    moveSurname?: boolean;
    swapDob?: boolean;
    pob?: PobOpts;
    expires?: string;
  } = {},
): RowBuild {
  const style = opts.style ?? 'title';
  let name = dcName(p, style, opts.trailing ?? 0, opts.insertParticle ? { insert: opts.insertParticle } : undefined);
  let surname = p.surname;
  let given = [...p.names, ...(opts.insertParticle ? [opts.insertParticle] : [])];
  if (opts.moveSurname) {
    // The DC treats the first given name as the surname and the old surname becomes the last given name.
    surname = p.names[0] as string;
    given = [...p.names.slice(1), p.surname];
    name = `${surname}, ${given.join(' ')}` + ' '.repeat(opts.trailing ?? 0);
  }
  if (style === 'upper') {
    surname = surname.toUpperCase();
    given = given.map((g) => g.toUpperCase());
    name = name.toUpperCase();
  }
  const dobIso = p.dob.kind === 'serial' ? p.dob.iso : '';
  const pob = pobParts(p, opts.pob ?? {});
  const expires = opts.expires ?? addDays(cert, 365);
  const dobText = dobIso === '' ? '' : opts.swapDob ? usSwapped(dobIso) : us(dobIso);
  const dobParsed =
    dobIso === '' ? null : opts.swapDob ? `${dobIso.slice(0, 4)}-${dobIso.slice(8, 10)}-${dobIso.slice(5, 7)}` : dobIso;
  return {
    row: {
      disp,
      name,
      dob: dobText,
      pob: pobText(pob),
      unitType,
      unitName: p.unit,
      cert: us(cert),
      expires: expires === '' ? '' : us(expires),
    },
    expect: {
      surname,
      given,
      unknownCommander: false,
      dobParsed,
      pob,
      certParsed: cert,
      expiresParsed: expires === '' ? null : expires,
    },
  };
}

function unitRow(
  unit: UnitSpec,
  disp: string,
  cert: string,
  opts: { commander?: PersonSpec; expires?: string; style?: NameStyle } = {},
): RowBuild {
  const blankPob = { city: null, state: null, country: null };
  if (opts.commander) {
    const b = personRow(opts.commander, unit.type, disp, cert, { style: opts.style, expires: opts.expires ?? '' });
    return { row: { ...b.row, unitName: unit.name }, expect: b.expect };
  }
  return {
    row: {
      disp,
      name: 'UNKNOWN,    ',
      dob: '',
      pob: pobText(blankPob),
      unitType: unit.type,
      unitName: unit.name,
      cert: us(cert),
      expires: opts.expires ? us(opts.expires) : '',
    },
    expect: {
      surname: 'UNKNOWN',
      given: [],
      unknownCommander: true,
      dobParsed: null,
      pob: blankPob,
      certParsed: cert,
      expiresParsed: opts.expires ?? null,
    },
  };
}

interface SectionBuild {
  /** null = no label row (implicit first section). */
  label: string | null;
  /** The section the label names; 'unknown' for an unknown label. */
  section: string;
  rows: RowBuild[];
  noHeader?: boolean;
}

interface ResponseBuild {
  id: string;
  description: string;
  batchId: string;
  asOfIso: string;
  sections: SectionBuild[];
  notes?: string[];
  expectedIssues: ExpectedIssue[];
  expectedUnknownSections: string[];
  /** Workbook variants (lane C): sheet name, metadata column, column order, extra sheets. */
  variant?: Pick<ResponseWorkbookSpec, 'sheetName' | 'metaColumn' | 'headers' | 'extraSheets'>;
  /** Not a response at all: these request workbook bytes are fed to the response parser (resp-011). */
  requestBytes?: () => { bytes: Uint8Array; strings: Set<string> };
}

const LABELS = {
  au: ['Approved Unit/Commander:', 'approved-unit'],
  ai: ['Approved Individuals:', 'approved-individual'],
  nu: ['Non Approved Unit/Commander:', 'nonapproved-unit'],
  ni: ['Non Approved Individuals:', 'nonapproved-individual'],
} as const;

const APPROVE = 'Approve'; // verbatim DISP of an approved row in a real DC file
/** PLACEHOLDER. The real non-approved DISP literal is unknown. VERIFY against a real non-approved DC response. */
const NOT_APPROVED = 'NotApproved';

function responseSpecs(requests: Map<string, RequestSpec>): ResponseBuild[] {
  const req = (id: string): RequestSpec => requests.get(id) as RequestSpec;
  const out: ResponseBuild[] = [];
  const cert = '2026-10-20';
  const asOf = '2026-10-22';

  // resp-001: everything approved, aligned with req-001.
  {
    const r = req('req-001-basic');
    const [u1, u2] = r.unitRows as [UnitSpec, UnitSpec];
    const u1People = r.people.filter((p) => p.unit === u1.name);
    out.push({
      id: 'resp-001-all-approved',
      description: 'Every unit and individual of req-001 approved; names in Surname, Given form.',
      batchId: 'SYNTH-0000000001',
      asOfIso: asOf,
      sections: [
        {
          label: LABELS.au[0],
          section: LABELS.au[1],
          rows: [unitRow(u1, APPROVE, cert, { commander: u1People[0] }), unitRow(u2, APPROVE, cert)],
        },
        {
          label: LABELS.ai[0],
          section: LABELS.ai[1],
          rows: r.people.map((p, i) =>
            personRow(p, (r.unitRows.find((u) => u?.name === p.unit) as UnitSpec).type, APPROVE, cert, {
              style: i % 3 === 2 ? 'upper' : 'title',
            }),
          ),
        },
        { label: LABELS.nu[0], section: LABELS.nu[1], rows: [] },
        { label: LABELS.ni[0], section: LABELS.ni[1], rows: [] },
      ],
      expectedIssues: [],
      expectedUnknownSections: [],
    });
  }

  // resp-002: reformatted by the DC, aligned with req-002.
  {
    const r = req('req-002-malay-particles');
    const unit = r.unitRows[0] as UnitSpec;
    const [p1, p2, p3, p4, p5, p6] = r.people as [
      PersonSpec,
      PersonSpec,
      PersonSpec,
      PersonSpec,
      PersonSpec,
      PersonSpec,
    ];
    const shortExpiry = addDays(cert, 90);
    out.push({
      id: 'resp-002-reformatted',
      description:
        'DC reformatting: surname moved, particle added, day/month swapped, blank POB parts, trailing spaces, UNKNOWN commander, short unit expiry.',
      batchId: 'SYNTH-0000000002',
      asOfIso: asOf,
      sections: [
        { label: LABELS.au[0], section: LABELS.au[1], rows: [unitRow(unit, APPROVE, cert, { expires: shortExpiry })] },
        {
          label: LABELS.ai[0],
          section: LABELS.ai[1],
          rows: [
            personRow(p1, unit.type, APPROVE, cert, { trailing: 3, moveSurname: true }),
            personRow(p2, unit.type, APPROVE, cert, { trailing: 3, pob: { blankCity: true, blankState: true } }),
            personRow(p3, unit.type, APPROVE, cert, { trailing: 3, swapDob: true }),
            personRow(p4, unit.type, APPROVE, cert, { trailing: 3, pob: { blankAll: true } }),
            personRow(p5, unit.type, APPROVE, cert, { trailing: 3, pob: { blankState: true } }),
            personRow(p6, unit.type, APPROVE, cert, { trailing: 3, insertParticle: 'bin' }),
          ],
        },
        { label: LABELS.nu[0], section: LABELS.nu[1], rows: [] },
        { label: LABELS.ni[0], section: LABELS.ni[1], rows: [] },
      ],
      expectedIssues: [],
      expectedUnknownSections: [],
    });
  }

  // resp-003: both non-approved sections populated, aligned with req-001.
  {
    const r = req('req-001-basic');
    const [u1, u2] = r.unitRows as [UnitSpec, UnitSpec];
    const typeOf = (p: PersonSpec): string => (r.unitRows.find((u) => u?.name === p.unit) as UnitSpec).type;
    const P = r.people;
    out.push({
      id: 'resp-003-nonapproved',
      description:
        'Approved and non-approved units and individuals. The non-approved DISP literal is a PLACEHOLDER (VERIFY against a real response).',
      batchId: 'SYNTH-0000000003',
      asOfIso: asOf,
      sections: [
        { label: LABELS.au[0], section: LABELS.au[1], rows: [unitRow(u1, APPROVE, cert)] },
        {
          label: LABELS.ai[0],
          section: LABELS.ai[1],
          rows: [P[0], P[1], P[3], P[4]].map((p) => personRow(p as PersonSpec, typeOf(p as PersonSpec), APPROVE, cert)),
        },
        {
          label: LABELS.nu[0],
          section: LABELS.nu[1],
          rows: [unitRow(u2, NOT_APPROVED, cert, { expires: '' })],
        },
        {
          label: LABELS.ni[0],
          section: LABELS.ni[1],
          rows: [P[2], P[5]].map((p) =>
            personRow(p as PersonSpec, typeOf(p as PersonSpec), NOT_APPROVED, cert, { expires: '' }),
          ),
        },
      ],
      notes: ['VERIFY: the DISP literal for non-approved rows is a placeholder (NotApproved).'],
      expectedIssues: [],
      expectedUnknownSections: [],
    });
  }

  // resp-004: Thai script, aligned with req-003.
  {
    const r = req('req-003-thai-script');
    const typeOf = (p: PersonSpec): string => (r.unitRows.find((u) => u?.name === p.unit) as UnitSpec).type;
    out.push({
      id: 'resp-004-thai',
      description: 'Thai-script and mixed-script names kept as written by the DC.',
      batchId: 'SYNTH-0000000004',
      asOfIso: asOf,
      sections: [
        {
          label: LABELS.au[0],
          section: LABELS.au[1],
          rows: (r.unitRows as UnitSpec[]).map((u) => unitRow(u, APPROVE, cert)),
        },
        {
          label: LABELS.ai[0],
          section: LABELS.ai[1],
          rows: r.people.map((p) => personRow(p, typeOf(p), APPROVE, cert)),
        },
        { label: LABELS.nu[0], section: LABELS.nu[1], rows: [] },
        { label: LABELS.ni[0], section: LABELS.ni[1], rows: [] },
      ],
      expectedIssues: [],
      expectedUnknownSections: [],
    });
  }

  // resp-005: unknown section label: a warning that names the label; its rows are kept and classified by DISP.
  {
    const r = req('req-001-basic');
    const typeOf = (p: PersonSpec): string => (r.unitRows.find((u) => u?.name === p.unit) as UnitSpec).type;
    out.push({
      id: 'resp-005-unknown-section',
      description:
        'Contains the section "Pending Review Individuals:": a warning names the label; its row (DISP "Pending") is kept as a disposition-unclear review item.',
      batchId: 'SYNTH-0000000005',
      asOfIso: asOf,
      sections: [
        { label: LABELS.au[0], section: LABELS.au[1], rows: [unitRow(r.unitRows[0] as UnitSpec, APPROVE, cert)] },
        {
          label: LABELS.ai[0],
          section: LABELS.ai[1],
          rows: r.people.slice(0, 3).map((p) => personRow(p, typeOf(p), APPROVE, cert)),
        },
        {
          label: 'Pending Review Individuals:',
          section: 'unknown-individual',
          rows: r.people
            .slice(3, 4)
            .map((p) => dispAs(personRow(p, typeOf(p), 'Pending', cert), 'unknown', 'DISP_UNRECOGNISED')),
        },
        { label: LABELS.nu[0], section: LABELS.nu[1], rows: [] },
        { label: LABELS.ni[0], section: LABELS.ni[1], rows: [] },
      ],
      expectedIssues: [],
      expectedUnknownSections: ['Pending Review Individuals:'],
    });
  }

  // ---- Alpha 1 (lane C) structural variants, all aligned with req-001 --------------------------------------------
  const r1 = req('req-001-basic');
  const [ru1, ru2] = r1.unitRows as [UnitSpec, UnitSpec];
  const typeOf1 = (p: PersonSpec): string => (r1.unitRows.find((u) => u?.name === p.unit) as UnitSpec).type;
  const P1 = r1.people as PersonSpec[];
  const approvedPerson = (p: PersonSpec): RowBuild => personRow(p, typeOf1(p), APPROVE, cert);

  // resp-006 (a): the first section label is absent; header row straight after the metadata lines.
  out.push({
    id: 'resp-006-no-first-label',
    description:
      'Variant a: no "Approved Unit/Commander:" label; the first header row opens an implicit approved unit section.',
    batchId: 'SYNTH-0000000006',
    asOfIso: asOf,
    sections: [
      { label: null, section: LABELS.au[1], rows: [unitRow(ru1, APPROVE, cert), unitRow(ru2, APPROVE, cert)] },
      { label: LABELS.ai[0], section: LABELS.ai[1], rows: P1.map(approvedPerson) },
      { label: LABELS.nu[0], section: LABELS.nu[1], rows: [] },
      { label: LABELS.ni[0], section: LABELS.ni[1], rows: [] },
    ],
    expectedIssues: [],
    expectedUnknownSections: [],
  });

  // resp-007 (b): DISP spellings. "Pending" is not a disposition: a review item, never a guess.
  out.push({
    id: 'resp-007-disp-variants',
    description:
      'Variant b: DISP spelled Approve, Approved, "APPROVED ", Not Approved, Disapprove; one "Pending" row becomes a disposition-unclear review item.',
    batchId: 'SYNTH-0000000007',
    asOfIso: asOf,
    sections: [
      { label: LABELS.au[0], section: LABELS.au[1], rows: [unitRow(ru1, APPROVE, cert)] },
      {
        label: LABELS.ai[0],
        section: LABELS.ai[1],
        rows: [
          personRow(P1[0] as PersonSpec, typeOf1(P1[0] as PersonSpec), 'Approve', cert),
          personRow(P1[1] as PersonSpec, typeOf1(P1[1] as PersonSpec), 'Approved', cert),
          personRow(P1[2] as PersonSpec, typeOf1(P1[2] as PersonSpec), 'APPROVED ', cert),
          dispAs(
            personRow(P1[3] as PersonSpec, typeOf1(P1[3] as PersonSpec), 'Pending', cert),
            'unknown',
            'DISP_UNRECOGNISED',
          ),
        ],
      },
      { label: LABELS.nu[0], section: LABELS.nu[1], rows: [unitRow(ru2, 'Not Approved', cert, { expires: '' })] },
      {
        label: LABELS.ni[0],
        section: LABELS.ni[1],
        rows: [
          personRow(P1[4] as PersonSpec, typeOf1(P1[4] as PersonSpec), 'Not Approved', cert, { expires: '' }),
          personRow(P1[5] as PersonSpec, typeOf1(P1[5] as PersonSpec), 'Disapprove', cert, { expires: '' }),
        ],
      },
    ],
    notes: ['VERIFY: "Not Approved" and "Disapprove" are documented variants not yet seen in a real DC file.'],
    expectedIssues: [],
    expectedUnknownSections: [],
  });

  // resp-008 (c): Latin given names followed by the same person's Thai-script given names; surname Latin.
  {
    const rng = createRng('vss-fixtures/resp-008-mixed-script-names');
    const rows = P1.map((p) => {
      const thai = [genWord(rng, 'thai-script', 2), genWord(rng, 'thai-script', 2)];
      const b = approvedPerson({ ...p, names: [...p.names, ...thai] });
      return b;
    });
    out.push({
      id: 'resp-008-mixed-script-names',
      description:
        'Variant c: every NAME is "Surname, Latin given names" followed by two Thai-script given names (synthetic).',
      batchId: 'SYNTH-0000000008',
      asOfIso: asOf,
      sections: [
        { label: LABELS.au[0], section: LABELS.au[1], rows: [unitRow(ru1, APPROVE, cert)] },
        { label: LABELS.ai[0], section: LABELS.ai[1], rows },
        { label: LABELS.nu[0], section: LABELS.nu[1], rows: [] },
        { label: LABELS.ni[0], section: LABELS.ni[1], rows: [] },
      ],
      expectedIssues: [],
      expectedUnknownSections: [],
    });
  }

  // resp-009 (d): empty sections, one of them even without its header row.
  out.push({
    id: 'resp-009-empty-sections',
    description:
      'Variant d: "Approved Individuals" has a header and no rows; "Non Approved Unit/Commander" has no header and no rows.',
    batchId: 'SYNTH-0000000009',
    asOfIso: asOf,
    sections: [
      { label: LABELS.au[0], section: LABELS.au[1], rows: [unitRow(ru1, APPROVE, cert)] },
      { label: LABELS.ai[0], section: LABELS.ai[1], rows: [] },
      { label: LABELS.nu[0], section: LABELS.nu[1], rows: [], noHeader: true },
      {
        label: LABELS.ni[0],
        section: LABELS.ni[1],
        rows: [personRow(P1[0] as PersonSpec, typeOf1(P1[0] as PersonSpec), NOT_APPROVED, cert, { expires: '' })],
      },
    ],
    expectedIssues: [],
    expectedUnknownSections: [],
  });

  // resp-010: renamed results sheet between two extra sheets (one hidden), metadata in column A, columns reordered
  // with one extra column.
  out.push({
    id: 'resp-010-renamed-sheet-hidden-extra',
    description:
      'Results on sheet "Results" between a "Notes" sheet and a hidden "Lists" sheet; metadata labels in column A; columns reordered plus a REMARKS column.',
    batchId: 'SYNTH-0000000010',
    asOfIso: asOf,
    variant: {
      sheetName: 'Results',
      metaColumn: 'A',
      headers: ['NAME', 'DISP', 'DOB', 'POB', 'UNIT NAME', 'UNIT TYPE', 'REMARKS', 'CERT DATE', 'EXPIRES'],
      extraSheets: [
        { name: 'Notes', position: 'before', rows: ['Synthetic notes sheet', 'Nothing to import here'] },
        { name: 'Lists', position: 'after', hidden: true, rows: ['Approve', 'Not Approved'] },
      ],
    },
    sections: [
      {
        label: LABELS.au[0],
        section: LABELS.au[1],
        rows: [
          { ...unitRow(ru1, APPROVE, cert), row: { ...unitRow(ru1, APPROVE, cert).row, extra: 'Synthetic remark' } },
        ],
      },
      {
        label: LABELS.ai[0],
        section: LABELS.ai[1],
        rows: P1.slice(0, 3).map((p, i) => {
          const b = approvedPerson(p);
          return { ...b, row: { ...b.row, extra: i === 1 ? 'Synthetic remark' : '' } };
        }),
      },
      { label: LABELS.nu[0], section: LABELS.nu[1], rows: [] },
      { label: LABELS.ni[0], section: LABELS.ni[1], rows: [] },
    ],
    expectedIssues: [],
    expectedUnknownSections: [],
  });

  // resp-011: a request workbook (req-001) picked in the response importer: refused with LOOKS_LIKE_REQUEST.
  out.push({
    id: 'resp-011-request-workbook',
    description: 'A vetting request workbook (copy of req-001-basic) given to the response importer: friendly refusal.',
    batchId: '',
    asOfIso: asOf,
    sections: [],
    expectedIssues: [issue('S-01', 'LOOKS_LIKE_REQUEST', 'error', null, null)],
    expectedUnknownSections: [],
    requestBytes: () => buildRequestWorkbook(req('req-001-basic')),
  });
  return out;
}

/** Section that the spec names, split into kind and approval ('unknown-individual' = unknown label of individuals). */
function sectionParts(section: string): { kind: 'unit' | 'individual'; approval: DispClassX } {
  const kind = section.endsWith('-unit') ? 'unit' : 'individual';
  if (section.startsWith('unknown')) return { kind, approval: 'unknown' };
  return { kind, approval: section.startsWith('approved') ? 'approved' : 'non-approved' };
}

const KNOWN_SECTIONS = ['approved-unit', 'approved-individual', 'nonapproved-unit', 'nonapproved-individual'];

/**
 * Expected parse result, derived from the spec (never from the parser): rows with their stated disposition, and the
 * issues the structure implies (implicit first section, empty sections, unknown labels, extra sheets / columns, mixed
 * script names, unclear DISP).
 */
function buildResponse(b: ResponseBuild): { bytes: Uint8Array; strings: Set<string>; expected: unknown } {
  if (b.requestBytes) {
    const req = b.requestBytes();
    return {
      bytes: req.bytes,
      strings: req.strings,
      expected: {
        id: b.id,
        description: b.description,
        fileKindGuess: 'investc-request',
        batchId: null,
        post: null,
        resultsAsOf: null,
        assistanceLine: null,
        blocked: true,
        unknownSections: [],
        rows: [],
        issues: b.expectedIssues,
      },
    };
  }
  const sections: ResponseSectionSpec[] = b.sections.map((s) => ({
    label: s.label,
    rows: s.rows.map((r) => r.row),
    ...(s.noHeader ? { noHeader: true } : {}),
  }));
  const asOfUs = us(b.asOfIso);
  const built = buildResponseWorkbook({
    line1: `Final Results as of ${asOfUs}`,
    line2: 'Post: Example City',
    line3: `Batch ID: ${b.batchId}`,
    line4: `Assistance: Example Workshop - Example City - 11/20/2026`,
    sections,
    ...(b.variant ?? {}),
  });
  const sheet = b.variant?.sheetName ?? 'Final_Results';
  const ref = (row: number): string => `${sheet}!${row}`;
  const colOf = (h: string): string => built.headerColumns[h] as string;
  const rows: unknown[] = [];
  const issues: ExpectedIssue[] = [...b.expectedIssues];
  if ((b.variant?.extraSheets ?? []).length > 0) issues.push(issue('S-07', 'EXTRA_SHEETS', 'info', null, null));
  const firstHeader = built.layout.find((l) => l.headerRow !== null)?.headerRow ?? null;
  for (const h of b.variant?.headers ?? []) {
    if (!['DISP', 'NAME', 'DOB', 'POB', 'UNIT TYPE', 'UNIT NAME', 'CERT DATE', 'EXPIRES'].includes(h))
      issues.push(issue('S-07', 'HEADER_COLUMN_EXTRA', 'info', ref(firstHeader as number), colOf(h)));
  }
  const labelled = new Set<string>();
  let implicitUnit = false;
  b.sections.forEach((s, si) => {
    const lay = built.layout[si]!;
    const { kind, approval } = sectionParts(s.section);
    const implicit = s.label === null && si === 0;
    if (implicit) {
      implicitUnit = true;
      issues.push(issue('S-06', 'SECTION_IMPLICIT', 'info', ref(lay.headerRow as number), null));
    } else if (approval === 'unknown') {
      issues.push(issue('S-06', 'UNKNOWN_SECTION', 'warning', ref(lay.labelRow as number), 'A'));
    } else labelled.add(s.section);
    if (s.rows.length === 0 && s.label !== null) {
      issues.push(issue('S-06', 'SECTION_EMPTY', 'info', ref(lay.labelRow as number), null));
    }
    s.rows.forEach((rb, i) => {
      const row = lay.dataRows[i] as number;
      const e = rb.expect;
      const dateOf = (text: string, parsed: string | null) =>
        text === ''
          ? { kind: 'empty', value: '', parsed: null, ambiguousDayMonth: false }
          : { kind: 'text', value: text, parsed, ambiguousDayMonth: false };
      const cls: DispClassX = rb.disp?.cls ?? approval;
      if (rb.disp?.issue) issues.push(issue('S-06', rb.disp.issue, 'warning', ref(row), colOf('DISP')));
      const script = /[฀-๿]/.test(rb.row.name) ? (/[A-Za-z]/.test(rb.row.name) ? 'Mixed' : 'Thai') : 'Latn';
      if (script === 'Mixed') issues.push(issue('S-04', 'NAME_MIXED_SCRIPT', 'info', ref(row), colOf('NAME')));
      rows.push({
        rowRef: ref(row),
        section: `${cls === 'approved' ? 'approved' : 'nonapproved'}-${kind}`,
        dispClass: cls,
        sectionSource: implicit ? 'implicit' : 'label',
        disp: rb.row.disp,
        nameRaw: rb.row.name,
        surname: e.surname,
        given: e.given,
        unknownCommander: e.unknownCommander,
        script,
        dob: dateOf(rb.row.dob, e.dobParsed),
        pob: e.pob,
        unitType: rb.row.unitType,
        unitName: rb.row.unitName,
        certDate: dateOf(rb.row.cert, e.certParsed),
        expires: dateOf(rb.row.expires, e.expiresParsed),
      });
    });
  });
  for (const s of KNOWN_SECTIONS) {
    if (!labelled.has(s) && !(implicitUnit && s === 'approved-unit'))
      issues.push(issue('S-02', 'SECTION_MISSING', 'info', null, null));
  }
  const hasError = issues.some((i) => i.severity === 'error');
  return {
    bytes: built.bytes,
    strings: built.strings,
    expected: {
      id: b.id,
      description: b.description,
      fileKindGuess: 'dc-response',
      batchId: b.batchId,
      post: 'Example City',
      resultsAsOf: b.asOfIso,
      assistanceLine: 'Example Workshop - Example City - 11/20/2026',
      blocked: hasError,
      unknownSections: b.expectedUnknownSections,
      rows,
      issues,
      ...(b.notes ? { notes: b.notes } : {}),
    },
  };
}

// ---- Assembly ------------------------------------------------------------------------------------------------------

const FIXTURE_NOW_DATE = new Date(`${FIXTURE_NOW_ISO}T00:00:00Z`);
export { FIXTURE_NOW_DATE };

export function expectedForRequest(spec: RequestSpec): unknown {
  const nU = spec.unitRows.length;
  const units = spec.unitRows.flatMap((u, i) => (u ? [expectedUnit(u, unitRowRef(i))] : []));
  const people = spec.people.map((p, i) => expectedPerson(p, personRowRef(nU, i)));
  const ver = spec.versionCells?.c2?.match(/(\d+\.\d+\.\d+)$/)?.[1] ?? '1.11.0';
  const aver = spec.versionCells?.a2?.match(/(\d+\.\d+\.\d+)$/)?.[1] ?? '2.6.0';
  const head = {
    id: spec.id,
    description: spec.description,
    now: FIXTURE_NOW_ISO,
    templateVersion: ver,
    instructionsVersion: aver,
    parseIssues: spec.parseIssues,
    validationIssues: spec.validationIssues,
    ...(spec.ruleMap ? { ruleMap: spec.ruleMap } : {}),
  };
  if (spec.id === 'req-006-large') {
    return {
      ...head,
      summary: {
        units: units.length,
        people: people.length,
        sha256: sha256(canonicalJson({ units, people }, 0)),
        firstUnit: units[0],
        firstPerson: people[0],
        lastPerson: people[people.length - 1],
      },
    };
  }
  return { ...head, units, people };
}

/** fixtures/purity-allowlist.json: the structural strings of the generated blank workbook. */
export function allowlistJson(): string {
  return (
    JSON.stringify(
      {
        note: 'Structural strings of the generated blank request workbook (tools/fixtures/investc-workbook.ts).',
        strings: blankStrings(),
      },
      null,
      2,
    ) + '\n'
  );
}

export function generateFixtures(): GeneratedFixtures {
  const files: FixtureFile[] = [];
  const xlsxStrings = new Map<string, Set<string>>();
  const requests = new Map<string, RequestSpec>();
  for (const make of REQUEST_SPECS) {
    const spec = make();
    requests.set(spec.id, spec);
    const built = buildRequestWorkbook(spec);
    const path = `requests/${spec.id}.xlsx`;
    files.push({ path, data: built.bytes });
    xlsxStrings.set(path, built.strings);
    files.push({ path: `requests/${spec.id}.expected.json`, data: prettyCanonicalJson(expectedForRequest(spec)) });
  }
  for (const rb of responseSpecs(requests)) {
    const built = buildResponse(rb);
    const path = `responses/${rb.id}.xlsx`;
    files.push({ path, data: built.bytes });
    xlsxStrings.set(path, built.strings);
    files.push({ path: `responses/${rb.id}.expected.json`, data: prettyCanonicalJson(built.expected) });
  }
  files.push({ path: 'purity-allowlist.json', data: allowlistJson() });
  return { files, xlsxStrings };
}

function main(): void {
  const check = process.argv.includes('--check');
  const { files } = generateFixtures();
  let bad = 0;
  for (const f of files) {
    const abs = resolve(FIXTURES_DIR, f.path);
    const bytes = typeof f.data === 'string' ? Buffer.from(f.data, 'utf8') : Buffer.from(f.data);
    if (check) {
      if (!existsSync(abs) || Buffer.compare(readFileSync(abs), bytes) !== 0) {
        console.error(`stale: ${f.path}`);
        bad += 1;
      }
    } else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, bytes);
    }
  }
  if (check && bad > 0) process.exit(1);
  console.log(check ? `${files.length} fixture files up to date` : `wrote ${files.length} fixture files`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
