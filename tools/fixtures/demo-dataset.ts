/**
 * Deterministic generator of the SYNTHETIC demo dataset in fixtures/demo/: two request workbooks, the two DC
 * responses that answer them and a manifest of the outcomes the import must show.
 *
 *   node tools/fixtures/demo-dataset.ts          (npm run fixtures:demo)        writes fixtures/demo/
 *   node tools/fixtures/demo-dataset.ts --check  (npm run fixtures:demo:check)  fails if the committed files differ
 *
 * The dataset reproduces the SHAPE of a real pair of request/response exchanges (row and section layout, counts, which
 * people are answered, and the kinds of differences a DC introduces) with invented content only. Every name, place,
 * date of birth, unit, event and batch id below is generated from the seeded grammars in grammar.ts or is an obviously
 * fictional "Example ..." string. No real value, and no mapping from any real value, exists in this file or its output.
 *
 * Workbooks are written by the repository's own writers (investc-workbook.ts, response-builder.ts).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { addDays, isoToSerial } from '../../src/main/formats/ooxml/dates.ts';
import { startsWithHonorific } from '../../src/main/formats/investc/names.ts';
import { createRng, genWord, int, type Culture, type Rng } from './grammar.ts';
import { buildInvestcWorkbook, type CellValue, type RowCells } from './investc-workbook.ts';
import { buildResponseWorkbook, type ResponseRowSpec } from './response-builder.ts';
import { canonicalJson } from './generate.ts';

export const DEMO_SEED = 'vss-demo/2026-11-04';
const here = dirname(fileURLToPath(import.meta.url));
export const DEMO_DIR = resolve(here, '../../fixtures/demo');

export const DEMO_FILES = {
  request1: 'demo-request-1_example-regional-workshop.xlsx',
  request2: 'demo-request-2_example-river-city-course.xlsx',
  response1: 'DEMO-0000000001.xlsx',
  response2: 'DEMO-0000000002.xlsx',
} as const;

// ---- small helpers ---------------------------------------------------------------------------------------------------

const iso = (y: number, m: number, d: number): string =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
/** DC date text M/D/YYYY. */
const us = (isoDate: string): string => {
  const [y, m, d] = isoDate.split('-') as [string, string, string];
  return `${Number(m)}/${Number(d)}/${y}`;
};
const serial = (isoDate: string): number => {
  const s = isoToSerial(isoDate);
  if (s === null) throw new Error(`bad date ${isoDate}`);
  return s;
};

/** A word of a culture, 2 syllables unless told otherwise, never an honorific. */
function w(rng: Rng, culture: Culture, syllables = 2): string {
  for (;;) {
    const x = genWord(rng, culture, syllables);
    if (x.length >= 3 && !startsWithHonorific(x)) return x;
  }
}

/** DOB of an adult (25..55 on 2026-11-04) with optional day / month constraints. */
function dob(rng: Rng, o: { dayMax?: number; dayMin?: number; monthMax?: number; distinctDayMonth?: boolean } = {}) {
  for (;;) {
    const y = 2026 - int(rng, 25, 55);
    const m = int(rng, 1, o.monthMax ?? 12);
    const d = int(rng, o.dayMin ?? 1, o.dayMax ?? 28);
    if (o.distinctDayMonth && d === m) continue;
    return { y, m, d, iso: iso(y, m, d) };
  }
}

// ---- the people ----------------------------------------------------------------------------------------------------

/** One invented person and how each file renders them. */
interface DemoPerson {
  id: string;
  /** Name as the request carries it, for the manifest (trimmed). */
  display: string;
  request?: { file: keyof typeof DEMO_FILES; row: number; cells: RowCells };
  response?: { file: keyof typeof DEMO_FILES; section: string; row: number; spec: ResponseRowSpec };
  /** Kinds of difference between the request row and the response row (or why there is no counterpart). */
  differences: string[];
}

interface UnitDef {
  name: string;
  type: string;
  country: string;
  alias?: string;
}

const unitCells = (u: UnitDef): RowCells => ({
  A: { t: 's', v: u.name },
  C: { t: 's', v: u.type },
  ...(u.alias ? { D: { t: 's', v: u.alias } as CellValue } : {}),
  M: { t: 's', v: u.country },
});

interface ReqPerson {
  unit: string;
  surname: string;
  name1: string;
  rank?: string;
  dobIso: string;
  dobShortStyle?: boolean;
  city?: string;
  state?: string;
  country: string;
  nationality?: string;
  search: string;
  sex: 'M' | 'F';
}

