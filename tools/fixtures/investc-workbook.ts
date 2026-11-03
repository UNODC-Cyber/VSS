/**
 * From-scratch writer of INVESTc-shaped request workbooks, for TESTS ONLY.
 *
 * VSS never ships a request template: the app works from the counterpart's own file or from a template the user keeps
 * in the vault. Tests still need workbooks with the exact cell layout the parser and exporter read
 * (docs/FILE-FORMATS.md), so this module writes one from nothing: our own styles, our own short instruction text, our
 * own validation ids and the hand-written reference lists of bundled-reference.ts. Only the format identifiers the
 * parser matches on (sheet names, markers, header captions, the version cells A2/C2 and the limit-table labels) are
 * fixed by the format.
 *
 *   generateBlankTemplate()          blank workbook: one empty unit row, one empty individual row
 *   buildInvestcWorkbook(spec)       the same workbook with rows filled in (used for every request fixture)
 *   GENERATED_PARTS                  the complete list of parts this writer can produce (the CI guard's allowlist)
 */
import {
  BUNDLED_COUNTRIES_POB,
  BUNDLED_COUNTRIES_UNIT,
  BUNDLED_GENDERS,
  BUNDLED_ID_TYPES,
  BUNDLED_UNIT_TYPES,
} from '../../src/main/formats/investc/bundled-reference.ts';
import {
  DEFAULT_LIMITS,
  LIMIT_LABELS,
  MARKER_INDIVIDUALS,
  MARKER_SEPARATOR,
  MARKER_UNITS,
  PERSON_HEADERS,
  UNIT_HEADERS,
} from '../../src/main/formats/investc/layout.ts';
import { canonicalAppXml, canonicalCoreXml } from '../../src/main/formats/investc/sanitize.ts';
import { indexToCol } from '../../src/main/formats/ooxml/columns.ts';
import { packageFromParts } from '../../src/main/formats/ooxml/patcher.ts';
import { SharedStringsTable } from '../../src/main/formats/ooxml/sharedStrings.ts';
import { escapeXmlText } from '../../src/main/formats/ooxml/xml.ts';
import { writeZip } from '../../src/main/formats/ooxml/zip.ts';

export type CellValue = { t: 's'; v: string } | { t: 'n'; v: number } | { t: 'b'; v: boolean };
/** Cells of one row by column letter. */
export type RowCells = Partial<Record<string, CellValue>>;

export interface InvestcWorkbookSpec {
  /** Unit block rows in file order; null is a blank (styled) row inside the block. At least one row is written. */
  unitRows: (RowCells | null)[];
  /** Individual rows in file order; null is a blank row. With none, one blank row is written. */
  people: (RowCells | null)[];
  /** Overrides of the version cells (the default ones are the known current versions). */
  versionCells?: { a2?: string; c2?: string };
}

export interface BuiltInvestcWorkbook {
  bytes: Uint8Array;
  /** Strings written into the workbook beyond the blank template's own structural strings. */
  strings: Set<string>;
}

export const VERSION_A2_TEXT = 'Version 2.6.0';
export const VERSION_C2_TEXT = 'INVESTc Template Version 1.11.0';
const FIXED_TIME = '2026-11-03T00:00:00Z';

const NS = {
  main: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  x14ac: 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac',
  xr: 'http://schemas.microsoft.com/office/spreadsheetml/2014/revision',
  x14: 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main',
  xm: 'http://schemas.microsoft.com/office/excel/2006/main',
};
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Our own deterministic ids (any GUID-shaped value works; these just never change). */
const UID = {
  sheet1: '{0A5C0001-0000-4000-8000-000000000001}',
  sheet2: '{0A5C0001-0000-4000-8000-000000000002}',
  sheet3: '{0A5C0001-0000-4000-8000-000000000003}',
  dob: '{0A5C0002-0000-4000-8000-000000000001}',
  unitList: '{0A5C0002-0000-4000-8000-000000000002}',
  bool: '{0A5C0002-0000-4000-8000-000000000003}',
  unitType: '{0A5C0002-0000-4000-8000-000000000004}',
  sex: '{0A5C0002-0000-4000-8000-000000000005}',
  countryPob: '{0A5C0002-0000-4000-8000-000000000006}',
  countryUnit: '{0A5C0002-0000-4000-8000-000000000007}',
};

