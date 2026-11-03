import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ObservedPerson, ObservedUnit } from '../../../src/shared/domain/types.ts';
import {
  exportInvestc as exportRaw,
  extractBlankTemplate,
  patchCoreXml,
  removeAbsPath,
  suggestExportFilename,
  TemplateMissingError,
  type ExportInput,
} from '../../../src/main/formats/investc/export.ts';
import { parseInvestc } from '../../../src/main/formats/investc/index.ts';
import { validatePackageStructure } from '../../../tools/ooxml-validate/structural.ts';
import { changedParts, partXml, semanticPeople } from './export-helpers.ts';
import { fixtureBytes, mutatePart, TEMPLATE } from './helpers.ts';

const SHEET = 'xl/worksheets/sheet2.xml';
const basic = () => {
  const source = fixtureBytes('requests/req-001-basic.xlsx');
  return { source, parsed: parseInvestc(source) };
};

/** Exports with the test-only generated template unless a test says otherwise (the app passes the vault one). */
const exportInvestc = (input: ExportInput) => exportRaw({ template: TEMPLATE(), ...input });

describe('no bundled template', () => {
  it('regenerate without a template fails with the actionable message', () => {
    const { parsed } = basic();
    const run = () => exportRaw({ mode: 'regenerate', units: parsed.units, people: parsed.people });
    expect(run).toThrow(TemplateMissingError);
    expect(run).toThrow(/Settings > Templates/);
  });
  it('filter-original that must fall back, without a template, fails and says why', () => {
    const source = fixtureBytes('requests/req-008-unknown-version.xlsx');
    const parsed = parseInvestc(source);
    const run = () => exportRaw({ mode: 'filter-original', source, units: parsed.units, people: parsed.people });
    expect(run).toThrow(TemplateMissingError);
    expect(run).toThrow(/could not be filtered \(template version 9\.9\.9 is not a known version\)/);
  });
  it('filter-original of a clean source needs no template at all', () => {
    const { source, parsed } = basic();
    const out = exportRaw({ mode: 'filter-original', source, units: parsed.units, people: parsed.people });
    expect(out.modeUsed).toBe('filter-original');
    expect(out.issues).toEqual([]);
  });
  it('the source tree holds no template module or template workbook', () => {
    const dir = new URL('../../../src/main/formats/investc/', import.meta.url);
    expect(readdirSync(dir).filter((f) => /template/i.test(f))).toEqual([]);
  });
});

describe('suggestExportFilename', () => {
  const d = new Date(2026, 10, 3, 9, 30);
  it('slugs the event name and appends the local date', () => {
    expect(suggestExportFilename('Regional Workshop: Digital Evidence (Bangkok)', d)).toBe(
      'INVESTc_Regional-Workshop-Digital-Evidence-Bangkok_2026-11-03.xlsx',
    );
  });
  it('keeps non-Latin letters, strips path characters and falls back for empty names', () => {
    expect(suggestExportFilename('การอบรม/ทดสอบ', d)).toBe('INVESTc_การอบรม-ทดสอบ_2026-11-03.xlsx');
    expect(suggestExportFilename('  ../\\:*?  ', d)).toBe('INVESTc_request_2026-11-03.xlsx');
    expect(suggestExportFilename('', new Date(2027, 0, 9))).toBe('INVESTc_request_2027-01-09.xlsx');
  });
  it('caps the slug length', () => {
    const name = suggestExportFilename('x'.repeat(200), d);
    expect(name).toBe(`INVESTc_${'x'.repeat(60)}_2026-11-03.xlsx`);
  });
});

