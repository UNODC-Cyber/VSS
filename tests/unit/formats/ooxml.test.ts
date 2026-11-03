import { describe, expect, it } from 'vitest';
import {
  SharedStringsTable,
  WorkbookPatcher,
  addDays,
  ageOn,
  colToIndex,
  decodeUtf8,
  equalBytes,
  escapeXmlAttr,
  escapeXmlText,
  indexToCol,
  isoToSerial,
  loadSharedStrings,
  makeRef,
  openWorkbook,
  parseRef,
  readSheet,
  readZip,
  serialToIso,
  unescapeXml,
  writeZip,
} from '../../../src/main/formats/ooxml/index.ts';
import { generateBlankTemplate } from '../../../tools/fixtures/investc-workbook.ts';

const template = generateBlankTemplate();

describe('column math', () => {
  it('converts labels and indexes', () => {
    expect(colToIndex('A')).toBe(1);
    expect(colToIndex('Z')).toBe(26);
    expect(colToIndex('AA')).toBe(27);
    expect(colToIndex('XFD')).toBe(16384);
    expect(colToIndex('XFE')).toBe(0);
    expect(colToIndex('a1')).toBe(0);
    expect(indexToCol(1)).toBe('A');
    expect(indexToCol(52)).toBe('AZ');
    expect(indexToCol(703)).toBe('AAA');
    expect(() => indexToCol(0)).toThrow(RangeError);
  });
  it('parses and builds references', () => {
    expect(parseRef('S1145')).toEqual({ col: 19, row: 1145 });
    expect(parseRef('$B$2')).toEqual({ col: 2, row: 2 });
    expect(parseRef('B0')).toBeNull();
    expect(parseRef('1B')).toBeNull();
    expect(makeRef(28, 12)).toBe('AB12');
  });
});

describe('Excel serial dates (1900 system)', () => {
  it('handles the leap-year quirk', () => {
    expect(serialToIso(1)).toBe('1900-01-01');
    expect(serialToIso(59)).toBe('1900-02-28');
    expect(serialToIso(60)).toBeNull(); // the non-existent 1900-02-29
    expect(serialToIso(61)).toBe('1900-03-01');
    expect(isoToSerial('1900-02-28')).toBe(59);
    expect(isoToSerial('1900-03-01')).toBe(61);
    expect(isoToSerial('1900-02-29')).toBeNull();
  });
  it('knows anchor dates', () => {
    expect(serialToIso(25569)).toBe('1970-01-01');
    expect(serialToIso(36526)).toBe('2000-01-01');
    expect(serialToIso(2958465)).toBe('9999-12-31');
    expect(isoToSerial('2000-01-01')).toBe(36526);
  });
  it('ignores the time fraction and rejects out-of-range values', () => {
    expect(serialToIso(36526.75)).toBe('2000-01-01');
    expect(serialToIso(0)).toBeNull();
    expect(serialToIso(-5)).toBeNull();
    expect(serialToIso(2958466)).toBeNull();
    expect(serialToIso(Number.NaN)).toBeNull();
    expect(isoToSerial('1899-12-31')).toBeNull();
    expect(isoToSerial('2026-13-01')).toBeNull();
  });
  it('date helpers', () => {
    expect(addDays('2026-10-20', 365)).toBe('2027-10-20');
    expect(addDays('2024-02-28', 2)).toBe('2024-03-01');
    expect(ageOn('2008-11-03', '2026-11-03')).toBe(18);
    expect(ageOn('2008-11-04', '2026-11-03')).toBe(17);
  });
});