function personCells(p: ReqPerson): RowCells {
  const c: RowCells = {
    A: { t: 's', v: p.unit },
    B: { t: 'b', v: false },
    C: { t: 's', v: p.surname },
    D: { t: 's', v: p.name1 },
    M: p.dobShortStyle ? { t: 'n', v: serial(p.dobIso), style: 'date-short' } : { t: 'n', v: serial(p.dobIso) },
    P: { t: 's', v: p.country },
    R: { t: 's', v: p.search },
    S: { t: 's', v: p.sex },
  };
  if (p.rank) c['J'] = { t: 's', v: p.rank };
  if (p.city) c['N'] = { t: 's', v: p.city };
  if (p.state) c['O'] = { t: 's', v: p.state };
  if (p.nationality) c['Q'] = { t: 's', v: p.nationality };
  return c;
}

const pob = (city: string | null, state: string | null, country: string | null): string =>
  `${city ?? ''} - ${state ?? ''} - ${country ?? ''}`;

// ---- dataset -------------------------------------------------------------------------------------------------------

export interface DemoDataset {
  files: { path: string; data: Uint8Array | string }[];
  /** Strings each workbook holds beyond the blank workbook's own (path relative to fixtures/). */
  xlsxStrings: Map<string, Set<string>>;
  manifest: DemoManifest;
}

export interface DemoPairOutcome {
  request: string;
  response: string;
  batchId: string;
  counts: {
    requestUnits: number;
    requestPeople: number;
    responseUnitRows: number;
    responseIndividualRows: number;
    /** Request people who have a response row (same invented identity). */
    matched: number;
    /** Request people without any response row. */
    unanswered: number;
    /** Response rows (units with a named commander, and individuals) for nobody on the request. */
    unidentified: number;
    /** Matched response rows the matcher links automatically. */
    autoMatched: number;
    /** Review items the import opens: pending matches, unidentified response rows and unanswered request people. */
    reviewQueue: number;
  };
  matched: string[];
  unanswered: string[];
  unidentified: string[];
  autoMatched: string[];
  /** Matched rows that stay pending (the right request person is among the candidates). */
  pendingReview: string[];
  /** Open review items by kind after the response import is committed. */
  reviewByKind: Record<string, number>;
}

export interface DemoManifest {
  synthetic: true;
  note: string;
  seed: string;
  generator: string;
  files: typeof DEMO_FILES;
  /** Invented requestor and event headers to enter when committing each request import (UI harness, e2e). */
  requestor: { name: string; email: string; organisation: string };
  requests: { file: string; eventName: string; eventStart: string; eventEnd: string; eventLocation: string }[];
  people: {
    id: string;
    name: string;
    request: string | null;
    requestRow: string | null;
    response: string | null;
    responseRow: string | null;
    responseSection: string | null;
    differences: string[];
  }[];
  pairs: DemoPairOutcome[];
}

const MY = 'MALAYSIA';
const TH = 'THAILAND';

/**
 * Pair 1: one unit (plus three blank unit rows), five people, all answered by an "approved" DC file whose unit row has
 * an UNKNOWN commander. The DC re-renders names, dates and places in the ways listed per person.
 */