describe('X-04 row map, merges, dimension', () => {
  it('re-anchors merges and the dimension for 2 units and 6 people', () => {
    const { parsed } = basic();
    const out = exportInvestc({ mode: 'regenerate', units: parsed.units, people: parsed.people });
    const xml = partXml(out.bytes, SHEET);
    // units 4..5, sep 6, ind 7, sub 8, hdr 9, people 10..15
    const merges = [...xml.matchAll(/<mergeCell ref="([^"]+)"/g)].map((m) => m[1]);
    expect(merges).toEqual(['A1:M1', 'A2:M2', 'B6:C6', 'A7:S7', 'A8:B8', 'C8:G8', 'H8:I8', 'J8:L8', 'M8:Q8']);
    expect(xml).toContain('<mergeCells count="9">');
    expect(xml).toContain('<dimension ref="A1:S15"/>');
    const again = parseInvestc(out.bytes);
    expect(again.layout).toEqual({
      firstUnitRow: 4,
      separatorRow: 6,
      individualsRow: 7,
      individualsHeaderRow: 9,
      firstPersonRow: 10,
      lastPersonRow: 15,
    });
  });

  it('subset selection writes only referenced units, in the supplied order', () => {
    const { parsed } = basic();
    const second = parsed.units[1] as ObservedUnit;
    const people = parsed.people.filter((p) => p.unitName === second.name);
    expect(people.length).toBeGreaterThan(0);
    const out = exportInvestc({ mode: 'filter-original', source: basic().source, units: parsed.units, people });
    expect(out.stats).toEqual({ units: 1, people: people.length });
    const again = parseInvestc(out.bytes);
    expect(again.units.map((u) => u.name)).toEqual([second.name]);
    expect(semanticPeople(again.people)).toEqual(semanticPeople(people));
    expect(partXml(out.bytes, SHEET)).toContain(`<dimension ref="A1:S${8 + people.length}"/>`);
  });

  it('an empty selection still writes a parseable workbook with one blank unit and person row', () => {
    const out = exportInvestc({ mode: 'regenerate', units: [], people: [] });
    const again = parseInvestc(out.bytes);
    expect(again.issues).toEqual([]);
    expect(again.units).toEqual([]);
    expect(again.people).toEqual([]);
    expect(out.stats).toEqual({ units: 0, people: 0 });
    expect(validatePackageStructure(out.bytes)).toEqual([]);
  });
});

describe('X-05 data validations', () => {
  const uids = (xml: string) => [...xml.matchAll(/xr:uid="(\{[0-9A-F-]+\})"/g)].map((m) => m[1]).slice(1); // skip the worksheet uid

  it('rewrites standard and x14 ranges with correct counts and the template uids', () => {
    const { parsed } = basic();
    const out = exportInvestc({ mode: 'regenerate', units: parsed.units, people: parsed.people });
    const xml = partXml(out.bytes, SHEET);
    expect(xml).toContain('<dataValidations count="2">');
    expect(xml).toContain('<x14:dataValidations count="5"');
    const sq = [...xml.matchAll(/sqref="([^"]+)"/g)].map((m) => m[1]).filter((s) => s !== 'A4');
    expect(sq).toEqual(['M10:M1048576', 'A10:A1048576']);
    const x14 = [...xml.matchAll(/<xm:sqref>([^<]+)<\/xm:sqref>/g)].map((m) => m[1]);
    expect(x14).toEqual(['B10:B1048576', 'C4:C5', 'S10:S1048576', 'P10:Q1048576', 'M4:M5 R10:R1048576']);
    expect(uids(xml)).toEqual(uids(partXml(TEMPLATE(), SHEET)));
    expect(xml).toContain('OFFSET($A$4,0,0,MATCH("INDIVIDUALS",$A:$A,0)-5,1)');
  });

  it('follows a large unit block', () => {
    const source = fixtureBytes('requests/req-006-large.xlsx');
    const parsed = parseInvestc(source);
    const out = exportInvestc({ mode: 'filter-original', source, units: parsed.units, people: parsed.people });
    const xml = partXml(out.bytes, SHEET);
    // 50 units: 4..53, sep 54, hdr 57, people 58..1257
    expect(xml).toContain('<xm:sqref>C4:C53</xm:sqref>');
    expect(xml).toContain('<xm:sqref>M4:M53 R58:R1048576</xm:sqref>');
    expect(xml).toContain('sqref="M58:M1048576"');
    expect(xml).toContain('<dimension ref="A1:S1257"/>');
  });
});

function person(over: Partial<ObservedPerson>): ObservedPerson {
  const base = basic().parsed.people[0] as ObservedPerson;
  return { ...base, ...over };
}

