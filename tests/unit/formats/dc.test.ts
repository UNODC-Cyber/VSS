import { describe, expect, it } from 'vitest';
import { RULES } from '../../../src/shared/formats/rules.ts';
import { WorkbookPatcher, decodeUtf8, isoToSerial } from '../../../src/main/formats/ooxml/index.ts';
import {
  parseFinalResults,
  parseUsDate,
  splitName,
  splitPob,
  type ResponseIssue,
} from '../../../src/main/formats/dc/index.ts';
import { detectScript } from '../../../src/main/formats/script.ts';
import {
  buildResponseWorkbook,
  type ResponseRowSpec,
  type ResponseWorkbookSpec,
} from '../../../tools/fixtures/response-builder.ts';
import { fixtureBytes, mutatePart, replaceSharedString } from './helpers.ts';

const row = (over: Partial<ResponseRowSpec> = {}): ResponseRowSpec => ({
  disp: 'Approve',
  name: 'Example, Person',
  dob: '1/2/1990',
  pob: 'CITY - STATE - THAILAND',
  unitType: 'Police',
  unitName: 'Example Unit',
  cert: '10/20/2026',
  expires: '10/20/2027',
  ...over,
});
const LABELS = [
  'Approved Unit/Commander:',
  'Approved Individuals:',
  'Non Approved Unit/Commander:',
  'Non Approved Individuals:',
];
const spec = (over: Partial<ResponseWorkbookSpec> = {}, rows: ResponseRowSpec[] = [row()]): ResponseWorkbookSpec => ({
  line1: 'Final Results as of 10/22/2026',
  line2: 'Post: Example City',
  line3: 'Batch ID: SYNTH-0000000009',
  line4: 'Assistance: Example - Example City - 11/20/2026',
  sections: LABELS.map((label, i) => ({ label, rows: i === 1 ? rows : [] })),
  ...over,
});
const parse = (s: ResponseWorkbookSpec) => parseFinalResults(buildResponseWorkbook(s).bytes);
const hit = (issues: ResponseIssue[], rule: string, code?: string) =>
  issues.filter((i) => i.rule === rule && (code === undefined || i.code === code));

describe('S-01 sheet and header lines', () => {
  it('non-xlsx bytes are an error', () => {
    const r = parseFinalResults(new Uint8Array([1, 2, 3]));
    expect(r.blocked).toBe(true);
    expect(r.issues[0]).toMatchObject({ rule: 'S-01', code: 'PKG_NOT_XLSX', severity: 'error' });
  });
  it('the sheet must be called Final_Results', () => {
    const bytes = mutatePart(buildResponseWorkbook(spec()).bytes, 'xl/workbook.xml', (x) =>
      x.replace('Final_Results', 'Sheet1'),
    );
    const r = parseFinalResults(bytes);
    expect(r.issues).toEqual([expect.objectContaining({ rule: 'S-01', code: 'SHEET_MISSING', severity: 'error' })]);
    expect(r.draft.rows).toEqual([]);
  });
  it('B1..B4 are parsed into the draft header', () => {
    const r = parse(spec());
    expect(r.draft).toMatchObject({
      batchId: 'SYNTH-0000000009',
      post: 'Example City',
      resultsAsOf: '2026-10-22',
      assistanceLine: 'Example - Example City - 11/20/2026',
    });
    expect(r.issues).toEqual([]);
  });
  it('each malformed header line is an error', () => {
    const r = parse(spec({ line1: 'Results', line2: 'Where: x', line3: 'Batch ID: 12', line4: 'Assist: x' }));
    expect(hit(r.issues, 'S-01', 'HEADER_CELL_MISMATCH').map((i) => i.rowRef)).toEqual([
      'Final_Results!1',
      'Final_Results!2',
      'Final_Results!3',
      'Final_Results!4',
    ]);
    expect(r.blocked).toBe(true);
  });
  it('an impossible results date warns under S-03 but keeps the batch', () => {
    const r = parse(spec({ line1: 'Final Results as of 13/45/2026' }));
    expect(r.draft.resultsAsOf).toBeNull();
    expect(hit(r.issues, 'S-03', 'DATE_UNPARSEABLE')).toHaveLength(1);
  });
});