function pair1(rng: Rng): { people: DemoPerson[]; unit: UnitDef; asOf: string; event: string } {
  const unit: UnitDef = {
    name: 'Example Online Child Protection Unit, Example Family and Child Investigation Division (D90), Example Criminal Investigation Department, Example National Police',
    type: 'Other',
    country: MY,
    alias: 'ENP',
  };
  const asOf = '2026-11-16';
  const firstRow = 12; // 4 unit rows (1 filled, 3 blank): sep 8, INDIVIDUALS 9, sub 10, header 11
  const respRow = 13; // approved individuals start at Final_Results!13 (see the section layout below)
  const placeA = { city: w(rng, 'malay'), state: w(rng, 'malay') };
  const placeB = w(rng, 'malay'); // a place used as both city and state
  const placeC = w(rng, 'malay', 3);
  const people: DemoPerson[] = [];
  const add = (
    id: string,
    req: ReqPerson,
    display: string,
    resp: Omit<ResponseRowSpec, 'disp' | 'unitType' | 'unitName' | 'cert' | 'expires'>,
    differences: string[],
  ): void => {
    const i = people.length;
    people.push({
      id,
      display,
      request: { file: 'request1', row: firstRow + i, cells: personCells(req) },
      response: {
        file: 'response1',
        section: 'approved-individual',
        row: respRow + i,
        spec: {
          disp: 'Approve',
          ...resp,
          unitType: 'Police',
          unitName: unit.name,
          cert: us(asOf),
          expires: us(addDays(asOf, 365)),
        },
      },
      differences,
    });
  };

  // P1: Tamil-Malaysian woman, two given names + a/p in Name 1, stray spaces in the request cells; the DC swaps day
  // and month of a DOB where both are <= 12 and drops city/state.
  {
    const s = w(rng, 'tamil-my', 3);
    const g = [w(rng, 'tamil-my'), w(rng, 'tamil-my')];
    const d = dob(rng, { dayMax: 12, monthMax: 12, distinctDayMonth: true });
    add(
      'demo-1-p1',
      {
        unit: unit.name,
        surname: ` ${s} `,
        name1: ` ${g.join(' ')} a/p`,
        rank: 'DSP',
        dobIso: d.iso,
        ...placeA,
        country: MY,
        nationality: MY,
        search: MY,
        sex: 'F',
      },
      `${s}, ${g.join(' ')} a/p`,
      { name: `${s}, ${g.join(' ')} a/p   `, dob: `${d.d}/${d.m}/${d.y}`, pob: pob(null, null, MY) },
      ['request-cell-whitespace', 'dob-day-month-swapped', 'pob-city-state-dropped', 'unit-type-differs'],
    );
  }
  // P2: Tamil-Malaysian woman; DOB in the short date style; city holds the state name; the DC returns a different
  // month of birth (day > 12, so this is not a swap) and drops city/state.
  {
    const s = w(rng, 'tamil-my', 3);
    const g = w(rng, 'tamil-my');
    const d = dob(rng, { dayMin: 13, dayMax: 28 });
    let m2 = int(rng, 1, 12);
    if (m2 === d.m) m2 = (m2 % 12) + 1;
    add(
      'demo-1-p2',
      {
        unit: unit.name,
        surname: s,
        name1: `${g} a/p`,
        rank: 'Assistant of superintendant',
        dobIso: d.iso,
        dobShortStyle: true,
        city: placeA.state,
        state: placeA.state,
        country: MY,
        nationality: MY,
        search: MY,
        sex: 'F',
      },
      `${s}, ${g} a/p`,
      { name: `${s}, ${g} a/p   `, dob: `${m2}/${d.d}/${d.y}`, pob: pob(null, null, MY) },
      ['dob-month-differs', 'pob-city-state-dropped', 'unit-type-differs'],
    );
  }
  // P3: Malay man with "Bin <patronym>" in the Surname cell and three given names (trailing space); the DC upper-cases
  // the patronym and moves "Bin" to the end of the given names; POB upper-cased.
  {
    const s = w(rng, 'malay', 3);
    const g = [w(rng, 'malay'), w(rng, 'malay'), w(rng, 'malay', 1)];
    const d = dob(rng, { dayMin: 13, dayMax: 28 });
    add(
      'demo-1-p3',
      {
        unit: unit.name,
        surname: `Bin ${s}`,
        name1: `${g.join(' ')} `,
        rank: 'Mr.',
        dobIso: d.iso,
        dobShortStyle: true,
        city: placeB,
        state: placeB,
        country: MY,
        nationality: MY,
        search: MY,
        sex: 'M',
      },
      `Bin ${s}, ${g.join(' ')}`,
      {
        name: `${s.toUpperCase()}, ${g.join(' ')} Bin`,
        dob: us(d.iso),
        pob: pob(placeB.toUpperCase(), placeB.toUpperCase(), MY),
      },
      [
        'request-cell-whitespace',
        'particle-moved-surname-to-given',
        'surname-upper-case',
        'pob-upper-case',
        'unit-type-differs',
      ],
    );
  }
  // P4: woman with three given names in Name 1 and a leading space in Surname; the DC uses the first given name as the
  // surname, inserts "A/P" and appends the old surname; it also returns a different place of birth.
  {
    const s = w(rng, 'tamil-my', 2);
    const g = [w(rng, 'tamil-my'), w(rng, 'tamil-my'), w(rng, 'tamil-my', 1)];
    const d = dob(rng, { dayMax: 12, monthMax: 12 });
    add(
      'demo-1-p4',
      {
        unit: unit.name,
        surname: ` ${s}`,
        name1: g.join(' '),
        rank: 'Insp',
        dobIso: d.iso,
        dobShortStyle: true,
        ...placeA,
        country: MY,
        nationality: MY,
        search: MY,
        sex: 'F',
      },
      `${s}, ${g.join(' ')}`,
      {
        name: `${g[0]}, ${g[0]} ${g[1]} A/P ${g[2]} ${s}   `,
        dob: us(d.iso),
        pob: pob(placeB.toUpperCase(), placeB.toUpperCase(), MY),
      },
      ['request-cell-whitespace', 'surname-replaced-by-given', 'particle-added', 'pob-differs', 'unit-type-differs'],
    );
  }
  // P5: Malay woman with "Binti" in Name 1; rendered the same apart from the dropped city/state.
  {
    const s = w(rng, 'malay', 2);
    const g = w(rng, 'malay', 3);
    const d = dob(rng, { dayMin: 13, dayMax: 28 });
    add(
      'demo-1-p5',
      {
        unit: unit.name,
        surname: s,
        name1: `${g} Binti`,
        rank: 'Ms',
        dobIso: d.iso,
        city: placeC,
        state: w(rng, 'malay'),
        country: MY,
        nationality: MY,
        search: MY,
        sex: 'F',
      },
      `${s}, ${g} Binti`,
      { name: `${s}, ${g} Binti   `, dob: us(d.iso), pob: pob(null, null, MY) },
      ['pob-city-state-dropped', 'unit-type-differs'],
    );
  }
  return { people, unit, asOf, event: '2026-12-08' };
}

