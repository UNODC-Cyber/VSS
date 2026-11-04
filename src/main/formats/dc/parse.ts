import type { PersonName, PlaceOfBirth, RawDate } from '../../../shared/domain/types.ts';
import { splitByScript } from '../../../shared/names/normalize.ts';
import { formatIso, isValidYmd, serialToIso } from '../ooxml/dates.ts';
import type { Cell, Sheet } from '../ooxml/sheet.ts';
import { loadSharedStrings, loadSheet, openWorkbook, type SheetRef } from '../ooxml/workbook.ts';
import { detectScript } from '../script.ts';
import {
  classifyDisp,
  kindHint,
  parseSectionLabel,
  resolveDisposition,
  sectionOf,
  type SectionKind,
} from './disposition.ts';
import {
  BATCH_ID_RE,
  RESULT_HEADERS,
  col,
  findMetadata,
  firstHeaderRow,
  hasRequestSheetSet,
  hasUnitsMarker,
  headerRowMap,
  type ColumnMap,
  type ResultColumn,
} from './locate.ts';
import type {
  DcResponseDraft,
  DcResponseDraftRow,
  FileKindGuess,
  ParsedFinalResults,
  ResponseIssue,
  ResponseIssueCode,
  ResponseRuleId,
} from './types.ts';

/** The sheet name of current DC files. Informational only: the parser locates the results by structure (S-01). */
export const FINAL_RESULTS_SHEET = 'Final_Results';
/** `Sheet!row`, at most 32 characters (the IPC bound): a long sheet name is shortened, the row number never. */
export const finalResultsRowRef = (row: number, sheet = FINAL_RESULTS_SHEET): string => {
  const r = String(row);
  return `${sheet.slice(0, 31 - r.length).replace(/[\uD800-\uDBFF]$/u, '')}!${r}`;
};

/** The eight result headers in their usual order (kept for callers of the 0.1 API). */
export const SECTION_HEADERS = RESULT_HEADERS;

/** The four known section labels in file order. */
export const SECTIONS = [
  { label: 'approved unit/commander', section: 'approved-unit' },
  { label: 'approved individuals', section: 'approved-individual' },
  { label: 'non approved unit/commander', section: 'nonapproved-unit' },
  { label: 'non approved individuals', section: 'nonapproved-individual' },
] as const;

/** The plain-language refusal shown when a request workbook is picked in the response importer (S-01). */
export const LOOKS_LIKE_REQUEST_MESSAGE =
  'This looks like a vetting request workbook, not a DC response. Use Requests > Import request for it.';

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

/**
 * S-04: split at the first comma, trim, collapse spaces. Given words are also split where the script changes
 * (`Arkanสมปอง` -> `Arkan`, `สมปอง`), so mixed Latin + non-Latin given names become separate tokens.
 */