describe('X-06 cell encoding', () => {
  it('writes IsHeadOfUnit as a boolean and DOB as a serial in the template date style', () => {
    const { parsed } = basic();
    const out = exportInvestc({ mode: 'regenerate', units: parsed.units, people: parsed.people });
    const xml = partXml(out.bytes, SHEET);
    expect(xml).toMatch(/<c r="B10"[^>]* t="b"><v>1<\/v><\/c>/);
    expect(xml).toMatch(/<c r="M10" s="4"><v>35410<\/v><\/c>/);
  });

  it('normalises lists, strips control characters and composes to NFC', () => {
    const { parsed } = basic();
    const p = person({
      surname: 'Ze\u0301ro\u0007\u0000',
      pobCountry: ' thailand ',
      nationality: 'Thailand',
      searchCountry: 'thailand',
      sex: 'f',
      dob: { kind: 'text', value: '03/25/1985', parsed: '1985-03-25', ambiguousDayMonth: false },
    });
    const units = parsed.units.map((u) => ({ ...u, type: u.type.toLowerCase(), country: u.country.toLowerCase() }));
    const out = exportInvestc({ mode: 'regenerate', units, people: [p] });
    expect(out.issues).toEqual([]);
    const again = parseInvestc(out.bytes);
    expect(again.people[0]).toMatchObject({
      surname: 'Z\u00e9ro',
      pobCountry: 'THAILAND',
      nationality: 'THAILAND',
      searchCountry: 'THAILAND',
      sex: 'F',
      dob: { kind: 'serial', parsed: '1985-03-25' },
    });
    expect(again.units[0]?.type).toBe(parsed.units[0]?.type);
    expect(again.units[0]?.country).toBe(parsed.units[0]?.country);
  });

  it('escapes XML specials and Excel _xHHHH_ look-alikes', () => {
    const p = person({ fatherName: 'A & B <c> "d" _x0041_' });
    const { parsed } = basic();
    const out = exportInvestc({ mode: 'regenerate', units: parsed.units, people: [p] });
    expect(parseInvestc(out.bytes).people[0]?.fatherName).toBe('A & B <c> "d" _x0041_');
    expect(validatePackageStructure(out.bytes)).toEqual([]);
  });

  it('omits empty optional cells and keeps an unparseable DOB as text with a warning', () => {
    const { parsed } = basic();
    const p = person({
      titleRank: '',
      name2: '   ',
      dob: { kind: 'text', value: '31/31/1990', parsed: null, ambiguousDayMonth: false },
    });
    const out = exportInvestc({ mode: 'regenerate', units: parsed.units, people: [p] });
    expect(out.issues.map((i) => i.code)).toEqual(['DOB_INVALID']);
    const xml = partXml(out.bytes, SHEET);
    expect(xml).not.toMatch(/<c r="J10"[^/]*t="s"/);
    expect(xml).not.toMatch(/<c r="F10"/);
    expect(parseInvestc(out.bytes).people[0]?.dob).toMatchObject({ kind: 'text', value: '31/31/1990' });
  });
});

