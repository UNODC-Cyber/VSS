import { describe, expect, it } from 'vitest';
import type { ObservedPerson } from '../../../src/shared/domain/types.ts';
import { RULES } from '../../../src/shared/formats/rules.ts';
import {
  parseDobText,
  parseInvestc,
  validateRequest,
  type KnownPerson,
  type RequestLookups,
  type RuleIssue,
} from '../../../src/main/formats/investc/index.ts';
import { WorkbookPatcher } from '../../../src/main/formats/ooxml/index.ts';
import { buildRequestWorkbook } from '../../../tools/fixtures/request-builder.ts';
import { FIXTURE_NOW_DATE, REQUEST_SPECS } from '../../../tools/fixtures/generate.ts';
import type { PersonSpec, RequestSpec } from '../../../tools/fixtures/model.ts';
import { TEMPLATE, fixtureBytes, fixtureJson, mutatePart, replaceSharedString } from './helpers.ts';

const NOW = FIXTURE_NOW_DATE;
const specs = new Map(REQUEST_SPECS.map((f) => f()).map((s) => [s.id, s]));
const spec = (id: string): RequestSpec => specs.get(id) as RequestSpec;
const validate = (bytes: Uint8Array, lookups: RequestLookups | null = null): RuleIssue[] => {
  const parsed = parseInvestc(bytes);
  return [...parsed.issues, ...validateRequest(parsed, lookups, NOW)];
};
const rules = (issues: RuleIssue[]): Set<string> => new Set(issues.map((i) => i.rule));
const emptyPerson: PersonSpec = {
  unit: '',
  isHead: null,
  surname: '',
  names: [],
  dob: { kind: 'empty' },
  pobCountry: '',
  searchCountry: '',
  sex: '',
};

describe('R-01 package and sheets', () => {
  it('non-zip bytes give PKG_NOT_XLSX and never throw', () => {
    const r = parseInvestc(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9, 9]));
    expect(r.issues).toMatchObject([{ rule: 'R-01', code: 'PKG_NOT_XLSX', severity: 'error' }]);
    expect(r.units).toEqual([]);
    expect(parseInvestc(new Uint8Array(0)).issues[0]?.code).toBe('PKG_NOT_XLSX');
  });
  it('a zip without xl/workbook.xml is not an xlsx', () => {
    const p = WorkbookPatcher.fromBytes(TEMPLATE());
    p.removePart('xl/workbook.xml');
    expect(parseInvestc(p.toBytes()).issues[0]).toMatchObject({ rule: 'R-01', code: 'PKG_NOT_XLSX' });
  });
  it('renamed or reordered sheets are an error', () => {
    const bytes = mutatePart(TEMPLATE(), 'xl/workbook.xml', (x) => x.replace('name="Data"', 'name="Daten"'));
    const issues = parseInvestc(bytes).issues;
    expect(issues).toContainEqual(
      expect.objectContaining({ rule: 'R-01', code: 'PKG_SHEETS_MISMATCH', severity: 'error' }),
    );
  });
  it('a visible Reference Data sheet is only a warning', () => {
    const bytes = mutatePart(TEMPLATE(), 'xl/workbook.xml', (x) => x.replace(' state="hidden"', ''));
    const r = parseInvestc(bytes);
    expect(r.issues).toEqual([
      expect.objectContaining({ rule: 'R-01', code: 'PKG_SHEETS_MISMATCH', severity: 'warning' }),
    ]);
  });
});

describe('R-02 template version', () => {
  it('an unknown version warns and parsing continues', () => {
    const bytes = fixtureBytes('requests/req-008-unknown-version.xlsx');
    const r = parseInvestc(bytes);
    expect(r.templateVersion).toBe('9.9.9');
    expect(r.instructionsVersion).toBe('9.0.0');
    expect(r.issues).toEqual([
      expect.objectContaining({ rule: 'R-02', code: 'TEMPLATE_VERSION_UNKNOWN', severity: 'warning' }),
    ]);
    expect(r.people).toHaveLength(3);
  });
  it('a garbled version cell warns and leaves templateVersion null', () => {
    const bytes = buildRequestWorkbook({
      ...spec('req-001-basic'),
      versionCells: { c2: 'something else' },
    }).bytes;
    const r = parseInvestc(bytes);
    expect(r.templateVersion).toBeNull();
    expect(r.issues[0]).toMatchObject({
      rule: 'R-02',
      code: 'TEMPLATE_VERSION_UNKNOWN',
      field: 'Template Instructions!C2',
    });
  });
  it('the known version is silent', () => {
    expect(parseInvestc(fixtureBytes('requests/req-001-basic.xlsx')).templateVersion).toBe('1.11.0');
  });
});