export function splitName(raw: string): SplitName {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  const comma = collapsed.indexOf(',');
  const surname = (comma < 0 ? collapsed : collapsed.slice(0, comma)).trim();
  const rest = comma < 0 ? '' : collapsed.slice(comma + 1).replace(/,/g, ' ');
  const given = rest
    .split(/\s+/)
    .filter((t) => t !== '')
    .flatMap(splitByScript);
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

function emptyDraft(): DcResponseDraft {
  return { batchId: null, post: null, resultsAsOf: null, assistanceLine: null, rows: [] };
}

function finish(
  draft: DcResponseDraft,
  issues: ResponseIssue[],
  unknownSections: string[],
  fileKindGuess: FileKindGuess,
  resultsSheet: string | null,
): ParsedFinalResults {
  return {
    draft,
    issues,
    blocked: issues.some((i) => i.severity === 'error'),
    unknownSections,
    fileKindGuess,
    resultsSheet,
  };
}

interface OpenSection {
  source: 'label' | 'implicit' | 'unknown';
  approval: 'approved' | 'non-approved' | null;
  kind: SectionKind | null;
  /** Folded key of a known label (duplicate / order checks), null otherwise. */
  key: string | null;
  label: string;
  labelRow: number | null;
  headerSeen: boolean;
  rows: number;
}

/**
 * Parses a DC "Final Results" workbook (S-01..S-08) by structure: every sheet is scanned for the result header row, the
 * metadata is found by label, columns are mapped from each header row, sections come from their labels (an implicit
 * first section when the first label is absent), and DISP is classified per row. Never throws. Errors (which block the
 * import) only for: not a workbook, a request workbook, no header row anywhere, no NAME column, no readable row.
 */
export function parseFinalResults(bytes: Uint8Array): ParsedFinalResults {
  const issues: ResponseIssue[] = [];
  const draft = emptyDraft();
  const opened = openWorkbook(bytes);
  if (!opened.ok) {
    issues.push(
      mk('S-01', 'PKG_NOT_XLSX', 'error', null, null, `The file is not a valid .xlsx workbook (${opened.reason}).`),
    );
    return finish(draft, issues, [], 'unknown', null);
  }
  const { pkg, info } = opened;
  const strings = loadSharedStrings(pkg, info);
  const sheets: { ref: SheetRef; sheet: Sheet }[] = [];
  for (const ref of info.sheets) {
    const sheet = loadSheet(pkg, ref, strings);
    if (sheet) sheets.push({ ref, sheet });
  }

  // S-01: a request workbook picked in the response importer is refused plainly.
  if (hasRequestSheetSet(info.sheets) || sheets.some((s) => hasUnitsMarker(s.sheet))) {
    issues.push(mk('S-01', 'LOOKS_LIKE_REQUEST', 'error', null, null, LOOKS_LIKE_REQUEST_MESSAGE));
    return finish(draft, issues, [], 'investc-request', null);
  }

  // S-01: the results sheet is the first sheet (workbook order, hidden ones included) with a header row.
  let found: { ref: SheetRef; sheet: Sheet; headerRow: number } | null = null;
  for (const s of sheets) {
    const h = firstHeaderRow(s.sheet);
    if (h !== null) {
      found = { ...s, headerRow: h };
      break;
    }
  }
  if (!found) {
    issues.push(
      mk(
        'S-01',
        'RESULTS_SHEET_NOT_FOUND',
        'error',
        null,
        null,
        'No sheet has the DC result header row (DISP, NAME, DOB, POB, UNIT TYPE, UNIT NAME, CERT DATE, EXPIRES).',
      ),
    );
    return finish(draft, issues, [], 'unknown', null);
  }
  const { sheet, ref, headerRow } = found;
  const sheetName = ref.name;
  const rowRef = (r: number): string => finalResultsRowRef(r, sheetName);

  // S-07: other sheets and a hidden results sheet are information only.
  const others = info.sheets.filter((s) => s !== ref);
  if (others.length > 0) {
    const hidden = others.filter((s) => s.state !== 'visible').length;
    issues.push(
      mk(
        'S-07',
        'EXTRA_SHEETS',
        'info',
        null,
        null,
        `Results read from sheet "${sheetName}"; ${others.length} other sheet(s) ignored${hidden > 0 ? ` (${hidden} hidden)` : ''}: ${others.map((s) => `"${s.name}"`).join(', ')}.`,
      ),
    );
  }
  if (ref.state !== 'visible') {
    issues.push(mk('S-07', 'EXTRA_SHEETS', 'info', null, null, `The results sheet "${sheetName}" is hidden.`));
  }

  // S-08: metadata by label above the first header row.
  const meta = findMetadata(sheet, headerRow - 1);
  const metaRows = new Set(Object.values(meta).map((m) => m.row));
  const missing = (label: string, severity: 'warning' | 'info', what: string): void => {
    issues.push(
      mk(
        'S-08',
        'META_LABEL_MISSING',
        severity,
        null,
        label,
        `The "${label}" line was not found above the results; ${what}.`,
      ),
    );
  };
  if (meta.resultsAsOf) {
    const text = meta.resultsAsOf.value;
    draft.resultsAsOf = parseUsDate(text);
    if (draft.resultsAsOf === null) {
      issues.push(
        mk(
          'S-03',
          'DATE_UNPARSEABLE',
          'warning',
          rowRef(meta.resultsAsOf.row),
          col(meta.resultsAsOf.col),
          'The "Final Results as of" date is not a valid M/D/YYYY date.',
        ),
      );
    }
  } else missing('Final Results as of', 'warning', 'the results date is unknown');
  if (meta.post) draft.post = meta.post.value;
  else missing('Post:', 'info', 'the post is left empty');
  if (meta.batchId) {
    const v = meta.batchId.value.toUpperCase();
    if (BATCH_ID_RE.test(v)) draft.batchId = v;
    else
      issues.push(
        mk(
          'S-08',
          'META_LABEL_MISSING',
          'warning',
          rowRef(meta.batchId.row),
          'Batch ID:',
          'The "Batch ID:" line holds no id of the form ABCD-0000000000; enter the batch id by hand.',
        ),
      );
  } else missing('Batch ID:', 'warning', 'enter the batch id by hand');
  if (meta.assistance) draft.assistanceLine = meta.assistance.value;
  else missing('Assistance:', 'info', 'the event is not proposed automatically');

  // S-02 / S-06: sections, header rows, data rows.
  const unknownSections: string[] = [];
  const seenKeys = new Map<string, number>();
  const order: string[] = [];
  const reported = new Set<string>();
  let map: ColumnMap | null = null;
  let open: OpenSection | null = null;
  let anySection = false;
  let blanks = 0;

  const close = (): void => {
    if (open && open.rows === 0 && open.source !== 'implicit') {
      issues.push(
        mk(
          'S-06',
          'SECTION_EMPTY',
          'info',
          open.labelRow === null ? null : rowRef(open.labelRow),
          null,
          `Section "${open.label || '(no label)'}" has no rows.`,
        ),
      );
    }
    open = null;
  };
  const columnIssues = (r: number, m: ColumnMap): void => {
    for (const h of m.missing) {
      const severity = h === 'NAME' ? 'error' : h === 'DISP' || h === 'DOB' || h === 'UNIT NAME' ? 'warning' : 'info';
      const k = `missing|${h}`;
      if (reported.has(k)) continue;
      reported.add(k);
      issues.push(
        mk(
          'S-02',
          'HEADER_COLUMN_MISSING',
          severity,
          rowRef(r),
          h,
          h === 'NAME'
            ? 'The header row has no NAME column; the rows cannot be read.'
            : `The header row has no ${h} column; that value is left empty.`,
        ),
      );
    }
    for (const x of m.extra) {
      const k = `extra|${x.text.toUpperCase()}`;
      if (reported.has(k)) continue;
      reported.add(k);
      issues.push(
        mk(
          'S-07',
          'HEADER_COLUMN_EXTRA',
          'info',
          rowRef(r),
          col(x.col),
          `Column ${col(x.col)} ("${x.text.slice(0, 40)}") is not a DC result column and is ignored.`,
        ),
      );
    }
  };
  const nextNonEmptyIsHeader = (r: number): boolean => {
    for (const n of sheet.rowNumbers()) {
      if (n <= r || sheet.isRowEmpty(n)) continue;
      return headerRowMap(sheet, n) !== null;
    }
    return false;
  };

  for (let r = 1; r <= sheet.maxRow; r++) {
    if (sheet.isRowEmpty(r)) {
      blanks++;
      if (open && open.headerSeen && blanks >= 2) close();
      continue;
    }
    blanks = 0;
    const hm = headerRowMap(sheet, r);
    if (hm) {
      columnIssues(r, hm);
      map = hm;
      const cur = open as OpenSection | null;
      if (cur === null || (cur.headerSeen && cur.rows > 0)) {
        close();
        if (!anySection) {
          open = {
            source: 'implicit',
            approval: 'approved',
            kind: 'unit',
            key: null,
            label: '',
            labelRow: null,
            headerSeen: true,
            rows: 0,
          };
          issues.push(
            mk(
              'S-06',
              'SECTION_IMPLICIT',
              'info',
              rowRef(r),
              null,
              'The first result rows have no section label; they are read as "Approved Unit/Commander" and each row keeps its own DISP.',
            ),
          );
        } else {
          open = {
            source: 'unknown',
            approval: null,
            kind: null,
            key: null,
            label: '',
            labelRow: r,
            headerSeen: true,
            rows: 0,
          };
          issues.push(
            mk(
              'S-06',
              'UNKNOWN_SECTION',
              'warning',
              rowRef(r),
              null,
              'A header row without a section label; its rows are classified by their DISP only.',
              '',
            ),
          );
        }
        anySection = true;
      } else cur.headerSeen = true;
      continue;
    }
    if (metaRows.has(r) && r < headerRow) continue;
    const cells = sheet.rowCells(r).filter((c) => c.text.trim() !== '');
    const first = cells[0];
    if (first && first.kind === 'string' && cells.length <= 2) {
      const lab = parseSectionLabel(first.text);
      const single = cells.length === 1;
      if (lab || (single && nextNonEmptyIsHeader(r))) {
        close();
        const raw = first.text.trim();
        if (lab) {
          const key = `${lab.approval}|${lab.kind}`;
          if (seenKeys.has(key)) {
            issues.push(
              mk(
                'S-02',
                'SECTION_DUPLICATE',
                'warning',
                rowRef(r),
                col(first.col),
                `Section "${raw}" appears more than once.`,
              ),
            );
          } else {
            seenKeys.set(key, r);
            order.push(key);
          }
          open = {
            source: 'label',
            approval: lab.approval,
            kind: lab.kind,
            key,
            label: raw,
            labelRow: r,
            headerSeen: false,
            rows: 0,
          };
        } else {
          unknownSections.push(raw);
          issues.push(
            mk(
              'S-06',
              'UNKNOWN_SECTION',
              'warning',
              rowRef(r),
              col(first.col),
              `Unknown section "${raw}". Its rows are kept and classified by their DISP; unclear ones go to review.`,
              raw,
            ),
          );
          open = {
            source: 'unknown',
            approval: null,
            kind: kindHint(raw),
            key: null,
            label: raw,
            labelRow: r,
            headerSeen: false,
            rows: 0,
          };
        }
        anySection = true;
        continue;
      }
    }
    // A data row.
    const sec = open as OpenSection | null;
    if (sec === null && map !== null && anySection) {
      issues.push(
        mk(
          'S-02',
          'ROW_INCOMPLETE',
          'warning',
          rowRef(r),
          null,
          'A row after two empty rows and outside any section is ignored.',
        ),
      );
      continue;
    }
    if (sec === null || map === null || map.cols.NAME === undefined) continue;
    const m = map;
    const text = (h: ResultColumn): string => {
      const c = m.cols[h];
      return c === undefined ? '' : sheet.text(r, c);
    };
    if (text('DISP').trim() === '' && text('NAME').trim() === '') {
      issues.push(
        mk(
          'S-02',
          'ROW_INCOMPLETE',
          'warning',
          rowRef(r),
          null,
          'A row with values but no DISP and no NAME is skipped.',
        ),
      );
      continue;
    }
    draft.rows.push(readRow(sheet, r, rowRef(r), m, sec, issues));
    sec.rows++;
  }
  close();

  if (draft.rows.length === 0 && !issues.some((i) => i.severity === 'error')) {
    issues.push(mk('S-02', 'NO_SECTIONS', 'error', null, null, 'No result rows were found.'));
  }
  const implicitUnit = draft.rows.some((x) => x.sectionSource === 'implicit');
  for (const s of SECTIONS) {
    const lab = parseSectionLabel(s.label)!;
    const key = `${lab.approval}|${lab.kind}`;
    if (seenKeys.has(key) || (implicitUnit && key === 'approved|unit')) continue;
    issues.push(mk('S-02', 'SECTION_MISSING', 'info', null, null, `Section "${s.label}" is missing.`));
  }
  const expectedOrder = SECTIONS.map((s) => {
    const lab = parseSectionLabel(s.label)!;
    return `${lab.approval}|${lab.kind}`;
  }).filter((k) => seenKeys.has(k));
  if (expectedOrder.join(',') !== order.join(',')) {
    issues.push(mk('S-02', 'SECTION_ORDER', 'info', null, null, 'Sections are not in the usual order.'));
  }
  return finish(draft, issues, unknownSections, 'dc-response', sheetName);
}

function readRow(
  sheet: Sheet,
  r: number,
  rowRef: string,
  map: ColumnMap,
  sec: OpenSection,
  issues: ResponseIssue[],
): DcResponseDraftRow {
  const colOf = (h: ResultColumn): number | undefined => map.cols[h];
  const text = (h: ResultColumn): string => {
    const c = colOf(h);
    return c === undefined ? '' : sheet.text(r, c);
  };
  const cell = (h: ResultColumn): Cell | undefined => {
    const c = colOf(h);
    return c === undefined ? undefined : sheet.cell(r, c);
  };
  const field = (h: ResultColumn): string | null => {
    const c = colOf(h);
    return c === undefined ? null : col(c);
  };
  const disp = text('DISP');
  const nameRaw = text('NAME');
  const sn = splitName(nameRaw);
  if (nameRaw.trim() === '') {
    issues.push(mk('S-04', 'NAME_EMPTY', 'warning', rowRef, field('NAME'), 'NAME is empty.'));
  } else if (!sn.hasComma && !sn.unknownCommander) {
    issues.push(
      mk(
        'S-04',
        'NAME_NO_COMMA',
        'warning',
        rowRef,
        field('NAME'),
        'NAME has no comma; the whole text is taken as the surname.',
      ),
    );
  }
  const script = detectScript(nameRaw);
  if (script === 'Mixed') {
    issues.push(
      mk(
        'S-04',
        'NAME_MIXED_SCRIPT',
        'info',
        rowRef,
        field('NAME'),
        'NAME mixes Latin and another script; only the Latin part can confirm a match on its own.',
      ),
    );
  }
  const name: PersonName = { surname: sn.surname, given: sn.given, raw: nameRaw, script };
  const dob = rawDateFromResponseCell(cell('DOB'));
  const certDate = rawDateFromResponseCell(cell('CERT DATE'));
  const expires = rawDateFromResponseCell(cell('EXPIRES'));
  for (const [d, h] of [
    [dob, 'DOB'],
    [certDate, 'CERT DATE'],
    [expires, 'EXPIRES'],
  ] as const) {
    if (d.kind !== 'empty' && d.parsed === null) {
      issues.push(
        mk('S-03', 'DATE_UNPARSEABLE', 'warning', rowRef, field(h), `${h} "${d.value}" is not a valid M/D/YYYY date.`),
      );
    }
  }
  const { pob, parts } = splitPob(text('POB'));
  if (parts > 3)
    issues.push(
      mk(
        'S-05',
        'POB_TOO_MANY_PARTS',
        'warning',
        rowRef,
        field('POB'),
        'POB has more than three parts; the middle parts are joined as the state.',
      ),
    );

  // S-06: disposition.
  const reading = classifyDisp(disp);
  const d = resolveDisposition(reading, {
    source: sec.source,
    approval: sec.approval,
  });
  if (d.problem === 'unrecognised') {
    issues.push(
      mk(
        'S-06',
        'DISP_UNRECOGNISED',
        'warning',
        rowRef,
        field('DISP'),
        reading === 'blank'
          ? 'DISP is empty and the section does not state a disposition; the row goes to review.'
          : 'DISP is not a known disposition (Approve, Approved, Not Approved, Disapprove ...); the row goes to review.',
      ),
    );
  } else if (d.problem === 'conflict') {
    issues.push(
      mk(
        'S-06',
        'DISP_SECTION_CONFLICT',
        'warning',
        rowRef,
        field('DISP'),
        `DISP says ${reading} but the row is in the section "${sec.label}"; the row goes to review.`,
      ),
    );
  }
  const kind: SectionKind = sec.kind ?? (sn.unknownCommander ? 'unit' : 'individual');
  return {
    rowRef,
    section: sectionOf(kind, d.dispClass),
    dispClass: d.dispClass,
    sectionSource: sec.source === 'implicit' ? 'implicit' : 'label',
    disp,
    nameRaw,
    name,
    unknownCommander: sn.unknownCommander,
    dob,
    pob,
    unitType: text('UNIT TYPE').trim(),
    unitName: text('UNIT NAME').trim(),
    certDate,
    expires,
  };
}
