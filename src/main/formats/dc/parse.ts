import type { PersonName, PlaceOfBirth, RawDate, ResponseSection } from '../../../shared/domain/types.ts';
import { formatIso, isValidYmd, serialToIso } from '../ooxml/dates.ts';
import type { Cell, Sheet } from '../ooxml/sheet.ts';
import { loadSharedStrings, loadSheet, openWorkbook } from '../ooxml/workbook.ts';
import { detectScript } from '../script.ts';
import type {
  DcResponseDraft,
  DcResponseDraftRow,
  ParsedFinalResults,
  ResponseIssue,
  ResponseIssueCode,
  ResponseRuleId,
} from './types.ts';

export const FINAL_RESULTS_SHEET = 'Final_Results';
const SHEET = FINAL_RESULTS_SHEET;
export const finalResultsRowRef = (row: number): string => `${SHEET}!${row}`;

export const SECTION_HEADERS = [
  'DISP',
  'NAME',
  'DOB',
  'POB',
  'UNIT TYPE',
  'UNIT NAME',
  'CERT DATE',
  'EXPIRES',
] as const;

/** Section labels in file order. */
export const SECTIONS: readonly { label: string; section: ResponseSection }[] = [
  { label: 'approved unit/commander', section: 'approved-unit' },
  { label: 'approved individuals', section: 'approved-individual' },
  { label: 'non approved unit/commander', section: 'nonapproved-unit' },
  { label: 'non approved individuals', section: 'nonapproved-individual' },
];

const RE_B1 = /^Final Results as of (\d{1,2}\/\d{1,2}\/\d{4})\s*$/;
const RE_B2 = /^Post:\s*(.*)$/;
const RE_B3 = /^Batch ID:\s*([A-Z]{2,6}-\d{6,12})\s*$/;
const RE_B4 = /^Assistance:\s*(.*)$/;

function mk(
  rule: ResponseRuleId,
  code: ResponseIssueCode,
  severity: ResponseIssue['severity'],
  rowRef: string | null,
  field: string | null,
  message: string,
  rawLabel?: string,
): ResponseIssue {
  const i: ResponseIssue = { rule, code, severity, rowRef, field, message };
  if (rawLabel !== undefined) i.rawLabel = rawLabel;
  return i;
}

/** M/D/YYYY (or MM/DD/YYYY) to ISO; null when not a real date. */
export function parseUsDate(text: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.trim());
  if (!m) return null;
  const mo = Number(m[1]);
  const d = Number(m[2]);
  const y = Number(m[3]);
  return isValidYmd(y, mo, d) ? formatIso(y, mo, d) : null;
}

/** S-03: response date cell. Text M/D/YYYY, or a serial; anything else keeps the text with parsed = null. */
export function rawDateFromResponseCell(cell: Cell | undefined): RawDate {
  if (!cell || cell.kind === 'blank' || cell.text.trim() === '') {
    return { kind: 'empty', value: '', parsed: null, ambiguousDayMonth: false };
  }
  if (cell.kind === 'number' && cell.num !== undefined) {
    return { kind: 'serial', value: cell.text, parsed: serialToIso(cell.num), ambiguousDayMonth: false };
  }
  return { kind: 'text', value: cell.text, parsed: parseUsDate(cell.text), ambiguousDayMonth: false };
}

export interface SplitName {
  surname: string;
  given: string[];
  hasComma: boolean;
  unknownCommander: boolean;
}

/** S-04: split at the first comma, trim, collapse spaces. */
export function splitName(raw: string): SplitName {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  const comma = collapsed.indexOf(',');
  const surname = (comma < 0 ? collapsed : collapsed.slice(0, comma)).trim();
  const rest = comma < 0 ? '' : collapsed.slice(comma + 1).replace(/,/g, ' ');
  const given = rest.split(/\s+/).filter((t) => t !== '');
  return { surname, given, hasComma: comma >= 0, unknownCommander: surname.toUpperCase() === 'UNKNOWN' };
}

/** S-05: split on " - " (blank parts allowed). Last part is the country. */
export function splitPob(raw: string): { pob: PlaceOfBirth; parts: number } {
  const t = raw.trim();
  if (t === '') return { pob: { city: null, state: null, country: null }, parts: 0 };
  const parts = t.split(/(?<=^|\s)-(?=\s|$)/).map((p) => p.trim());
  const nn = (s: string | undefined): string | null => (s === undefined || s === '' ? null : s);
  if (parts.length === 1) return { pob: { city: null, state: null, country: nn(parts[0]) }, parts: 1 };
  if (parts.length === 2) return { pob: { city: nn(parts[0]), state: null, country: nn(parts[1]) }, parts: 2 };
  const country = parts[parts.length - 1];
  const state = parts.slice(1, -1).join(' - ');
  return { pob: { city: nn(parts[0]), state: nn(state), country: nn(country) }, parts: parts.length };
}

