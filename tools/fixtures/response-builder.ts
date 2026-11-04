/**
 * Writes a synthetic DC "Final Results" workbook that mimics the structure of the real file: a single sheet
 * `Final_Results`, text cells only, header lines in B1..B4 and sections of label / 8-column header / rows / blank.
 * Optional variants (Alpha 1, lane C) exercise the structure-based parser: another sheet name, extra (hidden) sheets,
 * metadata labels in column A or missing, reordered / extra columns, a section without label or without header.
 * Without options the output is byte-identical to the 0.1 builder.
 */
import { SharedStringsTable } from '../../src/main/formats/ooxml/sharedStrings.ts';
import { packageFromParts } from '../../src/main/formats/ooxml/patcher.ts';
import { writeZip } from '../../src/main/formats/ooxml/zip.ts';

export interface ResponseRowSpec {
  disp: string;
  name: string;
  dob: string;
  pob: string;
  unitType: string;
  unitName: string;
  cert: string;
  expires: string;
  /** Value written under any header that is not one of the eight DC headers (see `headers`). */
  extra?: string;
}

export interface ResponseSectionSpec {
  /** null = no label row (the parser must open an implicit section). */
  label: string | null;
  rows: ResponseRowSpec[];
  /** Omit the header row (a label directly followed by the next label). */
  noHeader?: boolean;
}

export interface ExtraSheetSpec {
  name: string;
  hidden?: boolean;
  /** Before or after the results sheet in workbook order. */
  position: 'before' | 'after';
  /** One text per row, in column A. */
  rows: string[];
}

export interface ResponseWorkbookSpec {
  /** B1 text, e.g. "Final Results as of 10/22/2026". null = the row stays empty. */
  line1: string | null;
  line2: string | null;
  line3: string | null;
  line4: string | null;
  sections: ResponseSectionSpec[];
  /** Results sheet name (default `Final_Results`). */
  sheetName?: string;
  /** Column of the four metadata lines (default B). */
  metaColumn?: 'A' | 'B';
  /** Header texts in column order (default the eight DC headers). */
  headers?: string[];
  extraSheets?: ExtraSheetSpec[];
  /**
   * Layout seen in current DC files: two hidden, styled but empty columns I:J after the eight data columns (written on
   * every data row), and a dimension that ends at the last written row instead of the trailing blank. Default off, so
   * the older fixtures stay byte-identical.
   */
  hiddenTrailingColumns?: boolean;
}

const HEADERS = ['DISP', 'NAME', 'DOB', 'POB', 'UNIT TYPE', 'UNIT NAME', 'CERT DATE', 'EXPIRES'];

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="0"/><fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDDDDD"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color indexed="64"/></left><right style="thin"><color indexed="64"/></right><top style="thin"><color indexed="64"/></top><bottom style="thin"><color indexed="64"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="13"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left" vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="top"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="top" wrapText="1"/></xf><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left" vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="top"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="top"/></xf><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="top"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

export interface BuiltSectionLayout {
  labelRow: number | null;
  headerRow: number | null;
  dataRows: number[];
}