/**
 * Pair 2: two units, four Thai people in Latin script. The DC file that comes back answers a different request:
 * nobody on the request is in it; it names a commander and one individual (Latin + Thai-script names) of a third unit.
 */
function pair2(rng: Rng): { people: DemoPerson[]; units: UnitDef[]; respUnit: string; asOf: string; event: string } {
  const units: UnitDef[] = [
    {
      name: 'Example Digital Support Unit, Example Technology Crime Division, Example Cyber Investigation Bureau, Example Royal Police',
      type: 'Police',
      country: TH,
    },
    {
      name: 'Example International Liaison Sub-Division, Example General Staff Division, Example Cyber Investigation Bureau, Example Royal Police',
      type: 'Police',
      country: TH,
    },
  ];
  const respUnit =
    'Example Sub-Division 7, Example Economic Crime Division, Example Central Investigation Bureau, Example Royal Police';
  const asOf = '2026-11-17';
  const people: DemoPerson[] = [];
  const firstRow = 10; // 2 unit rows: sep 6, INDIVIDUALS 7, sub 8, header 9
  const sexes: ('M' | 'F')[] = ['M', 'M', 'M', 'F'];
  sexes.forEach((sex, i) => {
    const s = w(rng, 'thai', int(rng, 3, 4));
    const g = w(rng, 'thai', 3);
    const d = dob(rng);
    people.push({
      id: `demo-2-p${i + 1}`,
      display: `${s}, ${g}`,
      request: {
        file: 'request2',
        row: firstRow + i,
        cells: personCells({
          unit: (i < 3 ? units[0] : units[1])!.name,
          surname: s,
          name1: g,
          dobIso: d.iso,
          country: TH,
          search: TH,
          sex,
        }),
      },
      differences: ['no-response-row'],
    });
  });
  // Response-only people: Latin "Surname, Given" followed by the Thai-script given name and surname, two trailing
  // spaces; DOBs where day and month are both <= 12.
  const thaiName = (): { latin: string; name: string } => {
    const s = w(rng, 'thai', int(rng, 3, 4));
    const g = w(rng, 'thai', 2);
    const ts = genWord(rng, 'thai-script', 3);
    const tg = genWord(rng, 'thai-script', 2);
    return { latin: `${s}, ${g}`, name: `${s}, ${g} ${tg} ${ts}  ` };
  };
  const cmd = thaiName();
  const cmdDob = dob(rng, { dayMax: 12, monthMax: 12, distinctDayMonth: true });
  const cmdPlace = { city: w(rng, 'western'), state: w(rng, 'western') };
  people.push({
    id: 'demo-2-x1',
    display: cmd.latin,
    response: {
      file: 'response2',
      section: 'approved-unit',
      row: 9,
      spec: {
        disp: 'Approve',
        name: cmd.name,
        dob: us(cmdDob.iso),
        pob: pob(cmdPlace.city, cmdPlace.state, 'UNITED STATES'),
        unitType: 'Police',
        unitName: respUnit,
        cert: us(asOf),
        expires: us(addDays(asOf, 31)),
      },
    },
    differences: ['not-on-request', 'named-commander', 'thai-script-in-name', 'dob-day-month-ambiguous', 'pob-abroad'],
  });
  const ind = thaiName();
  const indDob = dob(rng, { dayMax: 12, monthMax: 12, distinctDayMonth: true });
  const indPlace = w(rng, 'thai');
  people.push({
    id: 'demo-2-x2',
    display: ind.latin,
    response: {
      file: 'response2',
      section: 'approved-individual',
      row: 13,
      spec: {
        disp: 'Approve',
        name: ind.name,
        dob: us(indDob.iso),
        pob: pob(indPlace, indPlace, TH),
        unitType: 'Police',
        unitName: respUnit,
        cert: us(asOf),
        expires: us(addDays(asOf, 365)),
      },
    },
    differences: ['not-on-request', 'thai-script-in-name', 'dob-day-month-ambiguous'],
  });
  return { people, units, respUnit, asOf, event: '2026-12-14' };
}

