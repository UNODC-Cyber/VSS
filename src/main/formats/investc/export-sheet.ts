/**
 * Rewrites the INVESTc `Data` worksheet for export (docs/FILE-FORMATS.md X-04, X-05): the rows are rebuilt from the
 * structural rows of a base workbook (the vault template or the counterpart's own file) plus the supplied data rows, then
 * merges and data validations are re-anchored with one row map. Everything else in the part is carried over verbatim.
 */
import { colToIndex, indexToCol, MAX_ROW } from '../ooxml/columns.ts';
import { escapeXmlText, parseAttrs } from '../ooxml/xml.ts';

/** Thrown when a worksheet uses a feature the exporter cannot re-anchor safely (filter-original falls back). */
export class UnsupportedSheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedSheetError';
  }
}

export type ExportCellValue = { t: 's'; v: string } | { t: 'n'; v: number } | { t: 'b'; v: boolean };
/** Values of one data row by 1-based column. */
export type ExportRowValues = Map<number, ExportCellValue>;

/** Where the structural rows of the source sheet are. */
export interface SourceSheetLayout {
  /** Separator row (`LEAVE A ROW BLANK`). Unit rows are 4..sep-1. */
  sep: number;
  /** Individuals header row. Person rows are hdr+1.. */
  hdr: number;
}

/** X-04 row map of the written sheet. */
export interface ExportRowMap {
  /** Number of unit rows written (at least 1: an empty styled row keeps the block when there are no units). */
  unitRows: number;
  /** Number of person rows written (at least 1, same reason). */
  personRows: number;
  lastUnit: number;
  sep: number;
  ind: number;
  sub: number;
  hdr: number;
  firstPerson: number;
  lastPerson: number;
}

export function rowMapFor(source: SourceSheetLayout, units: number, people: number): ExportRowMap {
  const unitRows = Math.max(units, 1);
  const personRows = Math.max(people, 1);
  const sep = 4 + unitRows;
  const hdr = sep + (source.hdr - source.sep);
  return {
    unitRows,
    personRows,
    lastUnit: 3 + unitRows,
    sep,
    ind: sep + 1,
    sub: sep + 2,
    hdr,
    firstPerson: hdr + 1,
    lastPerson: hdr + personRows,
  };
}

// ---- tiny XML structure helpers --------------------------------------------------------------------------------

export interface TopElement {
  name: string;
  xml: string;
}

const TAG_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w:.-]*)\b[^>]*?(\/?)>/g;

/** Splits a sequence of sibling elements (e.g. the children of <worksheet> after </sheetData>) into elements. */
export function splitTopLevel(xml: string): { elements: TopElement[]; rest: string } {
  const elements: TopElement[] = [];
  const re = new RegExp(TAG_RE.source, 'g');
  let depth = 0;
  let start = -1;
  let name = '';
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(xml)) !== null) {
    if (m[2] === undefined) continue; // comment, CDATA or PI
    const closing = m[1] === '/';
    const selfClosing = m[3] === '/';
    if (depth === 0) {
      if (closing) {
        // closing tag of the parent: stop here
        return { elements, rest: xml.slice(m.index) };
      }
      start = m.index;
      name = m[2];
      if (selfClosing) {
        elements.push({ name, xml: xml.slice(start, re.lastIndex) });
        consumed = re.lastIndex;
        continue;
      }
      depth = 1;
      continue;
    }
    if (closing) depth -= 1;
    else if (!selfClosing) depth += 1;
    if (depth === 0) {
      elements.push({ name, xml: xml.slice(start, re.lastIndex) });
      consumed = re.lastIndex;
    }
  }
  return { elements, rest: xml.slice(consumed) };
}

function setAttr(tag: string, attr: string, value: string): string {
  const re = new RegExp(`(\\s${attr}\\s*=\\s*)(?:"[^"]*"|'[^']*')`);
  if (re.test(tag)) return tag.replace(re, `$1"${value}"`);
  return tag.replace(/^(<[\w:.-]+)/, `$1 ${attr}="${value}"`);
}

// ---- row map applied to references -----------------------------------------------------------------------------

interface Range {
  c1: string;
  r1: number;
  c2: string;
  r2: number;
}

function parseRange(token: string): Range | null {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/.exec(token);
  if (!m) return null;
  return {
    c1: m[1] as string,
    r1: Number(m[2]),
    c2: (m[3] ?? m[1]) as string,
    r2: Number(m[4] ?? m[2]),
  };
}

type Block = 'top' | 'units' | 'structure' | 'people';

