/**
 * Writes a synthetic DC "Final Results" workbook that mimics the structure of the real file: a single sheet
 * `Final_Results`, text cells only, header lines in B1..B4 and sections of label / 8-column header / rows / blank.
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
}

export interface ResponseSectionSpec {
  label: string;
  rows: ResponseRowSpec[];
}

export interface ResponseWorkbookSpec {
  /** B1 text, e.g. "Final Results as of 10/22/2026". */
  line1: string;
  line2: string;
  line3: string;
  line4: string;
  sections: ResponseSectionSpec[];
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

export interface BuiltResponse {
  bytes: Uint8Array;
  /** Every string written into the sheet. */
  strings: Set<string>;
}

export function buildResponseWorkbook(spec: ResponseWorkbookSpec): BuiltResponse {
  const sst = SharedStringsTable.empty();
  const hidden = spec.hiddenTrailingColumns === true;
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
    `<row r="${r}">${'ABCDEFGH'
      .split('')
      .map((c) => cell(`${c}${r}`, style, null))
      .join('')}</row>`;

  const rows: string[] = [];
  const merges: string[] = [];
  const lines = [spec.line1, spec.line2, spec.line3, spec.line4];
  lines.forEach((text, i) => {
    const r = i + 1;
    const style = i === 3 ? 7 : 5;
    rows.push(
      `<row r="${r}">${cell(`B${r}`, style, text)}${'CDEFGH'
        .split('')
        .map((c) => cell(`${c}${r}`, 6, null))
        .join('')}</row>`,
    );
    merges.push(`B${r}:H${r}`);
  });
  rows.push(blankRow(5, 9), blankRow(6, 10));
  merges.push('A5:H5', 'A6:H6');
  let r = 7;
  for (const sec of spec.sections) {
    rows.push(
      `<row r="${r}">${cell(`A${r}`, 11, sec.label)}${'BCDEFGH'
        .split('')
        .map((c) => cell(`${c}${r}`, 12, null))
        .join('')}</row>`,
    );
    merges.push(`A${r}:H${r}`);
    r += 1;
    rows.push(`<row r="${r}">${HEADERS.map((h, i) => cell(`${'ABCDEFGH'[i]}${r}`, 3, h)).join('')}</row>`);
    r += 1;
    for (const row of sec.rows) {
      const vals = [row.disp, row.name, row.dob, row.pob, row.unitType, row.unitName, row.cert, row.expires];
      const tail = hidden ? `${cell(`I${r}`, 2, null)}${cell(`J${r}`, 2, null)}` : '';
      rows.push(
        `<row r="${r}">${vals.map((v, i) => cell(`${'ABCDEFGH'[i]}${r}`, i === 0 ? 1 : 4, v)).join('')}${tail}</row>`,
      );
      r += 1;
    }
    r += 1; // blank row after each section
  }
  const last = hidden ? r - 2 : r - 1;
  const lastCol = hidden ? 'J' : 'H';
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

  const pkg = packageFromParts({
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'docProps/core.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>VSS</dc:creator><cp:lastModifiedBy>VSS</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">2026-11-03T00:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-11-03T00:00:00Z</dcterms:modified></cp:coreProperties>',
    'docProps/app.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Excel</Application></Properties>',
    'xl/workbook.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="29040" windowHeight="15990"/></bookViews><sheets><sheet name="Final_Results" sheetId="3" r:id="rId1"/></sheets><calcPr calcId="125725"/></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
    'xl/styles.xml': STYLES,
    'xl/worksheets/sheet1.xml': sheet,
    'xl/sharedStrings.xml': sst.serialize(refs),
  });
  return { bytes: writeZip(pkg), strings: written };
}