describe('X-03 filter-original', () => {
  const ABS =
    '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="x15"><x15ac:absPath url="C:\\Example\\Folder\\" xmlns:x15ac="http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac"/></mc:Choice></mc:AlternateContent>';

  it('removes x15ac:absPath and leaves every other part alone', () => {
    const { source, parsed } = basic();
    const withAbs = mutatePart(source, 'xl/workbook.xml', (x) => x.replace('<workbookPr', `${ABS}<workbookPr`));
    const out = exportInvestc({ mode: 'filter-original', source: withAbs, units: parsed.units, people: parsed.people });
    const wb = partXml(out.bytes, 'xl/workbook.xml');
    expect(wb).not.toContain('absPath');
    expect(wb).toBe(partXml(source, 'xl/workbook.xml'));
    // Full selection of a generated fixture: the Data sheet and the shared strings come out byte-identical too.
    expect(changedParts(withAbs, out.bytes)).toEqual(['xl/workbook.xml']);
    expect(changedParts(source, out.bytes)).toEqual([]);
    expect(validatePackageStructure(out.bytes)).toEqual([]);
  });

  it('sets creator and lastModifiedBy to VSS, and the modified time when now is given', () => {
    const { source, parsed } = basic();
    const foreign = mutatePart(source, 'docProps/core.xml', (x) =>
      x.replace(
        '<dc:creator>VSS</dc:creator><cp:lastModifiedBy>VSS</cp:lastModifiedBy>',
        '<dc:creator>Somebody</dc:creator><cp:lastModifiedBy/>',
      ),
    );
    const now = new Date('2026-11-04T05:06:07.890Z');
    const out = exportInvestc({
      mode: 'filter-original',
      source: foreign,
      units: parsed.units,
      people: parsed.people,
      now,
    });
    const core = partXml(out.bytes, 'docProps/core.xml');
    expect(core).toContain('<dc:creator>VSS</dc:creator>');
    expect(core).toContain('<cp:lastModifiedBy>VSS</cp:lastModifiedBy>');
    expect(core).toContain('>2026-11-04T05:06:07Z</dcterms:modified>');
    expect(core).not.toContain('Somebody');
  });

  it('does not carry the text of rows that were filtered out', () => {
    const { source, parsed } = basic();
    const keep = parsed.people.slice(0, 1);
    const dropped = parsed.people.slice(1).map((p) => p.surname);
    const out = exportInvestc({ mode: 'filter-original', source, units: parsed.units, people: keep });
    const sst = partXml(out.bytes, 'xl/sharedStrings.xml');
    for (const s of dropped) expect(sst).not.toContain(`>${s}<`);
    expect(sst).toContain(`>${keep[0]?.surname}<`);
    expect(partXml(source, 'xl/sharedStrings.xml')).toContain(`>${dropped[0]}<`);
    expect(validatePackageStructure(out.bytes)).toEqual([]);
    // structural strings (sheet 1 and 3, Data headers) still resolve
    const again = parseInvestc(out.bytes);
    expect(again.issues).toEqual([]);
    expect(again.reference.source.lists).toBe('file');
  });

  it('falls back to regenerate (info issue) for an unknown template version', () => {
    const source = fixtureBytes('requests/req-008-unknown-version.xlsx');
    const parsed = parseInvestc(source);
    const out = exportInvestc({ mode: 'filter-original', source, units: parsed.units, people: parsed.people });
    expect(out.issues).toMatchObject([{ code: 'TEMPLATE_VERSION_UNKNOWN', severity: 'info' }]);
    const regen = exportInvestc({ mode: 'regenerate', units: parsed.units, people: parsed.people });
    expect(Buffer.from(out.bytes).equals(Buffer.from(regen.bytes))).toBe(true);
    expect(parseInvestc(out.bytes).templateVersion).toBe('1.11.0');
  });

  it('falls back without a source, for a non-xlsx source and for sheet features it cannot re-anchor', () => {
    const { source, parsed } = basic();
    const cf = mutatePart(source, SHEET, (x) =>
      x.replace(
        '<dataValidations',
        '<conditionalFormatting sqref="A10:A15"><cfRule type="expression" priority="1"><formula>TRUE</formula></cfRule></conditionalFormatting><dataValidations',
      ),
    );
    const formula = mutatePart(source, SHEET, (x) =>
      x.replace('<c r="A4" s="3" t="s">', '<c r="A4" s="3" t="str"><f>"x"</f>'),
    );
    for (const src of [undefined, new Uint8Array([1, 2, 3]), cf, formula]) {
      const out = exportInvestc({ mode: 'filter-original', source: src, units: parsed.units, people: parsed.people });
      expect(out.issues).toMatchObject([{ code: 'TEMPLATE_VERSION_UNKNOWN', severity: 'info' }]);
      expect(changedParts(TEMPLATE(), out.bytes)).toEqual(['xl/sharedStrings.xml', SHEET]);
    }
  });

  it('drops ignoredErrors (row-bound, cosmetic) but keeps the export in filter-original mode', () => {
    const { source, parsed } = basic();
    const ie = mutatePart(source, SHEET, (x) =>
      x.replace(
        '<extLst>',
        '<ignoredErrors><ignoredError sqref="H10:H15" numberStoredAsText="1"/></ignoredErrors><extLst>',
      ),
    );
    const out = exportInvestc({ mode: 'filter-original', source: ie, units: parsed.units, people: parsed.people });
    expect(out.issues).toEqual([]);
    expect(partXml(out.bytes, SHEET)).not.toContain('ignoredErrors');
  });
});