describe('R-03 UNITS marker and unit headers', () => {
  it('A1 must read UNITS', () => {
    const bytes = mutatePart(TEMPLATE(), 'xl/sharedStrings.xml', (x) => replaceSharedString(x, 'UNITS', 'UNIT LIST'));
    expect(parseInvestc(bytes).issues).toContainEqual(
      expect.objectContaining({
        rule: 'R-03',
        code: 'HEADER_MISMATCH',
        severity: 'error',
        rowRef: 'Data!1',
        field: 'A',
      }),
    );
  });
  it('unit headers must match exactly (trimmed, case-sensitive)', () => {
    const bytes = mutatePart(TEMPLATE(), 'xl/sharedStrings.xml', (x) =>
      replaceSharedString(x, 'Unit Alias', 'unit alias'),
    );
    expect(parseInvestc(bytes).issues).toContainEqual(
      expect.objectContaining({ rule: 'R-03', code: 'HEADER_MISMATCH', rowRef: 'Data!3', field: 'D' }),
    );
  });
});

describe('R-04 unit block markers', () => {
  it('missing separator row', () => {
    const bytes = mutatePart(TEMPLATE(), 'xl/sharedStrings.xml', (x) =>
      replaceSharedString(x, 'LEAVE A ROW BLANK', 'nothing'),
    );
    const r = parseInvestc(bytes);
    expect(r.issues).toContainEqual(expect.objectContaining({ rule: 'R-04', code: 'MARKER_MISSING' }));
    expect(r.layout.separatorRow).toBeNull();
  });
  it('missing INDIVIDUALS marker', () => {
    const bytes = mutatePart(TEMPLATE(), 'xl/sharedStrings.xml', (x) =>
      replaceSharedString(x, 'INDIVIDUALS', 'PEOPLE'),
    );
    const r = parseInvestc(bytes);
    expect(r.issues).toContainEqual(expect.objectContaining({ rule: 'R-04', code: 'MARKER_MISSING' }));
    expect(r.people).toEqual([]);
  });
  it('unit rows run to the separator, blank rows are ignored (shifted layout)', () => {
    const r = parseInvestc(fixtureBytes('requests/req-005-shifted-layout.xlsx'));
    expect(r.units.map((u) => u.rowRef)).toEqual(['Data!4', 'Data!6']);
    expect(r.layout).toMatchObject({
      separatorRow: 8,
      individualsRow: 9,
      individualsHeaderRow: 11,
      firstPersonRow: 12,
    });
    expect(r.people).toHaveLength(4);
    expect(r.issues).toEqual([]);
  });
});

describe('R-05 individuals header and extent', () => {
  it('a wrong individuals header is reported per column', () => {
    const bytes = mutatePart(TEMPLATE(), 'xl/sharedStrings.xml', (x) => replaceSharedString(x, 'Name 4', 'Name Four'));
    expect(parseInvestc(bytes).issues).toContainEqual(
      expect.objectContaining({ rule: 'R-05', code: 'HEADER_MISMATCH', field: 'G' }),
    );
  });
  it('a missing individuals header row is an error', () => {
    // Rename "* Unit Name" only where it heads the individuals block (second occurrence is the same shared string),
    // so retarget the INDIVIDUALS sub-header by dropping the header row cell A.
    const bytes = mutatePart(TEMPLATE(), 'xl/worksheets/sheet2.xml', (x) =>
      x.replace(/(<row r="8"[^>]*>)<c r="A8"[^>]*><v>\d+<\/v><\/c>/, '$1'),
    );
    expect(parseInvestc(bytes).issues).toContainEqual(
      expect.objectContaining({ rule: 'R-05', code: 'HEADER_MISMATCH', field: 'A' }),
    );
  });
  it('one empty row is tolerated, two consecutive empty rows end the block', () => {
    const base = spec('req-001-basic');
    const [a, b, c, d] = base.people as [PersonSpec, PersonSpec, PersonSpec, PersonSpec];
    const one = buildRequestWorkbook({ ...base, people: [a, emptyPerson, b, c] }).bytes;
    expect(parseInvestc(one).people.map((p) => p.surname)).toEqual([a, b, c].map((p) => p.surname));
    const two = buildRequestWorkbook({ ...base, people: [a, b, emptyPerson, emptyPerson, c, d] }).bytes;
    expect(parseInvestc(two).people.map((p) => p.surname)).toEqual([a, b].map((p) => p.surname));
  });
});

