/**
 * Structure-based location inside a DC response workbook (S-01, S-02, S-07, S-08): nothing here depends on a sheet
 * name or a fixed cell. Every function is pure and never throws.
 */
import { indexToCol } from '../ooxml/columns.ts';
import type { Sheet } from '../ooxml/sheet.ts';
import type { SheetRef } from '../ooxml/workbook.ts';

/** The eight DC result columns, in their usual order. */
export const RESULT_HEADERS = ['DISP', 'NAME', 'DOB', 'POB', 'UNIT TYPE', 'UNIT NAME', 'CERT DATE', 'EXPIRES'] as const;
export type ResultColumn = (typeof RESULT_HEADERS)[number];

/** A header row needs at least this many of the eight known headers (any order, any columns). */
export const HEADER_MIN_MATCHES = 5;
/** Rows scanned for the first header row of a sheet. */
export const HEADER_SCAN_ROWS = 200;

/** Header cell text folded: trimmed, spaces collapsed, upper case, trailing colon dropped. */
export function foldHeader(raw: string): string {
  return raw.normalize('NFKC').replace(/\s+/gu, ' ').trim().replace(/\s*:$/u, '').toUpperCase();
}

const ALIASES: Readonly<Record<string, ResultColumn>> = {
  DISPOSITION: 'DISP',
  'EXPIRY DATE': 'EXPIRES',
  'EXPIRATION DATE': 'EXPIRES',
  'CERTIFICATION DATE': 'CERT DATE',
};

/** The known column a header cell names, or null. */
export function headerOf(raw: string): ResultColumn | null {
  const t = foldHeader(raw);
  if ((RESULT_HEADERS as readonly string[]).includes(t)) return t as ResultColumn;
  return ALIASES[t] ?? null;
}

export interface ColumnMap {
  /** 1-based column per known header present in the row (first occurrence wins). */
  cols: Partial<Record<ResultColumn, number>>;
  /** Known headers absent from the row. */
  missing: ResultColumn[];
  /** Non-empty cells of the header row that name no known column. */
  extra: { col: number; text: string }[];
}

/** Column map of a row, or null when the row is not a header row (fewer than HEADER_MIN_MATCHES known headers). */
export function headerRowMap(sheet: Sheet, row: number): ColumnMap | null {
  const cols: Partial<Record<ResultColumn, number>> = {};
  const extra: { col: number; text: string }[] = [];
  let found = 0;
  for (const c of sheet.rowCells(row)) {
    if (c.text.trim() === '') continue;
    const h = c.kind === 'string' ? headerOf(c.text) : null;
    if (h === null) extra.push({ col: c.col, text: c.text.trim() });
    else if (cols[h] === undefined) {
      cols[h] = c.col;
      found++;
    }
  }
  if (found < HEADER_MIN_MATCHES) return null;
  return { cols, missing: RESULT_HEADERS.filter((h) => cols[h] === undefined), extra };
}

/** First header row of a sheet within the scan window, or null. */
export function firstHeaderRow(sheet: Sheet, limit = HEADER_SCAN_ROWS): number | null {
  for (const r of sheet.rowNumbers()) {
    if (r > limit) break;
    if (headerRowMap(sheet, r)) return r;
  }
  return null;
}

/** Column letter for messages. */
export const col = (n: number): string => indexToCol(n);

// ---- request workbook detection (S-01) ----------------------------------------------------------------------------

const REQUEST_SHEETS = ['template instructions', 'data', 'reference data'];

/** True when the sheet names are exactly the INVESTc request set (any order, case-insensitive). */
export function hasRequestSheetSet(sheets: readonly SheetRef[]): boolean {
  const names = sheets.map((s) => s.name.trim().toLowerCase()).sort();
  return names.length === REQUEST_SHEETS.length && names.every((n, i) => n === [...REQUEST_SHEETS].sort()[i]);
}

/** True when a sheet starts with the INVESTc `UNITS` marker in A1. */
export function hasUnitsMarker(sheet: Sheet): boolean {
  return sheet.text(1, 1).trim().toUpperCase() === 'UNITS';
}

// ---- metadata by label (S-08) -------------------------------------------------------------------------------------

export type MetaKey = 'resultsAsOf' | 'post' | 'batchId' | 'assistance';

export const META_LABELS: readonly { key: MetaKey; label: string; re: RegExp }[] = [
  { key: 'resultsAsOf', label: 'Final Results as of', re: /^final results as of\b\s*:?\s*(.*)$/iu },
  { key: 'post', label: 'Post:', re: /^post\s*:\s*(.*)$/iu },
  { key: 'batchId', label: 'Batch ID:', re: /^batch\s*id\s*:\s*(.*)$/iu },
  { key: 'assistance', label: 'Assistance:', re: /^assistance\s*:\s*(.*)$/iu },
];

export interface MetaHit {
  value: string;
  row: number;
  col: number;
}

/**
 * Metadata located by label prefix in rows 1..lastRow, any column. When the label cell holds only the label, the value
 * is the next non-empty cell to its right. First hit per label wins.
 */
export function findMetadata(sheet: Sheet, lastRow: number): Partial<Record<MetaKey, MetaHit>> {
  const out: Partial<Record<MetaKey, MetaHit>> = {};
  for (const r of sheet.rowNumbers()) {
    if (r > lastRow) break;
    const cells = sheet.rowCells(r).filter((c) => c.text.trim() !== '');
    cells.forEach((c, i) => {
      const text = c.text.replace(/\s+/gu, ' ').trim();
      for (const m of META_LABELS) {
        if (out[m.key]) continue;
        const hit = m.re.exec(text);
        if (!hit) continue;
        let value = (hit[1] ?? '').trim();
        if (value === '') value = cells[i + 1]?.text.replace(/\s+/gu, ' ').trim() ?? '';
        out[m.key] = { value, row: r, col: c.col };
        break;
      }
    });
  }
  return out;
}

/** Batch ids look like `ABCD-0000001234`; anything else is not taken as an id (the wizard asks for one). */
export const BATCH_ID_RE = /^[A-Z]{2,6}-\d{6,12}$/u;