class RowMapper {
  private readonly src: SourceSheetLayout;
  private readonly dst: ExportRowMap;

  constructor(src: SourceSheetLayout, dst: ExportRowMap) {
    this.src = src;
    this.dst = dst;
  }

  block(row: number): Block {
    if (row < 4) return 'top';
    if (row < this.src.sep) return 'units';
    if (row <= this.src.hdr) return 'structure';
    return 'people';
  }

  /** New row of a structural (or top) row. */
  structural(row: number): number {
    return row < 4 ? row : this.dst.sep + (row - this.src.sep);
  }

  start(row: number): number {
    const b = this.block(row);
    if (b === 'units') return 4;
    if (b === 'people') return this.dst.firstPerson;
    return this.structural(row);
  }

  end(row: number): number {
    const b = this.block(row);
    if (b === 'units') return this.dst.lastUnit;
    if (b === 'people') return row >= MAX_ROW ? MAX_ROW : this.dst.lastPerson;
    return this.structural(row);
  }

  /** Re-anchors an sqref list. Tokens that are not plain A1 ranges (whole columns, ...) are kept as written. */
  sqref(list: string): string {
    return list
      .trim()
      .split(/\s+/)
      .map((tok) => {
        const r = parseRange(tok);
        if (!r) return tok;
        const r1 = this.start(r.r1);
        const r2 = this.end(r.r2);
        return r.c1 === r.c2 && r1 === r2 && !tok.includes(':') ? `${r.c1}${r1}` : `${r.c1}${r1}:${r.c2}${r2}`;
      })
      .join(' ');
  }

  /** A merge is kept only when both ends are top or structural rows (merges inside data blocks are dropped). */
  merge(ref: string): string | null {
    const r = parseRange(ref);
    if (!r) return ref;
    const b1 = this.block(r.r1);
    const b2 = this.block(r.r2);
    if (b1 === 'units' || b1 === 'people' || b2 === 'units' || b2 === 'people') return null;
    return `${r.c1}${this.structural(r.r1)}:${r.c2}${this.structural(r.r2)}`;
  }
}

// ---- the rewrite -----------------------------------------------------------------------------------------------

/** Children of <worksheet> after </sheetData> that are carried over verbatim (row-independent). */
const KEPT_TAIL = new Set([
  'sheetCalcPr',
  'sheetProtection',
  'printOptions',
  'pageMargins',
  'pageSetup',
  'headerFooter',
  'drawing',
  'legacyDrawingHF',
  'picture',
]);
/** Row-dependent, cosmetic only: dropped rather than re-anchored. */
const DROPPED_TAIL = new Set(['ignoredErrors']);
const X14_DV_URI = '{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}';

export interface SheetParts {
  head: string;
  rows: Map<number, string>;
  tail: TopElement[];
  closing: string;
}

const ROW_RE = /<row\b([^>]*?)(?:\/>|>[\s\S]*?<\/row>)/g;

/** Splits worksheet XML into the part before <sheetData>, the rows by number, and the elements after it. */
export function splitSheet(xml: string): SheetParts {
  const open = /<sheetData\b[^>]*?(\/?)>/.exec(xml);
  if (!open) throw new UnsupportedSheetError('the Data sheet has no <sheetData> element');
  const head = xml.slice(0, open.index);
  let bodyStart = open.index + open[0].length;
  let afterData: number;
  let body = '';
  if (open[1] === '/') {
    afterData = bodyStart;
  } else {
    const close = xml.indexOf('</sheetData>', bodyStart);
    if (close < 0) throw new UnsupportedSheetError('unterminated <sheetData>');
    body = xml.slice(bodyStart, close);
    afterData = close + '</sheetData>'.length;
  }
  bodyStart = 0;
  const rows = new Map<number, string>();
  const re = new RegExp(ROW_RE.source, 'g');
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(body)) !== null) {
    const a = parseAttrs(m[1] as string);
    n = a['r'] !== undefined ? Number(a['r']) : n + 1;
    rows.set(n, m[0]);
  }
  const { elements, rest } = splitTopLevel(xml.slice(afterData));
  return { head, rows, tail: elements, closing: rest };
}