const LABELS = {
  au: 'Approved Unit/Commander:',
  ai: 'Approved Individuals:',
  nu: 'Non Approved Unit/Commander:',
  ni: 'Non Approved Individuals:',
};

/**
 * Matcher outcome per matched person of pair 1, fixed here as the expectation (tests/security/demo-dataset.test.ts
 * checks it against the real import). Rows whose DOB or place of birth disagree stay pending; the others link.
 */
const PAIR1_PENDING = new Set(['demo-1-p1', 'demo-1-p2', 'demo-1-p4']);

export function generateDemoDataset(): DemoDataset {
  const rng = createRng(DEMO_SEED);
  const p1 = pair1(rng);
  const p2 = pair2(rng);
  const all = [...p1.people, ...p2.people];
  const files: DemoDataset['files'] = [];
  const xlsxStrings = new Map<string, Set<string>>();
  const put = (key: keyof typeof DEMO_FILES, built: { bytes: Uint8Array; strings: Set<string> }): void => {
    const path = `demo/${DEMO_FILES[key]}`;
    files.push({ path, data: built.bytes });
    xlsxStrings.set(path, built.strings);
  };
  const reqPeople = (file: keyof typeof DEMO_FILES): RowCells[] =>
    all.filter((p) => p.request?.file === file).map((p) => p.request!.cells);

  put(
    'request1',
    buildInvestcWorkbook({ unitRows: [unitCells(p1.unit), null, null, null], people: reqPeople('request1') }),
  );
  put('request2', buildInvestcWorkbook({ unitRows: p2.units.map(unitCells), people: reqPeople('request2') }));

  const rowsOf = (file: keyof typeof DEMO_FILES, section: string): ResponseRowSpec[] =>
    all.filter((p) => p.response?.file === file && p.response.section === section).map((p) => p.response!.spec);

  put(
    'response1',
    buildResponseWorkbook({
      line1: `Final Results as of ${us(p1.asOf)}`,
      line2: 'Post: EXAMPLE CAPITAL NORTH',
      line3: 'Batch ID: DEMO-0000000001',
      line4: `Assistance: Example Regional Workshop for Specialised Units on Online Child Protection (EOCP), - Example Harbour City - ${us(p1.event)}`,
      hiddenTrailingColumns: true,
      sections: [
        {
          label: LABELS.au,
          rows: [
            {
              disp: 'Approve',
              name: 'UNKNOWN,    ',
              dob: '',
              pob: pob(null, null, null),
              unitType: 'Police',
              unitName: p1.unit.name,
              cert: us(p1.asOf),
              expires: '',
            },
          ],
        },
        { label: LABELS.ai, rows: rowsOf('response1', 'approved-individual') },
        { label: LABELS.nu, rows: [] },
        { label: LABELS.ni, rows: [] },
      ],
    }),
  );
  put(
    'response2',
    buildResponseWorkbook({
      line1: `Final Results as of ${us(p2.asOf)}`,
      line2: 'Post: EXAMPLE CAPITAL SOUTH',
      line3: 'Batch ID: DEMO-0000000002',
      line4: `Assistance: Example Regional Summit on Countering Online Child Exploitation - Example Hill City, Example Republic - ${us(p2.event)}`,
      hiddenTrailingColumns: true,
      sections: [
        { label: LABELS.au, rows: rowsOf('response2', 'approved-unit') },
        { label: LABELS.ai, rows: rowsOf('response2', 'approved-individual') },
        { label: LABELS.nu, rows: [] },
        { label: LABELS.ni, rows: [] },
      ],
    }),
  );

  const ids = (f: (p: DemoPerson) => boolean): string[] => all.filter(f).map((p) => p.id);
  const pair = (req: 'request1' | 'request2', resp: 'response1' | 'response2', batchId: string): DemoPairOutcome => {
    const onReq = all.filter((p) => p.request?.file === req);
    const onResp = all.filter((p) => p.response?.file === resp);
    const matched = ids((p) => p.request?.file === req && p.response?.file === resp);
    const unanswered = ids((p) => p.request?.file === req && !p.response);
    const unidentified = ids((p) => p.response?.file === resp && !p.request);
    const pendingReview = matched.filter((id) => PAIR1_PENDING.has(id));
    const autoMatched = matched.filter((id) => !PAIR1_PENDING.has(id));
    const respUnitRows =
      resp === 'response1' ? 1 : onResp.filter((p) => p.response!.section === 'approved-unit').length;
    return {
      request: DEMO_FILES[req],
      response: DEMO_FILES[resp],
      batchId,
      counts: {
        requestUnits: req === 'request1' ? 1 : p2.units.length,
        requestPeople: onReq.length,
        responseUnitRows: respUnitRows,
        responseIndividualRows: onResp.filter((p) => p.response!.section === 'approved-individual').length,
        matched: matched.length,
        unanswered: unanswered.length,
        unidentified: unidentified.length,
        autoMatched: autoMatched.length,
        reviewQueue: pendingReview.length + unidentified.length + unanswered.length,
      },
      matched,
      unanswered,
      unidentified,
      autoMatched,
      pendingReview,
      reviewByKind: Object.fromEntries(
        (
          [
            ['response-row-match', pendingReview.length],
            ['unmatched-response-row', unidentified.length],
            ['unanswered-request-item', unanswered.length],
          ] as const
        ).filter(([, n]) => n > 0),
      ),
    };
  };

  const manifest: DemoManifest = {
    synthetic: true,
    note: 'All content is invented (seeded grammars and "Example ..." strings). Regenerate with npm run fixtures:demo.',
    seed: DEMO_SEED,
    generator: 'tools/fixtures/demo-dataset.ts',
    files: DEMO_FILES,
    requestor: {
      name: 'Example Requestor',
      email: 'requestor@example.invalid',
      organisation: 'Example Regional Office',
    },
    requests: [
      {
        file: DEMO_FILES.request1,
        eventName: 'Example Regional Workshop for Specialised Units on Online Child Protection',
        eventStart: p1.event,
        eventEnd: addDays(p1.event, 1),
        eventLocation: 'Example Harbour City',
      },
      {
        file: DEMO_FILES.request2,
        eventName: 'Example River City Course on Digital Evidence',
        eventStart: '2027-01-18',
        eventEnd: '2027-01-20',
        eventLocation: 'Example River City',
      },
    ],
    people: all.map((p) => ({
      id: p.id,
      name: p.display,
      request: p.request ? DEMO_FILES[p.request.file] : null,
      requestRow: p.request ? `Data!${p.request.row}` : null,
      response: p.response ? DEMO_FILES[p.response.file] : null,
      responseRow: p.response ? `Final_Results!${p.response.row}` : null,
      responseSection: p.response?.section ?? null,
      differences: p.differences,
    })),
    pairs: [pair('request1', 'response1', 'DEMO-0000000001'), pair('request2', 'response2', 'DEMO-0000000002')],
  };
  files.push({ path: 'demo/manifest.json', data: canonicalJson(manifest) });
  return { files, xlsxStrings, manifest };
}

function main(): void {
  const check = process.argv.includes('--check');
  const { files } = generateDemoDataset();
  const root = resolve(DEMO_DIR, '..');
  let bad = 0;
  for (const f of files) {
    const abs = resolve(root, f.path);
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
  console.log(check ? `${files.length} demo files up to date` : `wrote ${files.length} demo files`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