describe('S-02 sections', () => {
  it('label matching ignores case, spacing and the colon', () => {
    const labels = [
      'approved unit/commander',
      'APPROVED INDIVIDUALS :',
      '  Non Approved Unit/Commander ',
      'Non  Approved Individuals:',
    ];
    const r = parse(spec({ sections: labels.map((label, i) => ({ label, rows: i === 1 ? [row()] : [] })) }));
    expect(r.issues).toEqual([]);
    expect(r.draft.rows[0]?.section).toBe('approved-individual');
  });
  it('a header row that differs is an error per column', () => {
    const bytes = mutatePart(buildResponseWorkbook(spec()).bytes, 'xl/sharedStrings.xml', (x) =>
      replaceSharedString(x, 'EXPIRES', 'EXPIRY'),
    );
    const r = parseFinalResults(bytes);
    expect(hit(r.issues, 'S-02', 'SECTION_HEADER_MISMATCH')).toHaveLength(4);
    expect(r.blocked).toBe(true);
  });
  it('missing sections warn, no sections at all is an error', () => {
    const some = parse(spec({ sections: [{ label: LABELS[1] as string, rows: [row()] }] }));
    expect(hit(some.issues, 'S-02', 'SECTION_MISSING')).toHaveLength(3);
    expect(some.blocked).toBe(false);
    const none = parse(spec({ sections: [] }));
    expect(hit(none.issues, 'S-02', 'NO_SECTIONS')).toHaveLength(1);
    expect(none.blocked).toBe(true);
  });
  it('a repeated section is an error and out-of-order sections warn', () => {
    const dup = parse(
      spec({
        sections: [...LABELS.map((label) => ({ label, rows: [] })), { label: LABELS[1] as string, rows: [row()] }],
      }),
    );
    expect(hit(dup.issues, 'S-02', 'SECTION_DUPLICATE')).toHaveLength(1);
    const swapped = parse(
      spec({
        sections: [LABELS[1], LABELS[0], LABELS[2], LABELS[3]].map((label) => ({ label: label as string, rows: [] })),
      }),
    );
    expect(hit(swapped.issues, 'S-02', 'SECTION_ORDER')).toHaveLength(1);
  });
  it('data rows end at the first row with empty NAME and DISP', () => {
    const rows = [row({ name: 'One, A' }), row({ name: 'Two, B' }), row({ name: 'Three, C' })];
    const r = parse(spec({}, rows));
    expect(r.draft.rows.map((x) => x.name.surname)).toEqual(['One', 'Two', 'Three']);
    const bytes = buildResponseWorkbook(spec({}, rows)).bytes;
    // Blank out the second row's DISP and NAME: rows 2 and 3 of the section are then cut off.
    const cut = mutatePart(bytes, 'xl/worksheets/sheet1.xml', (x) =>
      x
        .replace(/<c r="A13"[^>]*>.*?<\/c>/, '<c r="A13" s="1"/>')
        .replace(/<c r="B13"[^>]*>.*?<\/c>/, '<c r="B13" s="4"/>'),
    );
    expect(parseFinalResults(cut).draft.rows.map((x) => x.name.surname)).toEqual(['One']);
  });
  it('rows keep their sheet row numbers', () => {
    const r = parse(spec({}, [row(), row()]));
    expect(r.draft.rows.map((x) => x.rowRef)).toEqual(['Final_Results!12', 'Final_Results!13']);
  });
});

describe('S-03 dates', () => {
  it('text M/D/YYYY and MM/DD/YYYY parse; serials are accepted', () => {
    expect(parseUsDate('3/4/2026')).toBe('2026-03-04');
    expect(parseUsDate('03/04/2026 ')).toBe('2026-03-04');
    expect(parseUsDate('13/4/2026')).toBeNull();
    expect(parseUsDate('2/30/2026')).toBeNull();
    expect(parseUsDate('2026-03-04')).toBeNull();
    const bytes = buildResponseWorkbook(spec()).bytes;
    const serial = isoToSerial('2026-10-20') as number;
    const patched = mutatePart(bytes, 'xl/worksheets/sheet1.xml', (x) =>
      x.replace(/<c r="G12"[^>]*>.*?<\/c>/, `<c r="G12" s="4"><v>${serial}</v></c>`),
    );
    const r = parseFinalResults(patched);
    expect(r.draft.rows[0]?.certDate).toEqual({
      kind: 'serial',
      value: String(serial),
      parsed: '2026-10-20',
      ambiguousDayMonth: false,
    });
    expect(r.issues).toEqual([]);
  });
  it('an unreadable date keeps its text, has parsed = null and warns', () => {
    const r = parse(spec({}, [row({ dob: '31/31/1990', cert: 'soon', expires: '' })]));
    const x = r.draft.rows[0];
    expect(x?.dob).toMatchObject({ kind: 'text', value: '31/31/1990', parsed: null });
    expect(x?.certDate).toMatchObject({ kind: 'text', value: 'soon', parsed: null });
    expect(x?.expires.kind).toBe('empty');
    expect(hit(r.issues, 'S-03', 'DATE_UNPARSEABLE').map((i) => i.field)).toEqual(['C', 'G']);
    expect(r.blocked).toBe(false);
  });
});