/** Throws UnsupportedSheetError when the sheet uses something the row map cannot carry. */
export function assertSupportedSheet(xml: string): void {
  if (/<f\b/.test(xml)) throw new UnsupportedSheetError('the Data sheet contains formulas');
  const parts = splitSheet(xml);
  for (const el of parts.tail) {
    if (el.name === 'mergeCells' || el.name === 'dataValidations') continue;
    if (KEPT_TAIL.has(el.name) || DROPPED_TAIL.has(el.name)) continue;
    if (el.name === 'extLst') {
      const exts = splitTopLevel(el.xml.replace(/^<extLst\b[^>]*>/, '').replace(/<\/extLst>$/, '')).elements;
      for (const ext of exts) {
        const uri = parseAttrs(/^<ext\b([^>]*)>/.exec(ext.xml)?.[1] ?? '')['uri'];
        if (uri !== X14_DV_URI) throw new UnsupportedSheetError(`the Data sheet has an unsupported extension ${uri}`);
      }
      continue;
    }
    throw new UnsupportedSheetError(`the Data sheet uses <${el.name}>, which the exporter cannot re-anchor`);
  }
}

/** Renumbers one row element and the refs of its cells. */
export function renumberRow(rowXml: string, newRow: number): string {
  const start = /^<row\b[^>]*>/.exec(rowXml);
  if (!start) return rowXml;
  let tag = start[0];
  tag = /\sr\s*=\s*"/.test(tag)
    ? tag.replace(/(\sr\s*=\s*")\d+(")/, `$1${newRow}$2`)
    : setAttr(tag, 'r', String(newRow));
  const rest = rowXml.slice(start[0].length).replace(/(<c\b[^>]*?\sr=")([A-Z]{1,3})\d+(")/g, `$1$2${newRow}$3`);
  return tag + rest;
}

/** Row attributes (minus r) and per-column style of a row used as the pattern for data rows. */
export interface RowPattern {
  attrs: string;
  styles: Map<number, number>;
}

export function rowPattern(rowXml: string | undefined): RowPattern {
  if (!rowXml) return { attrs: ' spans="1:19"', styles: new Map() };
  const start = /^<row\b([^>]*?)\/?>/.exec(rowXml);
  const attrs = (start?.[1] ?? '').replace(/\s+r\s*=\s*"[^"]*"/, '');
  const styles = new Map<number, number>();
  const re = /<c\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rowXml)) !== null) {
    const a = parseAttrs(m[1] as string);
    const ref = /^([A-Z]{1,3})\d+$/.exec(a['r'] ?? '');
    if (!ref || a['s'] === undefined || !/^\d+$/.test(a['s'])) continue;
    styles.set(colToIndex(ref[1] as string), Number(a['s']));
  }
  return { attrs, styles };
}

function dataRow(
  row: number,
  pattern: RowPattern,
  values: ExportRowValues | null,
  styleOverride: ReadonlyMap<number, number>,
  str: (s: string) => number,
): string {
  const cols = new Set<number>(pattern.styles.keys());
  if (values) for (const c of values.keys()) cols.add(c);
  const ordered = [...cols].sort((a, b) => a - b);
  let body = '';
  for (const col of ordered) {
    const v = values?.get(col);
    const style = (v ? styleOverride.get(col) : undefined) ?? pattern.styles.get(col);
    const s = style !== undefined ? ` s="${style}"` : '';
    const ref = `${indexToCol(col)}${row}`;
    if (!v) {
      body += `<c r="${ref}"${s}/>`;
      continue;
    }
    if (v.t === 's') body += `<c r="${ref}"${s} t="s"><v>${str(v.v)}</v></c>`;
    else if (v.t === 'b') body += `<c r="${ref}"${s} t="b"><v>${v.v ? 1 : 0}</v></c>`;
    else body += `<c r="${ref}"${s}><v>${escapeXmlText(String(v.v))}</v></c>`;
  }
  return `<row r="${row}"${pattern.attrs}>${body}</row>`;
}

export interface RewriteInput {
  sheetXml: string;
  source: SourceSheetLayout;
  units: ExportRowValues[];
  people: ExportRowValues[];
  /** Style overrides for person cells that carry a value (the DOB column gets the date style). */
  personStyleOverride: ReadonlyMap<number, number>;
  str: (s: string) => number;
}

export interface RewriteResult {
  xml: string;
  map: ExportRowMap;
  /** Merges in data rows that were dropped (not re-anchorable). */
  droppedMerges: string[];
  droppedElements: string[];
}