/** Style indices of styles.xml below. */
const S = { title: 1, header: 2, cell: 3, date: 4, marker: 5, prose: 6, group: 7 } as const;

const STYLES =
  XML_HEAD +
  `<styleSheet xmlns="${NS.main}">` +
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="mm/dd/yyyy"/></numFmts>' +
  '<fonts count="3">' +
  '<font><sz val="11"/><name val="Arial"/><family val="2"/></font>' +
  '<font><b/><sz val="11"/><name val="Arial"/><family val="2"/></font>' +
  '<font><b/><sz val="13"/><name val="Arial"/><family val="2"/></font>' +
  '</fonts>' +
  '<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFE4ECF4"/><bgColor indexed="64"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill>' +
  '</fills>' +
  '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
  '<border><left style="thin"><color rgb="FF9AA5B1"/></left><right style="thin"><color rgb="FF9AA5B1"/></right>' +
  '<top style="thin"><color rgb="FF9AA5B1"/></top><bottom style="thin"><color rgb="FF9AA5B1"/></bottom><diagonal/></border>' +
  '</borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="8">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

const CONTENT_TYPES =
  XML_HEAD +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  [1, 2, 3]
    .map(
      (n) =>
        `<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join('') +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
  '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
  '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
  '</Types>';

const ROOT_RELS =
  XML_HEAD +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
  '</Relationships>';

const WORKBOOK_RELS =
  XML_HEAD +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  [1, 2, 3]
    .map(
      (n) =>
        `<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/>`,
    )
    .join('') +
  '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' +
  '</Relationships>';

const WORKBOOK =
  XML_HEAD +
  `<workbook xmlns="${NS.main}" xmlns:r="${NS.r}">` +
  '<workbookPr/>' +
  '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000" activeTab="1"/></bookViews>' +
  '<sheets>' +
  '<sheet name="Template Instructions" sheetId="1" r:id="rId1"/>' +
  '<sheet name="Data" sheetId="2" r:id="rId2"/>' +
  '<sheet name="Reference Data" sheetId="3" state="hidden" r:id="rId3"/>' +
  '</sheets>' +
  '<calcPr calcId="191029"/>' +
  '</workbook>';

/** Every part this writer produces. The CI guard rejects any committed workbook with a part outside this list. */
export const GENERATED_PARTS: readonly string[] = [
  '[Content_Types].xml',
  '_rels/.rels',
  'docProps/app.xml',
  'docProps/core.xml',
  'xl/_rels/workbook.xml.rels',
  'xl/sharedStrings.xml',
  'xl/styles.xml',
  'xl/workbook.xml',
  'xl/worksheets/sheet1.xml',
  'xl/worksheets/sheet2.xml',
  'xl/worksheets/sheet3.xml',
];

// ---- cell writing ------------------------------------------------------------------------------------------------

type Str = (s: string) => number;

function cell(ref: string, style: number | undefined, v: CellValue | undefined, str: Str): string {
  const s = style !== undefined ? ` s="${style}"` : '';
  if (!v) return style !== undefined ? `<c r="${ref}"${s}/>` : '';
  if (v.t === 's') return `<c r="${ref}"${s} t="s"><v>${str(v.v)}</v></c>`;
  if (v.t === 'b') return `<c r="${ref}"${s} t="b"><v>${v.v ? 1 : 0}</v></c>`;
  return `<c r="${ref}"${s}><v>${v.v}</v></c>`;
}

const colNo = (letter: string): number => [...letter].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

/** One row; `styles` gives the style of every column that is always written (even when empty). */
function row(
  r: number,
  cells: RowCells | null,
  styles: Readonly<Record<string, number>>,
  str: Str,
  attrs = '',
): string {
  const cols = new Set([...Object.keys(styles), ...Object.keys(cells ?? {})]);
  const body = [...cols]
    .sort((a, b) => colNo(a) - colNo(b))
    .map((c) => cell(`${c}${r}`, styles[c], cells?.[c], str))
    .join('');
  return `<row r="${r}"${attrs}>${body}</row>`;
}

const textRow = (texts: readonly string[]): RowCells =>
  Object.fromEntries(texts.map((t, i) => [indexToCol(i + 1), { t: 's', v: t } as CellValue]).filter(([, v]) => v));

const allCols = (n: number, style: number): Record<string, number> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [indexToCol(i + 1), style]));

const UNIT_STYLES = allCols(13, S.cell);
const PERSON_STYLES = { ...allCols(19, S.cell), M: S.date };
const DATA_ROW = ' spans="1:19" x14ac:dyDescent="0.25"';

function worksheetOpen(uid: string, dimension: string, selected: boolean, cols: string): string {
  return (
    XML_HEAD +
    `<worksheet xmlns="${NS.main}" xmlns:r="${NS.r}" xmlns:mc="${NS.mc}" mc:Ignorable="x14ac xr" xmlns:x14ac="${NS.x14ac}" xmlns:xr="${NS.xr}" xr:uid="${uid}">` +
    `<dimension ref="${dimension}"/>` +
    `<sheetViews><sheetView${selected ? ' tabSelected="1"' : ''} workbookViewId="0"><selection activeCell="A4" sqref="A4"/></sheetView></sheetViews>` +
    '<sheetFormatPr defaultRowHeight="15" x14ac:dyDescent="0.25"/>' +
    cols
  );
}

const MARGINS = '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>';

// ---- sheet 1: instructions (our own short text) ------------------------------------------------------------------

const INSTRUCTION_LINES = [
  'Synthetic request workbook written by the VSS test-fixture generator.',
  'It reproduces only the cell layout VSS reads; it is not an official form and holds no real data.',
  'Units go in the upper block of the Data sheet, people in the lower block; each person names one listed unit.',
];

function limitRows(): [string, number][] {
  return Object.entries(LIMIT_LABELS).map(([label, m]) => [
    label,
    (DEFAULT_LIMITS[m.scope] as Readonly<Record<string, number>>)[m.field] as number,
  ]);
}

function instructionsSheet(str: Str, version: { a2: string; c2: string }): string {
  const rows: string[] = [];
  rows.push(row(1, { A: { t: 's', v: 'Request workbook' } }, { A: S.title }, str));
  rows.push(row(2, { A: { t: 's', v: version.a2 }, C: { t: 's', v: version.c2 } }, {}, str));
  INSTRUCTION_LINES.forEach((l, i) => rows.push(row(4 + i, { A: { t: 's', v: l } }, { A: S.prose }, str)));
  const top = 4 + INSTRUCTION_LINES.length + 1;
  rows.push(row(top, { B: { t: 's', v: 'Field' }, C: { t: 's', v: 'Max length' } }, { B: S.header, C: S.header }, str));
  const limits = limitRows();
  limits.forEach(([label, n], i) =>
    rows.push(row(top + 1 + i, { B: { t: 's', v: label }, C: { t: 'n', v: n } }, { B: S.cell, C: S.cell }, str)),
  );
  const last = top + limits.length;
  return (
    worksheetOpen(
      UID.sheet1,
      `A1:C${last}`,
      false,
      '<cols><col min="1" max="1" width="60" customWidth="1"/><col min="2" max="2" width="34" customWidth="1"/><col min="3" max="3" width="34" customWidth="1"/></cols>',
    ) +
    `<sheetData>${rows.join('')}</sheetData>` +
    MARGINS +
    '</worksheet>'
  );
}

// ---- sheet 3: reference lists ------------------------------------------------------------------------------------

interface RefRanges {
  unitType: string;
  sex: string;
  bool: string;
  countryPob: string;
  countryUnit: string;
}

function referenceRanges(): RefRanges {
  const r = (col: string, n: number) => `'Reference Data'!$${col}$2:$${col}$${1 + n}`;
  return {
    unitType: r('A', BUNDLED_UNIT_TYPES.length),
    sex: r('B', BUNDLED_GENDERS.length),
    bool: r('C', 2),
    countryPob: r('E', BUNDLED_COUNTRIES_POB.length),
    countryUnit: r('G', BUNDLED_COUNTRIES_UNIT.length),
  };
}

function referenceSheet(str: Str): string {
  const lists: [string, readonly CellValue[]][] = [
    ['A', BUNDLED_UNIT_TYPES.map((v) => ({ t: 's', v }) as CellValue)],
    ['B', BUNDLED_GENDERS.map((v) => ({ t: 's', v }) as CellValue)],
    [
      'C',
      [
        { t: 'b', v: true },
        { t: 'b', v: false },
      ],
    ],
    ['D', BUNDLED_ID_TYPES.map((v) => ({ t: 's', v }) as CellValue)],
    ['E', BUNDLED_COUNTRIES_POB.map((v) => ({ t: 's', v }) as CellValue)],
    ['G', BUNDLED_COUNTRIES_UNIT.map((v) => ({ t: 's', v }) as CellValue)],
  ];
  const head: RowCells = {
    A: { t: 's', v: 'Unit Type' },
    B: { t: 's', v: 'Gender' },
    C: { t: 's', v: 'True/False' },
    D: { t: 's', v: 'ID Type' },
    E: { t: 's', v: 'Country' },
    G: { t: 's', v: 'UnitCountry' },
  };
  const max = Math.max(...lists.map(([, l]) => l.length));
  const rows: string[] = [row(1, head, {}, str)];
  for (let i = 0; i < max; i++) {
    const cells: RowCells = {};
    for (const [col, l] of lists) if (l[i]) cells[col] = l[i];
    rows.push(row(2 + i, cells, {}, str));
  }
  return (
    worksheetOpen(UID.sheet3, `A1:G${1 + max}`, false, '') +
    `<sheetData>${rows.join('')}</sheetData>` +
    MARGINS +
    '</worksheet>'
  );
}

// ---- sheet 2: Data -----------------------------------------------------------------------------------------------

export interface DataLayout {
  firstUnit: number;
  lastUnit: number;
  sep: number;
  ind: number;
  sub: number;
  hdr: number;
  firstPerson: number;
  lastRow: number;
}

/** Row map (docs/FILE-FORMATS.md X-04) for a sheet with `unitRows` unit rows and `people` individual rows. */
export function dataLayout(unitRows: number, people: number): DataLayout {
  const units = Math.max(unitRows, 1);
  const sep = 4 + units;
  const hdr = sep + 3;
  return {
    firstUnit: 4,
    lastUnit: 3 + units,
    sep,
    ind: sep + 1,
    sub: sep + 2,
    hdr,
    firstPerson: hdr + 1,
    lastRow: hdr + Math.max(people, 1),
  };
}

export function dataMerges(l: DataLayout): string[] {
  return [
    'A1:M1',
    'A2:M2',
    `B${l.sep}:C${l.sep}`,
    `A${l.ind}:S${l.ind}`,
    `A${l.sub}:B${l.sub}`,
    `C${l.sub}:G${l.sub}`,
    `H${l.sub}:I${l.sub}`,
    `J${l.sub}:L${l.sub}`,
    `M${l.sub}:Q${l.sub}`,
  ];
}

/** Our captions for the individual sub-header groups (not read by the parser). */
const GROUPS: RowCells = {
  A: { t: 's', v: 'Unit' },
  C: { t: 's', v: 'Name' },
  H: { t: 's', v: 'Identity documents' },
  J: { t: 's', v: 'Other details' },
  M: { t: 's', v: 'Birth and nationality' },
  R: { t: 's', v: 'Search' },
  S: { t: 's', v: 'Sex' },
};

/** The unit-name drop-down for individuals: the unit block from row 4 down to the row above the separator. */
export const UNIT_LIST_FORMULA = 'OFFSET($A$4,0,0,MATCH("INDIVIDUALS",$A:$A,0)-5,1)';
export const ADULT_DOB_FORMULA = 'DATE(YEAR(TODAY())-18,MONTH(TODAY()),DAY(TODAY()))';

function dataTail(l: DataLayout): string {
  const p0 = l.firstPerson;
  const merges = dataMerges(l);
  const ref = referenceRanges();
  const std =
    '<dataValidations count="2">' +
    `<dataValidation type="date" operator="lessThan" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="M${p0}:M1048576" xr:uid="${UID.dob}"><formula1>${ADULT_DOB_FORMULA}</formula1></dataValidation>` +
    `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="A${p0}:A1048576" xr:uid="${UID.unitList}"><formula1>${escapeXmlText(UNIT_LIST_FORMULA)}</formula1></dataValidation>` +
    '</dataValidations>';
  const x14 = (uid: string, f: string, sqref: string): string =>
    `<x14:dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" xr:uid="${uid}"><x14:formula1><xm:f>${escapeXmlText(f)}</xm:f></x14:formula1><xm:sqref>${sqref}</xm:sqref></x14:dataValidation>`;
  const ext =
    `<extLst><ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}" xmlns:x14="${NS.x14}">` +
    `<x14:dataValidations count="5" xmlns:xm="${NS.xm}">` +
    x14(UID.bool, ref.bool, `B${p0}:B1048576`) +
    x14(UID.unitType, ref.unitType, `C4:C${l.lastUnit}`) +
    x14(UID.sex, ref.sex, `S${p0}:S1048576`) +
    x14(UID.countryPob, ref.countryPob, `P${p0}:Q1048576`) +
    x14(UID.countryUnit, ref.countryUnit, `M4:M${l.lastUnit} R${p0}:R1048576`) +
    '</x14:dataValidations></ext></extLst>';
  return (
    `<mergeCells count="${merges.length}">${merges.map((r) => `<mergeCell ref="${r}"/>`).join('')}</mergeCells>` +
    std +
    MARGINS +
    ext +
    '</worksheet>'
  );
}