describe('S-04 names', () => {
  it('splits at the first comma and collapses spaces', () => {
    expect(splitName('Surname, Given  Names   ')).toMatchObject({
      surname: 'Surname',
      given: ['Given', 'Names'],
      hasComma: true,
    });
    expect(splitName('A B, C, D')).toMatchObject({ surname: 'A B', given: ['C', 'D'] });
    expect(splitName('Name a/l Father, Given')).toMatchObject({ surname: 'Name a/l Father' });
  });
  it('UNKNOWN is an unknown commander (any case, trailing spaces)', () => {
    expect(splitName('UNKNOWN,    ')).toMatchObject({ surname: 'UNKNOWN', given: [], unknownCommander: true });
    expect(splitName('unknown, x').unknownCommander).toBe(true);
    expect(splitName('Unknownson, x').unknownCommander).toBe(false);
  });
  it('the draft keeps the verbatim NAME and the unknown flag', () => {
    const r = parse(
      spec({}, [row({ name: 'UNKNOWN,    ', dob: '', pob: ' -  - ' }), row({ name: 'Plainname' }), row({ name: '' })]),
    );
    const [a, b, c] = r.draft.rows;
    expect(a).toMatchObject({ nameRaw: 'UNKNOWN,    ', unknownCommander: true });
    expect(b?.name).toMatchObject({ surname: 'Plainname', given: [] });
    expect(c?.name.surname).toBe('');
    expect(hit(r.issues, 'S-04').map((i) => i.code)).toEqual(['NAME_NO_COMMA', 'NAME_EMPTY']);
  });
  it('detects the script of a name', () => {
    expect(detectScript('Example, Person')).toBe('Latn');
    expect(detectScript('สมชาย, ใจดี')).toBe('Thai');
    expect(detectScript('สมชาย, Person')).toBe('Mixed');
    expect(detectScript('១២៣')).toBe('Other');
    expect(detectScript('')).toBe('Other');
  });
});

describe('S-05 place of birth', () => {
  it('splits City - State - COUNTRY with blank parts', () => {
    const t = (s: string) => splitPob(s).pob;
    expect(t('CITY - STATE - THAILAND')).toEqual({ city: 'CITY', state: 'STATE', country: 'THAILAND' });
    expect(t(' -  - THAILAND')).toEqual({ city: null, state: null, country: 'THAILAND' });
    expect(t('CITY -  - THAILAND')).toEqual({ city: 'CITY', state: null, country: 'THAILAND' });
    expect(t(' - STATE - THAILAND')).toEqual({ city: null, state: 'STATE', country: 'THAILAND' });
    expect(t(' -  - ')).toEqual({ city: null, state: null, country: null });
    expect(t('')).toEqual({ city: null, state: null, country: null });
  });
  it('tolerates one or two parts (last is the country) and hyphenated names', () => {
    expect(splitPob('THAILAND').pob).toEqual({ city: null, state: null, country: 'THAILAND' });
    expect(splitPob('CITY - THAILAND').pob).toEqual({ city: 'CITY', state: null, country: 'THAILAND' });
    expect(splitPob('BAN-PONG - NORTH-EAST - THAILAND').pob).toEqual({
      city: 'BAN-PONG',
      state: 'NORTH-EAST',
      country: 'THAILAND',
    });
  });
  it('extra parts are joined into the state and warn', () => {
    expect(splitPob('A - B - C - D').pob).toEqual({ city: 'A', state: 'B - C', country: 'D' });
    const r = parse(spec({}, [row({ pob: 'A - B - C - D' })]));
    expect(hit(r.issues, 'S-05', 'POB_TOO_MANY_PARTS')).toHaveLength(1);
  });
});