describe('xml helpers', () => {
  it('escapes and unescapes', () => {
    expect(escapeXmlText('a<b>&c\r')).toBe('a&lt;b&gt;&amp;c&#13;');
    expect(escapeXmlAttr(`"x" 'y' <&>\n`)).toBe('&quot;x&quot; &apos;y&apos; &lt;&amp;&gt;&#10;');
    expect(unescapeXml('&lt;&#65;&#x42;&amp;&unknown;')).toBe('<AB&&unknown;');
  });
  it('drops characters XML cannot carry', () => {
    expect(escapeXmlText('a\u0000b\u0008c\ud800d￾e')).toBe('abcde');
    expect(unescapeXml('&#0;&#8;')).toBe('&#0;&#8;');
  });
  it('strips a BOM when decoding', () => {
    expect(decodeUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toBe('A');
  });
});

describe('shared strings', () => {
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="5" uniqueCount="4">' +
    '<si><t>plain</t></si><si><r><t xml:space="preserve">rich </t></r><r><rPr><b/></rPr><t>text</t></r></si>' +
    '<si><t>a&amp;b_x000D_c</t><rPh sb="0" eb="1"><t>PHONETIC</t></rPh></si><si/></sst>';
  it('reads plain, rich, escaped and empty items', () => {
    const t = new SharedStringsTable(xml);
    expect(t.toArray()).toEqual(['plain', 'rich text', 'a&b\rc', '']);
  });
  it('serialises unchanged text byte for byte when nothing is added', () => {
    expect(new SharedStringsTable(xml).serialize()).toBe(xml);
  });
  it('appends without touching existing items and dedupes', () => {
    const t = new SharedStringsTable(xml);
    expect(t.add('plain')).toBe(0);
    const i = t.add('new <one> & _x0041_');
    expect(i).toBe(4);
    expect(t.add('new <one> & _x0041_')).toBe(4);
    const out = t.serialize();
    expect(out).toContain('count="6" uniqueCount="5"');
    expect(out).toContain('<si><t>plain</t></si>');
    const back = new SharedStringsTable(out);
    expect(back.get(4)).toBe('new <one> & _x0041_');
    expect(back.size).toBe(5);
  });
  it('builds from scratch', () => {
    const t = SharedStringsTable.empty();
    t.add('x');
    expect(new SharedStringsTable(t.serialize(1)).toArray()).toEqual(['x']);
  });
});

describe('cell reader', () => {
  const sst = ['zero', 'one'];
  const xml =
    '<worksheet><sheetData>' +
    '<row r="2"><c r="B2" t="s"><v>1</v></c><c r="C2" s="7"><v>42.5</v></c><c r="D2" t="b"><v>1</v></c><c r="E2" t="str"><v>f &amp; g</v></c>' +
    '<c r="F2" t="inlineStr"><is><t>inline</t><t> two</t></is></c><c r="G2" t="e"><v>#N/A</v></c><c r="H2" s="3"/><c r="I2" t="s"><v>99</v></c></row>' +
    '<row><c><v>7</v></c><c r="C3" t="b"><v>0</v></c></row></sheetData></worksheet>';
  const sheet = readSheet(xml, { get: (i) => sst[i] });
  it('decodes every cell type', () => {
    expect(sheet.cell(2, 2)).toMatchObject({ kind: 'string', text: 'one' });
    expect(sheet.cell(2, 3)).toMatchObject({ kind: 'number', num: 42.5, text: '42.5', style: 7 });
    expect(sheet.cell(2, 4)).toMatchObject({ kind: 'boolean', bool: true, text: 'TRUE' });
    expect(sheet.cell(2, 5)).toMatchObject({ kind: 'string', text: 'f & g' });
    expect(sheet.cell(2, 6)).toMatchObject({ kind: 'string', text: 'inline two' });
    expect(sheet.cell(2, 7)).toMatchObject({ kind: 'error', text: '#N/A' });
    expect(sheet.cell(2, 8)).toMatchObject({ kind: 'blank', style: 3 });
    expect(sheet.cell(2, 9)).toMatchObject({ kind: 'blank' }); // dangling shared index
  });
  it('infers missing references', () => {
    expect(sheet.cell(3, 1)).toMatchObject({ kind: 'number', num: 7 });
    expect(sheet.cell(3, 3)).toMatchObject({ kind: 'boolean', bool: false });
    expect(sheet.maxRow).toBe(3);
    expect(sheet.rowNumbers()).toEqual([2, 3]);
    expect(sheet.isRowEmpty(2, 10, 12)).toBe(true);
    expect(sheet.isRowEmpty(2)).toBe(false);
  });
  it('returns an empty sheet for no sheetData', () => {
    expect(readSheet('<worksheet/>', { get: () => undefined }).maxRow).toBe(0);
  });
});

describe('zip and patcher', () => {
  it('round-trips the blank template byte for byte', () => {
    const pkg = readZip(template);
    expect(equalBytes(writeZip(pkg), template)).toBe(true);
    expect(equalBytes(WorkbookPatcher.fromBytes(template).toBytes(), template)).toBe(true);
  });
  it('is deterministic', () => {
    const p = readZip(template);
    expect(equalBytes(writeZip(p), writeZip(p))).toBe(true);
  });
  it('keeps untouched parts byte-identical when one part is replaced', () => {
    const patcher = WorkbookPatcher.fromBytes(template);
    const before = readZip(template);
    patcher.replacePart('xl/worksheets/sheet2.xml', '<worksheet/>');
    const after = readZip(patcher.toBytes());
    expect(patcher.touched()).toEqual(['xl/worksheets/sheet2.xml']);
    for (const name of before.order) {
      if (name === 'xl/worksheets/sheet2.xml') continue;
      expect(equalBytes(after.parts.get(name) as Uint8Array, before.parts.get(name) as Uint8Array), name).toBe(true);
    }
    expect(after.order).toEqual(before.order);
    expect(patcher.untouched()).not.toContain('xl/worksheets/sheet2.xml');
  });
  it('adds and removes parts', () => {
    const p = WorkbookPatcher.fromBytes(template);
    p.addPart('xl/extra.xml', '<x/>');
    p.removePart('docProps/app.xml');
    expect(() => p.addPart('xl/extra.xml', '')).toThrow();
    expect(() => p.replacePart('nope', '')).toThrow();
    expect(() => p.removePart('nope')).toThrow();
    const back = readZip(p.toBytes());
    expect(back.parts.has('xl/extra.xml')).toBe(true);
    expect(back.parts.has('docProps/app.xml')).toBe(false);
  });
  it('rejects non-zip bytes without throwing from openWorkbook', () => {
    expect(openWorkbook(new Uint8Array([1, 2, 3, 4])).ok).toBe(false);
    expect(openWorkbook(new Uint8Array(0)).ok).toBe(false);
  });
  it('reads the template workbook structure', () => {
    const o = openWorkbook(template);
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    expect(o.info.sheets.map((s) => [s.name, s.state, s.path])).toEqual([
      ['Template Instructions', 'visible', 'xl/worksheets/sheet1.xml'],
      ['Data', 'visible', 'xl/worksheets/sheet2.xml'],
      ['Reference Data', 'hidden', 'xl/worksheets/sheet3.xml'],
    ]);
    expect(loadSharedStrings(o.pkg, o.info).size).toBeGreaterThan(200);
  });
});