function dataSheet(spec: InvestcWorkbookSpec, str: Str): string {
  const unitRows = spec.unitRows.length > 0 ? spec.unitRows : [null];
  const people = spec.people.length > 0 ? spec.people : [null];
  const l = dataLayout(unitRows.length, people.length);
  const rows: string[] = [
    row(1, { A: { t: 's', v: MARKER_UNITS } }, { A: S.title }, str, DATA_ROW),
    row(2, { A: { t: 's', v: 'One row per unit. Unit names must be unique.' } }, { A: S.prose }, str, DATA_ROW),
    row(3, textRow(UNIT_HEADERS), allCols(13, S.header), str, DATA_ROW),
  ];
  unitRows.forEach((c, i) => rows.push(row(l.firstUnit + i, c, UNIT_STYLES, str, DATA_ROW)));
  rows.push(row(l.sep, { B: { t: 's', v: MARKER_SEPARATOR } }, { B: S.marker }, str, DATA_ROW));
  rows.push(row(l.ind, { A: { t: 's', v: MARKER_INDIVIDUALS } }, { A: S.title }, str, DATA_ROW));
  rows.push(row(l.sub, GROUPS, Object.fromEntries(Object.keys(GROUPS).map((k) => [k, S.group])), str, DATA_ROW));
  rows.push(row(l.hdr, textRow(PERSON_HEADERS), allCols(19, S.header), str, DATA_ROW));
  people.forEach((c, i) => rows.push(row(l.firstPerson + i, c, PERSON_STYLES, str, DATA_ROW)));
  const cols =
    '<cols><col min="1" max="1" width="34" customWidth="1"/><col min="2" max="12" width="18" customWidth="1"/>' +
    '<col min="13" max="13" width="16" customWidth="1"/><col min="14" max="19" width="18" customWidth="1"/></cols>';
  return (
    worksheetOpen(UID.sheet2, `A1:S${l.lastRow}`, true, cols) + `<sheetData>${rows.join('')}</sheetData>` + dataTail(l)
  );
}