describe('R-06..R-14 on the error fixture', () => {
  const issues = validate(fixtureBytes('requests/req-004-errors.xlsx'));
  const byRule = (id: string): RuleIssue[] => issues.filter((i) => i.rule === id);
  const expected = fixtureJson<{ ruleMap: Record<string, string[]> }>('requests/req-004-errors.expected.json');
  for (const id of ['R-06', 'R-07', 'R-08', 'R-09', 'R-10', 'R-11', 'R-12', 'R-13', 'R-14']) {
    it(`${id} fires on exactly the planted rows`, () => {
      expect(byRule(id).length).toBeGreaterThan(0);
      expect([...new Set(byRule(id).map((i) => i.rowRef))].sort()).toEqual(
        [...(expected.ruleMap[id] as string[])].sort(),
      );
    });
  }
  it('each issue has a registered code for its rule', () => {
    for (const i of issues) {
      const def = RULES.find((r) => r.id === i.rule);
      expect(def?.codes, `${i.rule} ${i.code}`).toContain(i.code);
    }
  });
});

describe('R-06 required fields', () => {
  it('reports every missing required field of an otherwise empty-ish row', () => {
    const base = spec('req-001-basic');
    const blank: PersonSpec = { ...emptyPerson, names: ['X'] };
    const bytes = buildRequestWorkbook({ ...base, people: [...base.people, blank] }).bytes;
    const fields = validate(bytes)
      .filter((i) => i.rule === 'R-06' && i.rowRef === 'Data!16')
      .map((i) => i.field)
      .sort();
    expect(fields).toEqual(['dob', 'isHeadOfUnit', 'pobCountry', 'searchCountry', 'sex', 'surname', 'unitName']);
  });
});

describe('R-07 reference lists', () => {
  it('case-only differences warn, absent values error', () => {
    const issues = validate(fixtureBytes('requests/req-004-errors.xlsx'));
    const sev = (code: string, row: string) => issues.find((i) => i.code === code && i.rowRef === row)?.severity;
    expect(sev('SEX_INVALID', 'Data!18')).toBe('error'); // P2 'X'
    expect(sev('SEX_INVALID', 'Data!19')).toBe('warning'); // P3 'm'
    expect(sev('COUNTRY_NOT_IN_LIST', 'Data!19')).toBe('warning');
  });
  it('uses the file’s own Reference Data when present and the bundled copy otherwise', () => {
    const r = parseInvestc(fixtureBytes('requests/req-001-basic.xlsx'));
    expect(r.reference.source.lists).toBe('file');
    expect(r.reference.countriesPob).toContain('THAILAND');
    const noRef = mutatePart(fixtureBytes('requests/req-001-basic.xlsx'), 'xl/worksheets/sheet3.xml', (x) =>
      x.replace(/<sheetData>[\s\S]*<\/sheetData>/, '<sheetData/>'),
    );
    const r2 = parseInvestc(noRef);
    expect(r2.reference.source.lists).toBe('bundled');
    expect(r2.reference.countriesPob).toEqual(r.reference.countriesPob);
    expect(validate(noRef).filter((i) => i.severity === 'error')).toEqual([]);
  });
  it('a list edited in the file wins over the bundled one', () => {
    // Drop "Military" from the file's own unit-type list: the bundled copy still has it, the file must win.
    const bytes = mutatePart(fixtureBytes('requests/req-001-basic.xlsx'), 'xl/worksheets/sheet3.xml', (x) =>
      x.replace(/<c r="A2"[^>]*>.*?<\/c>/, ''),
    );
    const issues = validate(bytes);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'UNIT_TYPE_INVALID', severity: 'error', rowRef: 'Data!5' }),
    );
  });
  it('limits come from the instructions sheet', () => {
    const r = parseInvestc(fixtureBytes('requests/req-001-basic.xlsx'));
    expect(r.reference.source.limits).toBe('file');
    expect(r.reference.limits.person['surname']).toBe(128);
    expect(r.reference.limits.unit['name']).toBe(512);
  });
});

