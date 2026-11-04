import { describe, expect, it } from 'vitest';
import { RULES } from '../../../src/shared/formats/rules.ts';
import { WorkbookPatcher, decodeUtf8, isoToSerial } from '../../../src/main/formats/ooxml/index.ts';
import {
  LOOKS_LIKE_REQUEST_MESSAGE,
  classifyDisp,
  headerOf,
  parseFinalResults,
  parseSectionLabel,
  parseUsDate,
  resolveDisposition,
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
const codes = (issues: ResponseIssue[], severity?: ResponseIssue['severity']) =>
  issues.filter((i) => severity === undefined || i.severity === severity).map((i) => i.code);
/** The two empty non-approved sections of the default spec are reported as information only. */
const notInfo = (issues: ResponseIssue[]) => issues.filter((i) => i.severity !== 'info');

describe('S-01 package, results sheet located by structure, request-file refusal', () => {
  it('non-xlsx bytes are an error', () => {
    const r = parseFinalResults(new Uint8Array([1, 2, 3]));
    expect(r.blocked).toBe(true);
    expect(r.fileKindGuess).toBe('unknown');
    expect(r.issues[0]).toMatchObject({ rule: 'S-01', code: 'PKG_NOT_XLSX', severity: 'error' });
  });
  it('any sheet name works: the results sheet is found by its header row', () => {
    const base = parse(spec());
    const r = parse(spec({ sheetName: 'Sheet1' }));
    expect(r.resultsSheet).toBe('Sheet1');
    expect(r.blocked).toBe(false);
    expect(r.draft.rows.map((x) => x.rowRef)).toEqual(['Sheet1!12']);
    expect(r.draft.rows.map(({ rowRef: _x, ...rest }) => rest)).toEqual(
      base.draft.rows.map(({ rowRef: _y, ...rest }) => rest),
    );
  });
  it('a workbook without any result header row is RESULTS_SHEET_NOT_FOUND', () => {
    const bytes = mutatePart(buildResponseWorkbook(spec()).bytes, 'xl/sharedStrings.xml', (x) =>
      ['DISP', 'NAME', 'DOB', 'POB', 'UNIT TYPE'].reduce((acc, h) => replaceSharedString(acc, h, `X${h}`), x),
    );
    const r = parseFinalResults(bytes);
    expect(codes(r.issues)).toEqual(['RESULTS_SHEET_NOT_FOUND']);
    expect(r.blocked).toBe(true);
  });
  it('a request workbook is refused with a plain message (no rule code in the text)', () => {
    const r = parseFinalResults(fixtureBytes('requests/req-001-basic.xlsx'));
    expect(r.fileKindGuess).toBe('investc-request');
    expect(r.blocked).toBe(true);
    expect(r.issues).toEqual([expect.objectContaining({ code: 'LOOKS_LIKE_REQUEST', severity: 'error' })]);
    expect(r.issues[0]?.message).toBe(LOOKS_LIKE_REQUEST_MESSAGE);
    expect(r.issues[0]?.message).not.toMatch(/S-0\d|LOOKS_LIKE/);
  });
  it('a lone UNITS marker in A1 of any sheet is enough to recognise a request', () => {
    const bytes = mutatePart(buildResponseWorkbook(spec()).bytes, 'xl/worksheets/sheet1.xml', (x) =>
      x.replace('<row r="1">', '<row r="1"><c r="A1" t="inlineStr"><is><t>UNITS</t></is></c>'),
    );
    expect(parseFinalResults(bytes).fileKindGuess).toBe('investc-request');
  });
});

describe('S-02 header row and column map', () => {
  it('header cells are matched by name: case, spacing, order and position do not matter', () => {
    expect(headerOf(' unit   name ')).toBe('UNIT NAME');
    expect(headerOf('Disposition')).toBe('DISP');
    expect(headerOf('Remarks')).toBeNull();
    const headers = ['EXPIRES', 'CERT DATE', 'UNIT NAME', 'UNIT TYPE', 'POB', 'DOB', 'NAME', 'DISP'];
    const base = parse(spec());
    const r = parse(spec({ headers }));
    expect(r.draft.rows).toEqual(base.draft.rows);
    expect(notInfo(r.issues)).toEqual([]);
  });
  it('a missing NAME column is an error; DISP / DOB / UNIT NAME warn; the rest is information', () => {
    const noName = parse(spec({ headers: ['DISP', 'DOB', 'POB', 'UNIT TYPE', 'UNIT NAME', 'CERT DATE', 'EXPIRES'] }));
    expect(hit(noName.issues, 'S-02', 'HEADER_COLUMN_MISSING')).toEqual([
      expect.objectContaining({ severity: 'error', field: 'NAME' }),
    ]);
    expect(noName.blocked).toBe(true);
    const noDob = parse(spec({ headers: ['DISP', 'NAME', 'POB', 'UNIT TYPE', 'UNIT NAME', 'CERT DATE', 'EXPIRES'] }));
    expect(hit(noDob.issues, 'S-02', 'HEADER_COLUMN_MISSING')).toEqual([
      expect.objectContaining({ severity: 'warning', field: 'DOB' }),
    ]);
    expect(noDob.draft.rows[0]?.dob.kind).toBe('empty');
    const noPob = parse(spec({ headers: ['DISP', 'NAME', 'DOB', 'UNIT TYPE', 'UNIT NAME', 'CERT DATE', 'EXPIRES'] }));
    expect(hit(noPob.issues, 'S-02', 'HEADER_COLUMN_MISSING')[0]?.severity).toBe('info');
    expect(noPob.blocked).toBe(false);
  });
  it('fewer than five known headers is not a header row', () => {
    const r = parse(spec({ headers: ['DISP', 'NAME', 'DOB', 'POB', 'A', 'B', 'C', 'D'] }));
    expect(codes(r.issues)).toEqual(['RESULTS_SHEET_NOT_FOUND']);
  });
  it('every later header row re-derives the map (the DC may reorder per section)', () => {
    const built = buildResponseWorkbook(
      spec({
        sections: [
          { label: LABELS[0] as string, rows: [] },
          { label: LABELS[1] as string, rows: [row({ name: 'Second, Row' })] },
        ],
      }),
    );
    // Swap DISP/NAME header cells of the second section only (its header row is 11, the data row 12).
    const swapped = mutatePart(built.bytes, 'xl/worksheets/sheet1.xml', (x) =>
      x
        .replace(
          /(<row r="11">)(<c r="A11"[^>]*>.*?<\/c>)(<c r="B11"[^>]*>.*?<\/c>)/,
          (_m, open, a, b) => `${open}${a.replace('A11', 'B11')}${b.replace('B11', 'A11')}`,
        )
        .replace(
          /(<row r="12">)(<c r="A12"[^>]*>.*?<\/c>)(<c r="B12"[^>]*>.*?<\/c>)/,
          (_m, open, a, b) => `${open}${a.replace('A12', 'B12')}${b.replace('B12', 'A12')}`,
        ),
    );
    const r = parseFinalResults(swapped);
    expect(r.draft.rows[0]).toMatchObject({ nameRaw: 'Second, Row', disp: 'Approve', dispClass: 'approved' });
  });
  it('rows keep their sheet row numbers', () => {
    const r = parse(spec({}, [row(), row()]));
    expect(r.draft.rows.map((x) => x.rowRef)).toEqual(['Final_Results!12', 'Final_Results!13']);
  });
  it('a row with values but no DISP and no NAME is skipped with a warning; the section goes on', () => {
    const rows = [row({ name: 'One, A' }), row({ name: 'Two, B' }), row({ name: 'Three, C' })];
    const cut = mutatePart(buildResponseWorkbook(spec({}, rows)).bytes, 'xl/worksheets/sheet1.xml', (x) =>
      x
        .replace(/<c r="A13"[^>]*>.*?<\/c>/, '<c r="A13" s="1"/>')
        .replace(/<c r="B13"[^>]*>.*?<\/c>/, '<c r="B13" s="4"/>'),
    );
    const r = parseFinalResults(cut);
    expect(r.draft.rows.map((x) => x.name.surname)).toEqual(['One', 'Three']);
    expect(hit(r.issues, 'S-02', 'ROW_INCOMPLETE')).toEqual([
      expect.objectContaining({ rowRef: 'Final_Results!13', severity: 'warning' }),
    ]);
  });
  it('no readable row at all is an error', () => {
    const r = parse(spec({ sections: LABELS.map((label) => ({ label, rows: [] })) }));
    expect(hit(r.issues, 'S-02', 'NO_SECTIONS')).toHaveLength(1);
    expect(r.blocked).toBe(true);
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
    expect(notInfo(r.issues)).toEqual([]);
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
  it('an impossible results date warns but keeps the batch', () => {
    const r = parse(spec({ line1: 'Final Results as of 13/45/2026' }));
    expect(r.draft.resultsAsOf).toBeNull();
    expect(r.draft.batchId).toBe('SYNTH-0000000009');
    expect(hit(r.issues, 'S-03', 'DATE_UNPARSEABLE')).toHaveLength(1);
  });
});

describe('S-04 names, including mixed script', () => {
  it('splits at the first comma and collapses spaces', () => {
    expect(splitName('Surname, Given  Names   ')).toMatchObject({
      surname: 'Surname',
      given: ['Given', 'Names'],
      hasComma: true,
    });
    expect(splitName('A B, C, D')).toMatchObject({ surname: 'A B', given: ['C', 'D'] });
    expect(splitName('Name a/l Father, Given')).toMatchObject({ surname: 'Name a/l Father' });
  });
  it('given words are split where the script changes', () => {
    expect(splitName('Zqexample, Zqgiven ทดสอบ').given).toEqual(['Zqgiven', 'ทดสอบ']);
    expect(splitName('Zqexample, Zqgivenทดสอบ').given).toEqual(['Zqgiven', 'ทดสอบ']);
    expect(splitName('ทดสอบ, ตัวอย่าง').given).toEqual(['ตัวอย่าง']); // a Thai vowel sign stays on its consonant
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
  it('a mixed Latin + Thai NAME is information, never an error', () => {
    const r = parse(spec({}, [row({ name: 'Zqexample, Zqgiven ทดสอบ ตัวอย่าง' })]));
    expect(r.draft.rows[0]?.name).toMatchObject({ script: 'Mixed', given: ['Zqgiven', 'ทดสอบ', 'ตัวอย่าง'] });
    expect(hit(r.issues, 'S-04', 'NAME_MIXED_SCRIPT')).toEqual([
      expect.objectContaining({ severity: 'info', field: 'B' }),
    ]);
    expect(r.issues.find((i) => i.code === 'NAME_MIXED_SCRIPT')?.message).not.toContain('ทดสอบ');
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

describe('S-06 sections and DISP classification', () => {
  it('classifyDisp knows the spellings and calls everything else unknown', () => {
    for (const s of ['Approve', 'Approved', 'APPROVED ', ' approved.', 'ＡＰＰＲＯＶＥ'])
      expect(classifyDisp(s), s).toBe('approved');
    for (const s of [
      'Not Approved',
      'NotApproved',
      'Non-Approved',
      'non approve',
      'Disapprove',
      'Disapproved',
      'Denied',
    ])
      expect(classifyDisp(s), s).toBe('non-approved');
    for (const s of ['Pending', 'Approval pending', 'Approved?!', 'Not yet', 'A', 'อนุมัติ'])
      expect(classifyDisp(s), s).toBe('unknown');
    expect(classifyDisp('   ')).toBe('blank');
  });
  it('section labels: case, spacing, colon and a hyphen in "Non-Approved" do not matter', () => {
    expect(parseSectionLabel('approved unit/commander')).toEqual({ kind: 'unit', approval: 'approved' });
    expect(parseSectionLabel('NON-APPROVED INDIVIDUALS :')).toEqual({ kind: 'individual', approval: 'non-approved' });
    expect(parseSectionLabel('Not Approved Commander')).toEqual({ kind: 'unit', approval: 'non-approved' });
    expect(parseSectionLabel('Pending Review Individuals:')).toBeNull();
    const labels = [
      'approved unit/commander',
      'APPROVED INDIVIDUALS :',
      '  Non-Approved Unit/Commander ',
      'Non  Approved Individuals:',
    ];
    const r = parse(spec({ sections: labels.map((label, i) => ({ label, rows: i === 1 ? [row()] : [] })) }));
    expect(notInfo(r.issues)).toEqual([]);
    expect(r.draft.rows[0]).toMatchObject({
      section: 'approved-individual',
      dispClass: 'approved',
      sectionSource: 'label',
    });
  });
  it('blank DISP inherits the section; a contradicting DISP is a conflict for review', () => {
    expect(resolveDisposition('blank', { source: 'label', approval: 'non-approved' })).toEqual({
      dispClass: 'non-approved',
      problem: null,
    });
    const r = parse(spec({}, [row({ disp: '' }), row({ disp: 'Not Approved' })]));
    expect(r.draft.rows.map((x) => x.dispClass)).toEqual(['approved', 'unknown']);
    expect(hit(r.issues, 'S-06', 'DISP_SECTION_CONFLICT')).toEqual([
      expect.objectContaining({ severity: 'warning', rowRef: 'Final_Results!13', field: 'A' }),
    ]);
    expect(r.draft.rows[1]?.section).toBe('nonapproved-individual'); // never stored as approved
  });
  it('an unrecognised DISP warns and the row is kept as unknown (never guessed)', () => {
    const r = parse(spec({}, [row({ disp: 'Pending' })]));
    expect(r.blocked).toBe(false);
    expect(r.draft.rows[0]).toMatchObject({ dispClass: 'unknown', disp: 'Pending' });
    expect(hit(r.issues, 'S-06', 'DISP_UNRECOGNISED')[0]?.message).not.toContain('Pending');
  });
  it('variant a: no first label opens an implicit approved unit section; DISP still decides', () => {
    const r = parse(
      spec({
        sections: [
          { label: null, rows: [row({ name: 'UNKNOWN, ' }), row({ name: 'Second, Unit', disp: 'Not Approved' })] },
          { label: LABELS[1] as string, rows: [row()] },
        ],
      }),
    );
    expect(r.draft.rows.map((x) => [x.section, x.sectionSource, x.dispClass])).toEqual([
      ['approved-unit', 'implicit', 'approved'],
      ['nonapproved-unit', 'implicit', 'non-approved'],
      ['approved-individual', 'label', 'approved'],
    ]);
    expect(hit(r.issues, 'S-06', 'SECTION_IMPLICIT')).toEqual([expect.objectContaining({ severity: 'info' })]);
    expect(hit(r.issues, 'S-02', 'SECTION_MISSING').map((i) => i.message)).not.toContain(
      'Section "approved unit/commander" is missing.',
    );
  });
  it('variant d: empty sections (with or without their header row) are information', () => {
    const r = parse(
      spec({
        sections: [
          { label: LABELS[0] as string, rows: [row({ name: 'UNKNOWN, ' })] },
          { label: LABELS[1] as string, rows: [] },
          { label: LABELS[2] as string, rows: [], noHeader: true },
          { label: LABELS[3] as string, rows: [row({ disp: 'Not Approved' })] },
        ],
      }),
    );
    expect(hit(r.issues, 'S-06', 'SECTION_EMPTY').map((i) => i.rowRef)).toEqual([
      'Final_Results!11',
      'Final_Results!14',
    ]);
    expect(r.draft.rows.map((x) => x.section)).toEqual(['approved-unit', 'nonapproved-individual']);
    expect(notInfo(r.issues)).toEqual([]);
  });
  it('an unknown section label warns, names the label, and its rows are classified by DISP', () => {
    const r = parseFinalResults(fixtureBytes('responses/resp-005-unknown-section.xlsx'));
    expect(r.blocked).toBe(false);
    expect(r.unknownSections).toEqual(['Pending Review Individuals:']);
    const i = hit(r.issues, 'S-06', 'UNKNOWN_SECTION');
    expect(i).toEqual([expect.objectContaining({ severity: 'warning', rawLabel: 'Pending Review Individuals:' })]);
    const pending = r.draft.rows.find((x) => x.disp === 'Pending');
    expect(pending).toMatchObject({ dispClass: 'unknown', section: 'nonapproved-individual' });
    const known = parse(
      spec({ sections: [{ label: 'Pending Review Individuals:', rows: [row({ disp: 'Not Approved' })] }] }),
    );
    expect(known.draft.rows[0]).toMatchObject({ dispClass: 'non-approved', section: 'nonapproved-individual' });
  });
  it('a repeated section warns and keeps its rows', () => {
    const dup = parse(
      spec({
        sections: [...LABELS.map((label) => ({ label, rows: [] })), { label: LABELS[1] as string, rows: [row()] }],
      }),
    );
    expect(hit(dup.issues, 'S-02', 'SECTION_DUPLICATE')).toEqual([expect.objectContaining({ severity: 'warning' })]);
    expect(dup.draft.rows).toHaveLength(1);
  });
  it('sections end after two empty rows; a later stray row is ignored with a warning', () => {
    const bytes = mutatePart(buildResponseWorkbook(spec()).bytes, 'xl/worksheets/sheet1.xml', (x) =>
      x.replace(
        '</sheetData>',
        '<row r="40"><c r="A40" t="inlineStr"><is><t>Synthetic footnote</t></is></c></row></sheetData>',
      ),
    );
    const r = parseFinalResults(bytes);
    expect(r.draft.rows).toHaveLength(1);
    expect(hit(r.issues, 'S-02', 'ROW_INCOMPLETE')).toEqual([expect.objectContaining({ rowRef: 'Final_Results!40' })]);
  });
});

describe('S-07 hidden and extra sheets and columns', () => {
  it('extra sheets (one hidden, one before the results) are information', () => {
    const r = parse(
      spec({
        sheetName: 'Results',
        extraSheets: [
          { name: 'Notes', position: 'before', rows: ['Synthetic note'] },
          { name: 'Lists', position: 'after', hidden: true, rows: ['Approve'] },
        ],
      }),
    );
    expect(r.resultsSheet).toBe('Results');
    expect(hit(r.issues, 'S-07', 'EXTRA_SHEETS')).toEqual([expect.objectContaining({ severity: 'info' })]);
    expect(hit(r.issues, 'S-07', 'EXTRA_SHEETS')[0]?.message).toContain('1 hidden');
    expect(r.draft.rows).toHaveLength(1);
  });
  it('a hidden results sheet is still read', () => {
    const bytes = mutatePart(buildResponseWorkbook(spec()).bytes, 'xl/workbook.xml', (x) =>
      x.replace('sheetId="3"', 'sheetId="3" state="hidden"'),
    );
    const r = parseFinalResults(bytes);
    expect(r.draft.rows).toHaveLength(1);
    expect(hit(r.issues, 'S-07', 'EXTRA_SHEETS')[0]?.message).toContain('hidden');
  });
  it('an extra header column is information; values beyond the header are ignored', () => {
    const r = parse(
      spec({ headers: ['DISP', 'NAME', 'DOB', 'POB', 'UNIT TYPE', 'UNIT NAME', 'REMARKS', 'CERT DATE', 'EXPIRES'] }, [
        row({ extra: 'Synthetic remark' }),
      ]),
    );
    expect(hit(r.issues, 'S-07', 'HEADER_COLUMN_EXTRA')).toEqual([
      expect.objectContaining({ severity: 'info', field: 'G', rowRef: 'Final_Results!8' }),
    ]);
    expect(r.draft.rows).toEqual(parse(spec()).draft.rows);
    const base = parse(spec());
    const bytes = mutatePart(buildResponseWorkbook(spec()).bytes, 'xl/worksheets/sheet1.xml', (x) =>
      x.replace(
        /(<row r="12">.*?)(<\/row>)/,
        '$1<c r="J12" t="inlineStr"><is><t>extra note</t></is></c><c r="K12" t="b"><v>1</v></c>$2',
      ),
    );
    const k = parseFinalResults(bytes);
    expect(k.draft.rows).toEqual(base.draft.rows);
    expect(k.issues).toEqual(base.issues);
  });
});

describe('S-08 metadata by label', () => {
  it('B1..B4 are parsed into the draft header', () => {
    const r = parse(spec());
    expect(r.draft).toMatchObject({
      batchId: 'SYNTH-0000000009',
      post: 'Example City',
      resultsAsOf: '2026-10-22',
      assistanceLine: 'Example - Example City - 11/20/2026',
    });
    expect(notInfo(r.issues)).toEqual([]);
  });
  it('labels are found in any column, in any order, with the value in the next cell', () => {
    const a = parse(spec({ metaColumn: 'A' }));
    expect(a.draft).toMatchObject({ batchId: 'SYNTH-0000000009', resultsAsOf: '2026-10-22' });
    const r = parse(
      spec({
        line1: 'Assistance: Example',
        line2: 'batch id:  synth-0000000009',
        line3: 'POST: X',
        line4: 'Final Results as of 1/2/2026',
      }),
    );
    expect(r.draft).toMatchObject({
      batchId: 'SYNTH-0000000009',
      post: 'X',
      resultsAsOf: '2026-01-02',
      assistanceLine: 'Example',
    });
    const split = mutatePart(
      buildResponseWorkbook(spec({ line3: 'Batch ID:' })).bytes,
      'xl/worksheets/sheet1.xml',
      (x) => x.replace(/<c r="C3"[^>]*\/>/, '<c r="C3" t="inlineStr"><is><t>SYNTH-0000000042</t></is></c>'),
    );
    expect(parseFinalResults(split).draft.batchId).toBe('SYNTH-0000000042');
  });
  it('missing batch id / date warn (the wizard asks); missing post / assistance are information', () => {
    const r = parse(spec({ line1: null, line2: null, line3: null, line4: null }));
    expect(r.blocked).toBe(false);
    const m = hit(r.issues, 'S-08', 'META_LABEL_MISSING');
    expect(m.map((i) => [i.field, i.severity])).toEqual([
      ['Final Results as of', 'warning'],
      ['Post:', 'info'],
      ['Batch ID:', 'warning'],
      ['Assistance:', 'info'],
    ]);
    expect(r.draft).toMatchObject({ batchId: null, post: null, resultsAsOf: null, assistanceLine: null });
    const odd = parse(spec({ line3: 'Batch ID: to follow' }));
    expect(odd.draft.batchId).toBeNull();
    expect(hit(odd.issues, 'S-08', 'META_LABEL_MISSING')[0]?.message).not.toContain('to follow');
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
  it('a very long sheet name keeps rowRef within the IPC bound', () => {
    const r = parse(spec({ sheetName: 'A'.repeat(31) }));
    expect(r.draft.rows[0]?.rowRef.length).toBeLessThanOrEqual(32);
    expect(r.draft.rows[0]?.rowRef.endsWith('!12')).toBe(true);
  });
  it('issue messages never carry a cell value of the new rules', () => {
    const r = parse(
      spec({ line3: 'Batch ID: zqsecret' }, [row({ disp: 'Zqsecretdisp', name: 'Zqsecretname, Zq ทดสอบ' })]),
    );
    const newCodes = new Set(['META_LABEL_MISSING', 'DISP_UNRECOGNISED', 'NAME_MIXED_SCRIPT', 'SECTION_EMPTY']);
    for (const i of r.issues.filter((x) => newCodes.has(x.code)))
      expect(i.message.toLowerCase()).not.toContain('zqsecret');
  });
  it('every S rule has a test in this file', () => {
    const ids = RULES.filter((r) => r.group === 'response').map((r) => r.id);
    expect(ids).toEqual(['S-01', 'S-02', 'S-03', 'S-04', 'S-05', 'S-06', 'S-07', 'S-08']);
  });
});