// ---- assembly ----------------------------------------------------------------------------------------------------

function render(spec: InvestcWorkbookSpec, track: boolean): BuiltInvestcWorkbook {
  const sst = SharedStringsTable.empty();
  // The blank workbook's strings come first, in their own order, so data strings always follow them (an export that
  // keeps every row then reproduces the shared string table exactly).
  const seed: Str = (s) => sst.add(s.normalize('NFC'));
  instructionsSheet(seed, { a2: VERSION_A2_TEXT, c2: VERSION_C2_TEXT });
  dataSheet({ unitRows: [null], people: [null] }, seed);
  referenceSheet(seed);
  const structural = new Set(blankStrings());
  const written = new Set<string>();
  let refs = 0;
  const str: Str = (s) => {
    const norm = s.normalize('NFC');
    refs += 1;
    if (track && !structural.has(norm)) written.add(norm);
    return sst.add(norm);
  };
  const version = { a2: spec.versionCells?.a2 ?? VERSION_A2_TEXT, c2: spec.versionCells?.c2 ?? VERSION_C2_TEXT };
  // Version cell overrides count as generated strings even though they replace structural ones.
  if (spec.versionCells?.a2) written.add(spec.versionCells.a2);
  if (spec.versionCells?.c2) written.add(spec.versionCells.c2);
  const sheet1 = instructionsSheet(str, version);
  const sheet2 = dataSheet(spec, str);
  const sheet3 = referenceSheet(str);
  const pkg = packageFromParts({
    '[Content_Types].xml': CONTENT_TYPES,
    '_rels/.rels': ROOT_RELS,
    'docProps/app.xml': canonicalAppXml(),
    'docProps/core.xml': canonicalCoreXml(FIXED_TIME, FIXED_TIME),
    'xl/_rels/workbook.xml.rels': WORKBOOK_RELS,
    'xl/sharedStrings.xml': sst.serialize(refs),
    'xl/styles.xml': STYLES,
    'xl/workbook.xml': WORKBOOK,
    'xl/worksheets/sheet1.xml': sheet1,
    'xl/worksheets/sheet2.xml': sheet2,
    'xl/worksheets/sheet3.xml': sheet3,
  });
  return { bytes: writeZip(pkg), strings: written };
}

let blankCache: string[] | null = null;

/** The structural strings of the blank workbook (instruction text, markers, headers, reference lists), sorted. */
export function blankStrings(): string[] {
  if (blankCache) return blankCache;
  const seen = new Set<string>();
  const sink: Str = (s) => {
    seen.add(s.normalize('NFC'));
    return 0;
  };
  instructionsSheet(sink, { a2: VERSION_A2_TEXT, c2: VERSION_C2_TEXT });
  dataSheet({ unitRows: [null], people: [null] }, sink);
  referenceSheet(sink);
  blankCache = [...seen].sort();
  return blankCache;
}

/** The workbook with rows filled in. Deterministic: the same spec gives the same bytes. */
export function buildInvestcWorkbook(spec: InvestcWorkbookSpec): BuiltInvestcWorkbook {
  return render(spec, true);
}

/** The blank workbook (one empty unit row, one empty individual row). A fresh copy on every call. */
export function generateBlankTemplate(): Uint8Array {
  return render({ unitRows: [null], people: [null] }, false).bytes;
}