describe('R-08 DOB handling', () => {
  const parsed = parseInvestc(fixtureBytes('requests/req-007-text-dates.xlsx'));
  const issues = validate(fixtureBytes('requests/req-007-text-dates.xlsx'));
  it('numeric cells are serials', () => {
    expect(parsed.people[4]?.dob).toMatchObject({ kind: 'serial', value: '31822', parsed: '1987-02-14' });
  });
  it('text: DD/MM only, MM/DD only, ISO, equal readings', () => {
    expect(parsed.people[0]?.dob).toMatchObject({ kind: 'text', parsed: '1985-03-25', ambiguousDayMonth: false });
    expect(parsed.people[3]?.dob).toMatchObject({ kind: 'text', parsed: '1985-07-19', ambiguousDayMonth: false });
    expect(parsed.people[2]?.dob).toMatchObject({ kind: 'text', parsed: '1985-07-19' });
    expect(parsed.people[5]?.dob).toMatchObject({ parsed: '1990-12-12', ambiguousDayMonth: false });
  });
  it('text where both readings are valid and differ is ambiguous and read as MM/DD', () => {
    expect(parsed.people[1]?.dob).toMatchObject({ parsed: '1985-03-04', ambiguousDayMonth: true });
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'DOB_AMBIGUOUS_DM', severity: 'warning', rowRef: 'Data!10' }),
    );
  });
  it('text dates are reported as info', () => {
    expect(issues.filter((i) => i.code === 'DOB_TEXT')).toHaveLength(5);
    expect(issues.some((i) => i.severity === 'error')).toBe(false);
  });
  it('parseDobText edge cases', () => {
    expect(parseDobText('31/12/1999')).toMatchObject({ parsed: '1999-12-31', reading: 'dmy', ambiguous: false });
    expect(parseDobText('12/31/1999')).toMatchObject({ parsed: '1999-12-31', reading: 'mdy' });
    expect(parseDobText('31.12.1999').parsed).toBe('1999-12-31');
    expect(parseDobText('29/02/2001').parsed).toBeNull();
    expect(parseDobText('29/02/2000').parsed).toBe('2000-02-29');
    expect(parseDobText('1/1/99').parsed).toBeNull();
    expect(parseDobText('').parsed).toBeNull();
    expect(parseDobText('2001-02-30').parsed).toBeNull();
  });
  it('under 18, future and invalid dates are errors; a person who turns 18 today is fine', () => {
    const e = validate(fixtureBytes('requests/req-004-errors.xlsx'));
    expect(
      e
        .filter((i) => i.rule === 'R-08')
        .map((i) => i.code)
        .sort(),
    ).toEqual(['DOB_AMBIGUOUS_DM', 'DOB_FUTURE', 'DOB_INVALID', 'DOB_TEXT', 'DOB_UNDER_18'].sort());
    const base = spec('req-001-basic');
    const p = { ...(base.people[0] as PersonSpec), dob: { kind: 'serial', iso: '2008-11-03' } as const };
    const edge = buildRequestWorkbook({ ...base, people: [p] }).bytes;
    expect(validate(edge).some((i) => i.rule === 'R-08')).toBe(false);
    const q = { ...p, dob: { kind: 'serial', iso: '2008-11-04' } as const };
    const edge2 = buildRequestWorkbook({ ...base, people: [q] }).bytes;
    expect(validate(edge2).some((i) => i.code === 'DOB_UNDER_18')).toBe(true);
  });
});

describe('R-09 units', () => {
  it('names are compared after trim and whitespace collapse', () => {
    const base = spec('req-001-basic');
    const p0 = base.people[0] as PersonSpec;
    const spaced = { ...p0, unit: `  ${p0.unit.replace(/ /g, '   ')} ` };
    const bytes = buildRequestWorkbook({ ...base, people: [spaced, ...base.people.slice(1)] }).bytes;
    expect(validate(bytes).some((i) => i.code === 'UNIT_NOT_DECLARED')).toBe(false);
  });
});

describe('R-10 heads of unit', () => {
  it('none is a warning, several is an error', () => {
    const issues = validate(fixtureBytes('requests/req-004-errors.xlsx'));
    expect(issues.find((i) => i.code === 'HEAD_OF_UNIT_NONE')).toMatchObject({
      severity: 'warning',
      rowRef: 'Data!10',
    });
    expect(issues.find((i) => i.code === 'HEAD_OF_UNIT_MULTIPLE')).toMatchObject({
      severity: 'error',
      rowRef: 'Data!5',
    });
  });
});

describe('R-11 .. R-14 spot checks', () => {
  const issues = validate(fixtureBytes('requests/req-004-errors.xlsx'));
  it('R-11 passport without nationality', () => {
    expect(issues).toContainEqual(
      expect.objectContaining({
        rule: 'R-11',
        code: 'ID_WITHOUT_NATIONALITY',
        severity: 'error',
        field: 'nationality',
      }),
    );
  });
  it('R-12 counts code points against the limit', () => {
    const i = issues.find((x) => x.code === 'CHAR_LIMIT');
    expect(i?.message).toContain('129');
    expect(i?.message).toContain('128');
  });
  it('R-13 flags the later row only', () => {
    const dups = issues.filter((x) => x.code === 'DUPLICATE_ROW');
    expect(dups).toHaveLength(1);
    expect(dups[0]?.message).toContain('Data!16'); // refers back to P0
  });
  it('R-14 flags a leading honorific', () => {
    const i = issues.find((x) => x.code === 'NAME_HAS_HONORIFIC');
    expect(i).toMatchObject({ severity: 'warning', field: 'name1' });
  });
});