describe('S-06 disposition and unknown sections', () => {
  it('stores DISP raw and takes the disposition from the section', () => {
    const r = parseFinalResults(fixtureBytes('responses/resp-003-nonapproved.xlsx'));
    const disp = new Map(r.draft.rows.map((x) => [x.section, x.disp]));
    expect(disp.get('approved-individual')).toBe('Approve');
    expect(disp.get('nonapproved-individual')).toBe('NotApproved');
    expect(disp.get('nonapproved-unit')).toBe('NotApproved');
    expect(r.blocked).toBe(false);
  });
  it('an unknown section label blocks the import and is shown raw', () => {
    const r = parseFinalResults(fixtureBytes('responses/resp-005-unknown-section.xlsx'));
    expect(r.blocked).toBe(true);
    expect(r.unknownSections).toEqual(['Pending Review Individuals:']);
    const i = hit(r.issues, 'S-06', 'UNKNOWN_SECTION');
    expect(i).toEqual([expect.objectContaining({ severity: 'error', rawLabel: 'Pending Review Individuals:' })]);
    expect(i[0]?.message).toContain('Pending Review Individuals:');
    expect(r.draft.rows.some((x) => x.disp === 'Pending')).toBe(false); // rows of the unknown section are not imported
  });
  it('near-miss spellings are unknown too (no fuzzy matching)', () => {
    const r = parse(
      spec({
        sections: [
          { label: 'Non-Approved Individuals:', rows: [row()] },
          ...LABELS.map((label) => ({ label, rows: [] })),
        ],
      }),
    );
    expect(r.unknownSections).toEqual(['Non-Approved Individuals:']);
    expect(r.blocked).toBe(true);
  });
});

describe('S-07 extra sheets and columns', () => {
  it('extra sheets warn', () => {
    const bytes = mutatePart(buildResponseWorkbook(spec()).bytes, 'xl/workbook.xml', (x) =>
      x.replace('</sheets>', '<sheet name="Notes" sheetId="9" r:id="rId9"/></sheets>'),
    );
    const r = parseFinalResults(bytes);
    expect(hit(r.issues, 'S-07', 'EXTRA_SHEETS')).toHaveLength(1);
    expect(r.draft.rows).toHaveLength(1);
    expect(r.blocked).toBe(false);
  });
  it('columns beyond H are ignored', () => {
    const base = parse(spec());
    const bytes = mutatePart(buildResponseWorkbook(spec()).bytes, 'xl/worksheets/sheet1.xml', (x) =>
      x.replace(
        /(<row r="12">.*?)(<\/row>)/,
        '$1<c r="J12" t="inlineStr"><is><t>extra note</t></is></c><c r="K12" t="b"><v>1</v></c>$2',
      ),
    );
    const r = parseFinalResults(bytes);
    expect(r.draft.rows).toEqual(base.draft.rows);
    expect(r.issues).toEqual(base.issues);
  });
});

describe('robustness and coverage', () => {
  it('never throws on damaged parts', () => {
    const base = buildResponseWorkbook(spec()).bytes;
    for (const fn of [
      (x: string) => x.slice(0, 300),
      (x: string) => x.replace(/<sheetData>[\s\S]*<\/sheetData>/, ''),
      (x: string) => x.replace(/<v>\d+<\/v>/g, '<v>99999</v>'),
    ]) {
      expect(() => parseFinalResults(mutatePart(base, 'xl/worksheets/sheet1.xml', fn))).not.toThrow();
    }
    const p = WorkbookPatcher.fromBytes(base);
    p.removePart('xl/sharedStrings.xml');
    expect(() => parseFinalResults(p.toBytes())).not.toThrow();
    expect(decodeUtf8(new Uint8Array())).toBe('');
  });
  it('every S rule has a test in this file', () => {
    const ids = RULES.filter((r) => r.group === 'response').map((r) => r.id);
    expect(ids).toEqual(['S-01', 'S-02', 'S-03', 'S-04', 'S-05', 'S-06', 'S-07']);
  });
});