describe('regenerate', () => {
  it('the same template gives identical bytes', () => {
    const { parsed } = basic();
    const a = exportInvestc({ mode: 'regenerate', units: parsed.units, people: parsed.people });
    const b = exportRaw({ mode: 'regenerate', template: TEMPLATE(), units: parsed.units, people: parsed.people });
    expect(a.modeUsed).toBe('regenerate');
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });
  it('throws for an unusable template', () => {
    expect(() => exportInvestc({ mode: 'regenerate', template: new Uint8Array([0]), units: [], people: [] })).toThrow(
      /template unusable/,
    );
  });
  it('appends new strings after the template strings and keeps count/uniqueCount right', () => {
    const { parsed } = basic();
    const out = exportInvestc({ mode: 'regenerate', units: parsed.units, people: parsed.people });
    const before = partXml(TEMPLATE(), 'xl/sharedStrings.xml');
    const after = partXml(out.bytes, 'xl/sharedStrings.xml');
    const body = (x: string) => x.slice(x.indexOf('<si>'), x.lastIndexOf('</sst>'));
    expect(body(after).startsWith(body(before))).toBe(true);
    expect(validatePackageStructure(out.bytes)).toEqual([]);
  });
});

describe('helpers', () => {
  it('removeAbsPath leaves a workbook without absPath unchanged', () => {
    const wb = partXml(TEMPLATE(), 'xl/workbook.xml');
    expect(removeAbsPath(wb)).toBe(wb);
  });
  it('patchCoreXml inserts missing creator fields', () => {
    const xml =
      '<?xml version="1.0"?><cp:coreProperties xmlns:cp="x" xmlns:dc="y" xmlns:dcterms="z" xmlns:xsi="w"></cp:coreProperties>';
    const out = patchCoreXml(xml, undefined);
    expect(out).toContain('<dc:creator>VSS</dc:creator><cp:lastModifiedBy>VSS</cp:lastModifiedBy></cp:coreProperties>');
  });
});

describe('extractBlankTemplate (vault template capture)', () => {
  it('removes every row, keeps the structure and the version, and works as a regenerate template', () => {
    const { source, parsed } = basic();
    const t = extractBlankTemplate(source, new Date('2026-11-05T00:00:00Z'));
    expect(t.templateVersion).toBe('1.11.0');
    expect(t.instructionsVersion).toBe('2.6.0');
    const blank = parseInvestc(t.bytes);
    expect(blank.issues).toEqual([]);
    expect(blank.units).toEqual([]);
    expect(blank.people).toEqual([]);
    const sst = partXml(t.bytes, 'xl/sharedStrings.xml');
    for (const p of parsed.people) expect(sst).not.toContain(`>${p.surname}<`);
    for (const u of parsed.units) expect(sst).not.toContain(`>${u.name}<`);
    expect(sst).not.toContain('<si><t/></si>');
    expect(partXml(t.bytes, 'docProps/core.xml')).toContain('<dc:creator>VSS</dc:creator>');
    expect(validatePackageStructure(t.bytes)).toEqual([]);
    const out = exportRaw({ mode: 'regenerate', template: t.bytes, units: parsed.units, people: parsed.people });
    expect(semanticPeople(parseInvestc(out.bytes).people)).toEqual(semanticPeople(parsed.people));
  });
  it('is idempotent and equal for a blank and a filled workbook of the same layout', () => {
    const now = new Date('2026-11-05T00:00:00Z');
    const a = extractBlankTemplate(basic().source, now).bytes;
    const b = extractBlankTemplate(a, now).bytes;
    const c = extractBlankTemplate(TEMPLATE(), now).bytes;
    expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
    expect(changedParts(a, c)).toEqual([]);
  });
  it('refuses unknown versions and non-workbooks with a reason', () => {
    expect(() => extractBlankTemplate(fixtureBytes('requests/req-008-unknown-version.xlsx'))).toThrow(
      /cannot be used as a template: template version 9\.9\.9/,
    );
    expect(() => extractBlankTemplate(new Uint8Array([1, 2]))).toThrow(/cannot be used as a template/);
  });
});