describe('R-15 database expectations', () => {
  const bytes = fixtureBytes('requests/req-001-basic.xlsx');
  const parsed = parseInvestc(bytes);
  const withPassport = parsed.people.findIndex((p) => p.passport !== '');
  const known = (over: Partial<KnownPerson>): KnownPerson => ({
    coreKey: 'someone else',
    dobIso: '1900-01-01',
    passports: ['ZZ999999'],
    nationalIds: ['ZN999999'],
    nonApproved: true,
    ...over,
  });
  it('no lookups, no R-15 issues', () => {
    expect(validateRequest(parsed, null, NOW).some((i) => i.rule === 'R-15')).toBe(false);
  });
  it('unseen units are info', () => {
    const lookups: RequestLookups = {
      isKnownUnit: (n) => n !== (parsed.units[0] as { name: string }).name,
      findKnownPerson: () => null,
    };
    const r = validateRequest(parsed, lookups, NOW).filter((i) => i.rule === 'R-15');
    expect(r).toEqual([expect.objectContaining({ code: 'UNEXPECTED_UNIT', severity: 'info', rowRef: 'Data!4' })]);
  });
  it('known-person mismatches and non-approved status are warnings', () => {
    expect(withPassport).toBeGreaterThanOrEqual(0);
    const target = (parsed.people[withPassport] as ObservedPerson).rowRef;
    const lookups: RequestLookups = {
      isKnownUnit: () => true,
      findKnownPerson: (q) => (q.rowRef === target ? known({}) : null),
    };
    const codes = validateRequest(parsed, lookups, NOW)
      .filter((i) => i.rule === 'R-15')
      .map((i) => [i.code, i.severity, i.rowRef]);
    expect(codes).toEqual(
      expect.arrayContaining([
        ['PERSON_KNOWN_NAME_MISMATCH', 'warning', target],
        ['PERSON_KNOWN_DOB_MISMATCH', 'warning', target],
        ['PERSON_KNOWN_ID_MISMATCH', 'warning', target],
        ['PERSON_NON_APPROVED', 'warning', target],
      ]),
    );
  });
  it('a matching known person raises nothing', () => {
    const lookups: RequestLookups = {
      isKnownUnit: () => true,
      findKnownPerson: (q) => ({
        coreKey: q.coreKey,
        dobIso: q.dobIso,
        passports: q.passport ? [q.passport] : [],
        nationalIds: q.nationalId ? [q.nationalId] : [],
        nonApproved: false,
      }),
    };
    expect(validateRequest(parsed, lookups, NOW)).toEqual([]);
  });
});

describe('robustness', () => {
  it('never throws on damaged parts', () => {
    const base = fixtureBytes('requests/req-001-basic.xlsx');
    for (const [part, fn] of [
      ['xl/worksheets/sheet2.xml', (x: string) => x.replace('</sheetData>', '')],
      ['xl/worksheets/sheet2.xml', (x: string) => x.slice(0, Math.floor(x.length / 2))],
      ['xl/sharedStrings.xml', (x: string) => x.slice(0, 200)],
      ['xl/workbook.xml', (x: string) => x.replace(/<sheets>[\s\S]*<\/sheets>/, '<sheets/>')],
      ['xl/_rels/workbook.xml.rels', (x: string) => x.replace(/Target="[^"]*"/g, 'Target="missing.xml"')],
    ] as const) {
      const bytes = mutatePart(base, part, fn);
      expect(() => validateRequest(parseInvestc(bytes), null, NOW)).not.toThrow();
    }
  });
  it('rules covered', () => {
    const covered = new Set<string>([
      'R-01',
      'R-02',
      'R-03',
      'R-04',
      'R-05',
      'R-06',
      'R-07',
      'R-08',
      'R-09',
      'R-10',
      'R-11',
      'R-12',
      'R-13',
      'R-14',
      'R-15',
    ]);
    expect(
      RULES.filter((r) => r.group === 'request')
        .map((r) => r.id)
        .sort(),
    ).toEqual([...covered].sort());
    expect(rules([])).toEqual(new Set());
  });
});