export function rewriteDataSheet(input: RewriteInput): RewriteResult {
  const { sheetXml, source } = input;
  assertSupportedSheet(sheetXml);
  const parts = splitSheet(sheetXml);
  const map = rowMapFor(source, input.units.length, input.people.length);
  const mapper = new RowMapper(source, map);

  const rows: string[] = [];
  for (let r = 1; r <= 3; r++) {
    const x = parts.rows.get(r);
    if (x) rows.push(x);
  }
  const unitPattern = rowPattern(parts.rows.get(4));
  const personPattern = rowPattern(parts.rows.get(source.hdr + 1));
  const none = new Map<number, number>();
  if (input.units.length === 0) rows.push(dataRow(4, unitPattern, null, none, input.str));
  input.units.forEach((v, i) => rows.push(dataRow(4 + i, unitPattern, v, none, input.str)));
  for (let r = source.sep; r <= source.hdr; r++) {
    const x = parts.rows.get(r);
    if (x) rows.push(renumberRow(x, mapper.structural(r)));
  }
  if (input.people.length === 0) rows.push(dataRow(map.firstPerson, personPattern, null, none, input.str));
  input.people.forEach((v, i) =>
    rows.push(dataRow(map.firstPerson + i, personPattern, v, input.personStyleOverride, input.str)),
  );
  const sheetData = `<sheetData>${rows.join('')}</sheetData>`;

  // Dimension from the cells actually written.
  let minCol = Infinity;
  let maxCol = 0;
  let minRow = Infinity;
  let maxRow = 0;
  const cre = /<c\b[^>]*?\sr="([A-Z]{1,3})(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = cre.exec(sheetData)) !== null) {
    const c = colToIndex(m[1] as string);
    const r = Number(m[2]);
    if (c < minCol) minCol = c;
    if (c > maxCol) maxCol = c;
    if (r < minRow) minRow = r;
    if (r > maxRow) maxRow = r;
  }
  const dim = maxCol === 0 ? 'A1' : `${indexToCol(minCol)}${minRow}:${indexToCol(maxCol)}${maxRow}`;
  const head = /<dimension\b[^>]*?\/>/.test(parts.head)
    ? parts.head.replace(/<dimension\b[^>]*?\/>/, `<dimension ref="${dim}"/>`)
    : parts.head;

  const droppedMerges: string[] = [];
  const droppedElements: string[] = [];
  const tail: string[] = [];
  for (const el of parts.tail) {
    if (DROPPED_TAIL.has(el.name)) {
      droppedElements.push(el.name);
      continue;
    }
    if (el.name === 'mergeCells') {
      const refs: string[] = [];
      const re = /<mergeCell\b([^>]*?)\/?>/g;
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(el.xml)) !== null) {
        const ref = parseAttrs(mm[1] as string)['ref'];
        if (!ref) continue;
        const next = mapper.merge(ref);
        if (next === null) droppedMerges.push(ref);
        else refs.push(next);
      }
      if (refs.length > 0) {
        const open = setAttr(/^<mergeCells\b[^>]*?>/.exec(el.xml)?.[0] ?? '<mergeCells>', 'count', String(refs.length));
        tail.push(`${open}${refs.map((r) => `<mergeCell ref="${r}"/>`).join('')}</mergeCells>`);
      }
      continue;
    }
    if (el.name === 'dataValidations') {
      tail.push(rewriteStandardValidations(el.xml, mapper));
      continue;
    }
    if (el.name === 'extLst') {
      tail.push(rewriteX14Validations(el.xml, mapper));
      continue;
    }
    tail.push(el.xml);
  }
  return {
    xml: head + sheetData + tail.join('') + parts.closing,
    map,
    droppedMerges,
    droppedElements,
  };
}

function rewriteStandardValidations(xml: string, mapper: RowMapper): string {
  let n = 0;
  const body = xml.replace(/<dataValidation\b[^>]*?\/?>/g, (tag) => {
    n += 1;
    const sq = parseAttrs(tag.slice('<dataValidation'.length).replace(/\/?>$/, ''))['sqref'];
    return sq === undefined ? tag : setAttr(tag, 'sqref', mapper.sqref(sq));
  });
  return body.replace(/^<dataValidations\b[^>]*?>/, (open) => setAttr(open, 'count', String(n)));
}

function rewriteX14Validations(xml: string, mapper: RowMapper): string {
  return xml.replace(/<x14:dataValidations\b[^>]*?>[\s\S]*?<\/x14:dataValidations>/g, (block) => {
    const n = (block.match(/<x14:dataValidation\b/g) ?? []).length;
    const body = block.replace(
      /(<xm:sqref>)([\s\S]*?)(<\/xm:sqref>)/g,
      (_w, a: string, sq: string, b: string) => `${a}${mapper.sqref(sq)}${b}`,
    );
    return body.replace(/^<x14:dataValidations\b[^>]*?>/, (open) => setAttr(open, 'count', String(n)));
  });
}