export interface BuiltResponse {
  bytes: Uint8Array;
  /** Every string written into the workbook. */
  strings: Set<string>;
  /** Where each section landed (sheet row numbers), for the expected files. */
  layout: BuiltSectionLayout[];
  /** Column letter of each header, in `headers` order. */
  headerColumns: Record<string, string>;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function valueFor(header: string, row: ResponseRowSpec): string {
  switch (header) {
    case 'DISP':
      return row.disp;
    case 'NAME':
      return row.name;
    case 'DOB':
      return row.dob;
    case 'POB':
      return row.pob;
    case 'UNIT TYPE':
      return row.unitType;
    case 'UNIT NAME':
      return row.unitName;
    case 'CERT DATE':
      return row.cert;
    case 'EXPIRES':
      return row.expires;
    default:
      return row.extra ?? '';
  }
}

export function buildResponseWorkbook(spec: ResponseWorkbookSpec): BuiltResponse {
  const sst = SharedStringsTable.empty();
  const hidden = spec.hiddenTrailingColumns === true;
  const headers = spec.headers ?? HEADERS;
  const width = Math.max(8, headers.length);
  const letters = LETTERS.slice(0, width).split('');
  const lastLetter = letters[letters.length - 1] as string;
  const metaCol = spec.metaColumn ?? 'B';
  const written = new Set<string>();
  let refs = 0;
  const cell = (ref: string, style: number, text: string | null): string => {
    if (text === null) return `<c r="${ref}" s="${style}"/>`;
    const t = text.normalize('NFC');
    written.add(t);
    refs += 1;
    return `<c r="${ref}" s="${style}" t="s"><v>${sst.add(t)}</v></c>`;
  };
  const blankRow = (r: number, style: number): string =>
    `<row r="${r}">${letters.map((c) => cell(`${c}${r}`, style, null)).join('')}</row>`;

  const rows: string[] = [];
  const merges: string[] = [];
  const layout: BuiltSectionLayout[] = [];
  const lines = [spec.line1, spec.line2, spec.line3, spec.line4];
  lines.forEach((text, i) => {
    const r = i + 1;
    const style = i === 3 ? 7 : 5;
    const rest = letters.slice(letters.indexOf(metaCol) + 1);
    rows.push(
      `<row r="${r}">${cell(`${metaCol}${r}`, style, text)}${rest.map((c) => cell(`${c}${r}`, 6, null)).join('')}</row>`,
    );
    merges.push(`${metaCol}${r}:${lastLetter}${r}`);
  });
  rows.push(blankRow(5, 9), blankRow(6, 10));
  merges.push(`A5:${lastLetter}5`, `A6:${lastLetter}6`);
  let r = 7;
  for (const sec of spec.sections) {
    const lay: BuiltSectionLayout = { labelRow: null, headerRow: null, dataRows: [] };
    if (sec.label !== null) {
      rows.push(
        `<row r="${r}">${cell(`A${r}`, 11, sec.label)}${letters
          .slice(1)
          .map((c) => cell(`${c}${r}`, 12, null))
          .join('')}</row>`,
      );
      merges.push(`A${r}:${lastLetter}${r}`);
      lay.labelRow = r;
      r += 1;
    }
    if (sec.noHeader !== true) {
      rows.push(`<row r="${r}">${headers.map((h, i) => cell(`${letters[i]}${r}`, 3, h)).join('')}</row>`);
      lay.headerRow = r;
      r += 1;
    }
    for (const row of sec.rows) {
      const vals = headers.map((h) => valueFor(h, row));
      const tail = hidden ? `${cell(`I${r}`, 2, null)}${cell(`J${r}`, 2, null)}` : '';
      rows.push(
        `<row r="${r}">${vals.map((v, i) => cell(`${letters[i]}${r}`, headers[i] === 'DISP' ? 1 : 4, v)).join('')}${tail}</row>`,
      );
      lay.dataRows.push(r);
      r += 1;
    }
    layout.push(lay);
    r += 1; // blank row after each section
  }
  const last = hidden ? r - 2 : r - 1;
  const lastCol = hidden ? 'J' : lastLetter;
  const hiddenCols = hidden
    ? '<col min="9" max="9" hidden="1" width="9" customWidth="1"/><col min="10" max="10" hidden="1" width="9" customWidth="1"/>'
    : '';
  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:${lastCol}${last}"/>` +
    `<sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>` +
    `<cols><col min="1" max="1" width="12" customWidth="1"/><col min="2" max="2" width="34" customWidth="1"/><col min="3" max="3" width="12" customWidth="1"/><col min="4" max="4" width="34" customWidth="1"/><col min="5" max="5" width="12" customWidth="1"/><col min="6" max="6" width="48" customWidth="1"/><col min="7" max="8" width="12" customWidth="1"/>${hiddenCols}</cols>` +
    `<sheetData>${rows.join('')}</sheetData>` +
    `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` +
    `<pageMargins left="0.45" right="0.45" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>` +
    `<pageSetup orientation="landscape" fitToHeight="0"/></worksheet>`;

  // Extra sheets (sheet2.xml, sheet3.xml ...), each a single text column.
  const extras = spec.extraSheets ?? [];
  const extraParts: Record<string, string> = {};
  extras.forEach((x, k) => {
    extraParts[`xl/worksheets/sheet${k + 2}.xml`] =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
      x.rows.map((t, i) => `<row r="${i + 1}">${cell(`A${i + 1}`, 0, t)}</row>`).join('') +
      `</sheetData></worksheet>`;
  });
  const WS = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
  const extraOverrides = extras
    .map((_, k) => `<Override PartName="/xl/worksheets/sheet${k + 2}.xml" ContentType="${WS}"/>`)
    .join('');
  const sheetEl = (name: string, id: number, rid: string, hide: boolean): string =>
    `<sheet name="${name}" sheetId="${id}"${hide ? ' state="hidden"' : ''} r:id="${rid}"/>`;
  const extraEls = (pos: 'before' | 'after'): string =>
    extras
      .map((x, k) => ({ x, k }))
      .filter(({ x }) => x.position === pos)
      .map(({ x, k }) => sheetEl(x.name, k + 4, `rId${k + 4}`, x.hidden === true))
      .join('');
  const sheetsXml = `${extraEls('before')}${sheetEl(spec.sheetName ?? 'Final_Results', 3, 'rId1', false)}${extraEls('after')}`;
  const extraRels = extras
    .map(
      (_, k) =>
        `<Relationship Id="rId${k + 4}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${k + 2}.xml"/>`,
    )
    .join('');

  const pkg = packageFromParts({
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="${WS}"/>${extraOverrides}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'docProps/core.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>VSS</dc:creator><cp:lastModifiedBy>VSS</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">2026-11-03T00:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-11-03T00:00:00Z</dcterms:modified></cp:coreProperties>',
    'docProps/app.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Excel</Application></Properties>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="29040" windowHeight="15990"/></bookViews><sheets>${sheetsXml}</sheets><calcPr calcId="125725"/></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>${extraRels}</Relationships>`,
    'xl/styles.xml': STYLES,
    'xl/worksheets/sheet1.xml': sheet,
    ...extraParts,
    'xl/sharedStrings.xml': sst.serialize(refs),
  });
  const headerColumns = Object.fromEntries(headers.map((h, i) => [h, letters[i] as string]));
  if (spec.sheetName) written.add(spec.sheetName);
  for (const x of extras) written.add(x.name);
  return { bytes: writeZip(pkg), strings: written, layout, headerColumns };
}