function normLabel(raw: string): string {
  return raw.trim().replace(/:\s*$/, '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function emptyDraft(): DcResponseDraft {
  return { batchId: null, post: null, resultsAsOf: null, assistanceLine: null, rows: [] };
}

function finish(draft: DcResponseDraft, issues: ResponseIssue[], unknownSections: string[]): ParsedFinalResults {
  return { draft, issues, blocked: issues.some((i) => i.severity === 'error'), unknownSections };
}

/** A section label row: text in column A and nothing in B..H (the label cells are merged A:H in the DC file). */
function isLabelRow(sheet: Sheet, r: number): boolean {
  return sheet.text(r, 1).trim() !== '' && sheet.isRowEmpty(r, 2, 8);
}

/**
 * Parses a DC "Final Results" workbook (S-01..S-07). Never throws; an unknown section label is an error issue that
 * names the raw label and blocks the import.
 */
export function parseFinalResults(bytes: Uint8Array): ParsedFinalResults {
  const issues: ResponseIssue[] = [];
  const draft = emptyDraft();
  const opened = openWorkbook(bytes);
  if (!opened.ok) {
    issues.push(
      mk('S-01', 'PKG_NOT_XLSX', 'error', null, null, `The file is not a valid .xlsx workbook (${opened.reason}).`),
    );
    return finish(draft, issues, []);
  }
  const { pkg, info } = opened;
  const ref = info.sheets.find((s) => s.name === SHEET);
  if (!ref) {
    issues.push(
      mk(
        'S-01',
        'SHEET_MISSING',
        'error',
        null,
        null,
        `The workbook has no sheet named "${SHEET}" (found: ${info.sheets.map((s) => `"${s.name}"`).join(', ') || 'none'}).`,
      ),
    );
    return finish(draft, issues, []);
  }
  if (info.sheets.length > 1) {
    issues.push(
      mk(
        'S-07',
        'EXTRA_SHEETS',
        'warning',
        null,
        null,
        `Extra sheets are ignored: ${info.sheets
          .filter((s) => s !== ref)
          .map((s) => `"${s.name}"`)
          .join(', ')}.`,
      ),
    );
  }
  const sheet = loadSheet(pkg, ref, loadSharedStrings(pkg, info));
  if (!sheet) {
    issues.push(mk('S-01', 'SHEET_MISSING', 'error', null, null, `The sheet "${SHEET}" could not be read.`));
    return finish(draft, issues, []);
  }

  // S-01 header lines
  const headerLine = (row: number, re: RegExp, label: string): RegExpExecArray | null => {
    const m = re.exec(sheet.text(row, 2));
    if (!m)
      issues.push(
        mk(
          'S-01',
          'HEADER_CELL_MISMATCH',
          'error',
          finalResultsRowRef(row),
          'B',
          `Cell B${row} should be the "${label}" line.`,
        ),
      );
    return m;
  };
  const b1 = headerLine(1, RE_B1, 'Final Results as of M/D/YYYY');
  const b2 = headerLine(2, RE_B2, 'Post: <city>');
  const b3 = headerLine(3, RE_B3, 'Batch ID: XXXX-0000000000');
  const b4 = headerLine(4, RE_B4, 'Assistance: <event>');
  if (b1) {
    draft.resultsAsOf = parseUsDate(b1[1] as string);
    if (draft.resultsAsOf === null) {
      issues.push(
        mk('S-03', 'DATE_UNPARSEABLE', 'warning', finalResultsRowRef(1), 'B', `"${b1[1]}" is not a valid date.`),
      );
    }
  }
  if (b2) draft.post = (b2[1] as string).trim();
  if (b3) draft.batchId = b3[1] as string;
  if (b4) draft.assistanceLine = (b4[1] as string).trim();

  // S-02 / S-06 sections
  const unknownSections: string[] = [];
  const seen = new Map<string, number>();
  const order: string[] = [];
  const maxRow = sheet.maxRow;
  for (let r = 5; r <= maxRow; r++) {
    if (!isLabelRow(sheet, r)) continue;
    const rawLabel = sheet.text(r, 1);
    const key = normLabel(rawLabel);
    const def = SECTIONS.find((s) => s.label === key);
    if (!def) {
      unknownSections.push(rawLabel.trim());
      issues.push(
        mk(
          'S-06',
          'UNKNOWN_SECTION',
          'error',
          finalResultsRowRef(r),
          'A',
          `Unknown section "${rawLabel.trim()}". The import is blocked until this label is understood.`,
          rawLabel.trim(),
        ),
      );
      continue;
    }
    if (seen.has(key)) {
      issues.push(
        mk(
          'S-02',
          'SECTION_DUPLICATE',
          'error',
          finalResultsRowRef(r),
          'A',
          `Section "${rawLabel.trim()}" appears more than once.`,
        ),
      );
      continue;
    }
    seen.set(key, r);
    order.push(key);

    // header row
    const h = r + 1;
    SECTION_HEADERS.forEach((expected, i) => {
      const got = sheet
        .text(h, i + 1)
        .trim()
        .toUpperCase();
      if (got !== expected) {
        issues.push(
          mk(
            'S-02',
            'SECTION_HEADER_MISMATCH',
            'error',
            finalResultsRowRef(h),
            String.fromCharCode(65 + i),
            `Header in column ${String.fromCharCode(65 + i)} of section "${rawLabel.trim()}" should be "${expected}".`,
          ),
        );
      }
    });
    // data rows until an empty NAME and DISP (or the next label row)
    for (let d = h + 1; d <= maxRow; d++) {
      if (isLabelRow(sheet, d)) break;
      const disp = sheet.text(d, 1);
      const nameRaw = sheet.text(d, 2);
      if (disp.trim() === '' && nameRaw.trim() === '') break;
      draft.rows.push(readRow(sheet, d, def.section, issues));
    }
  }
  if (seen.size === 0 && unknownSections.length === 0) {
    issues.push(mk('S-02', 'NO_SECTIONS', 'error', null, null, 'No result sections were found.'));
  } else {
    for (const s of SECTIONS) {
      if (!seen.has(s.label)) {
        issues.push(mk('S-02', 'SECTION_MISSING', 'warning', null, null, `Section "${s.label}" is missing.`));
      }
    }
    const expectedOrder = SECTIONS.map((s) => s.label).filter((l) => seen.has(l));
    if (expectedOrder.join('|') !== order.join('|')) {
      issues.push(mk('S-02', 'SECTION_ORDER', 'warning', null, null, 'Sections are not in the usual order.'));
    }
  }
  return finish(draft, issues, unknownSections);
}

function readRow(sheet: Sheet, r: number, section: ResponseSection, issues: ResponseIssue[]): DcResponseDraftRow {
  const rowRef = finalResultsRowRef(r);
  const disp = sheet.text(r, 1);
  const nameRaw = sheet.text(r, 2);
  const sn = splitName(nameRaw);
  if (nameRaw.trim() === '') {
    issues.push(mk('S-04', 'NAME_EMPTY', 'warning', rowRef, 'B', 'NAME is empty.'));
  } else if (!sn.hasComma && !sn.unknownCommander) {
    issues.push(
      mk('S-04', 'NAME_NO_COMMA', 'warning', rowRef, 'B', 'NAME has no comma; the whole text is taken as the surname.'),
    );
  }
  const name: PersonName = { surname: sn.surname, given: sn.given, raw: nameRaw, script: detectScript(nameRaw) };
  const dob = rawDateFromResponseCell(sheet.cell(r, 3));
  const certDate = rawDateFromResponseCell(sheet.cell(r, 7));
  const expires = rawDateFromResponseCell(sheet.cell(r, 8));
  for (const [d, col, label] of [
    [dob, 'C', 'DOB'],
    [certDate, 'G', 'CERT DATE'],
    [expires, 'H', 'EXPIRES'],
  ] as const) {
    if (d.kind !== 'empty' && d.parsed === null) {
      issues.push(
        mk('S-03', 'DATE_UNPARSEABLE', 'warning', rowRef, col, `${label} "${d.value}" is not a valid M/D/YYYY date.`),
      );
    }
  }
  const { pob, parts } = splitPob(sheet.text(r, 4));
  if (parts > 3)
    issues.push(
      mk(
        'S-05',
        'POB_TOO_MANY_PARTS',
        'warning',
        rowRef,
        'D',
        'POB has more than three parts; the middle parts are joined as the state.',
      ),
    );
  return {
    rowRef,
    section,
    disp,
    nameRaw,
    name,
    unknownCommander: sn.unknownCommander,
    dob,
    pob,
    unitType: sheet.text(r, 5).trim(),
    unitName: sheet.text(r, 6).trim(),
    certDate,
    expires,
  };
}
