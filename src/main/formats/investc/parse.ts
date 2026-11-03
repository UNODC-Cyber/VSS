import type { ObservedPerson, ObservedUnit } from '../../../shared/domain/types.ts';
import { rawDateFromRequestCell } from './dob.ts';
import {
  EXPECTED_SHEETS,
  KNOWN_TEMPLATE_VERSIONS,
  MARKER_INDIVIDUALS,
  MARKER_SEPARATOR,
  MARKER_UNITS,
  PERSON_HEADERS,
  UNIT_HEADERS,
  VERSION_A2,
  VERSION_C2,
} from './layout.ts';
import { indexToCol } from '../ooxml/columns.ts';
import type { Sheet } from '../ooxml/sheet.ts';
import { loadSharedStrings, loadSheet, openWorkbook } from '../ooxml/workbook.ts';
import { bundledReference, readReferenceData } from './reference.ts';
import type { ParsedInvestc, RequestLayout, RuleIssue } from './types.ts';

const SHEET = 'Data';
export const dataRowRef = (row: number): string => `${SHEET}!${row}`;

function issue(
  rule: string,
  code: RuleIssue['code'],
  severity: RuleIssue['severity'],
  rowRef: string | null,
  field: string | null,
  message: string,
): RuleIssue {
  return { rule, code, severity, rowRef, field, message };
}

function emptyResult(issues: RuleIssue[]): ParsedInvestc {
  return {
    templateVersion: null,
    instructionsVersion: null,
    units: [],
    people: [],
    issues,
    reference: bundledReference(),
    layout: {
      firstUnitRow: 4,
      separatorRow: null,
      individualsRow: null,
      individualsHeaderRow: null,
      firstPersonRow: null,
      lastPersonRow: null,
    },
  };
}

function rowHasValue(sheet: Sheet, row: number, maxCol: number): boolean {
  return !sheet.isRowEmpty(row, 1, maxCol);
}

function parseBool(c: { kind: string; bool?: boolean; text: string; num?: number } | undefined): boolean | null {
  if (!c || c.kind === 'blank') return null;
  if (c.kind === 'boolean') return c.bool ?? null;
  if (c.kind === 'number') return c.num === 1 ? true : c.num === 0 ? false : null;
  const t = c.text.trim().toLowerCase();
  if (t === 'true') return true;
  if (t === 'false') return false;
  return null;
}

function checkHeaders(
  sheet: Sheet,
  row: number,
  expected: readonly string[],
  rule: string,
  issues: RuleIssue[],
  what: string,
): void {
  expected.forEach((h, i) => {
    const got = sheet.text(row, i + 1).trim();
    if (got !== h) {
      issues.push(
        issue(
          rule,
          'HEADER_MISMATCH',
          'error',
          dataRowRef(row),
          indexToCol(i + 1),
          `${what} header in column ${indexToCol(i + 1)} should be "${h}" but is "${got}".`,
        ),
      );
    }
  });
}

/**
 * Parses an INVESTc request workbook. Blocks are found by marker text, never by fixed row numbers.
 * Never throws: every problem is reported as an issue and whatever could be read is still returned.
 */
export function parseInvestc(bytes: Uint8Array): ParsedInvestc {
  const opened = openWorkbook(bytes);
  if (!opened.ok) {
    return emptyResult([
      issue('R-01', 'PKG_NOT_XLSX', 'error', null, null, `The file is not a valid .xlsx workbook (${opened.reason}).`),
    ]);
  }
  const { pkg, info } = opened;
  const issues: RuleIssue[] = [];

  // R-01: sheet names/order exact; third hidden.
  const names = info.sheets.map((s) => s.name);
  const exact = names.length === EXPECTED_SHEETS.length && EXPECTED_SHEETS.every((n, i) => names[i] === n);
  if (!exact) {
    issues.push(
      issue(
        'R-01',
        'PKG_SHEETS_MISMATCH',
        'error',
        null,
        null,
        `Expected sheets ${EXPECTED_SHEETS.map((n) => `"${n}"`).join(', ')} in that order but found ${names.map((n) => `"${n}"`).join(', ') || 'none'}.`,
      ),
    );
  } else if (info.sheets[2]?.state !== 'hidden') {
    issues.push(
      issue(
        'R-01',
        'PKG_SHEETS_MISMATCH',
        'warning',
        null,
        null,
        'The "Reference Data" sheet is expected to be hidden.',
      ),
    );
  }

  const sst = loadSharedStrings(pkg, info);
  const refOf = (n: string) => info.sheets.find((s) => s.name === n) ?? null;
  const dataRef = refOf('Data');
  const dataSheet = dataRef ? loadSheet(pkg, dataRef, sst) : null;
  if (!dataSheet) return emptyResult(issues);
  const instrRef = refOf('Template Instructions');
  const instr = instrRef ? loadSheet(pkg, instrRef, sst) : null;
  const refRef = refOf('Reference Data');
  const refSheet = refRef ? loadSheet(pkg, refRef, sst) : null;
  const reference = readReferenceData(refSheet, instr);

  // R-02: template version.
  const a2 = instr?.text(2, 1).trim() ?? '';
  const c2 = instr?.text(2, 3).trim() ?? '';
  const ma = VERSION_A2.exec(a2);
  const mc = VERSION_C2.exec(c2);
  const templateVersion = mc ? (mc[1] as string) : null;
  const instructionsVersion = ma ? (ma[1] as string) : null;
  if (!ma || !mc) {
    issues.push(
      issue(
        'R-02',
        'TEMPLATE_VERSION_UNKNOWN',
        'warning',
        null,
        !mc ? 'Template Instructions!C2' : 'Template Instructions!A2',
        'The template version cells were not recognised; the file is read as if it were the current template.',
      ),
    );
  } else if (!KNOWN_TEMPLATE_VERSIONS.includes(templateVersion as string)) {
    issues.push(
      issue(
        'R-02',
        'TEMPLATE_VERSION_UNKNOWN',
        'warning',
        null,
        'Template Instructions!C2',
        `Template version ${templateVersion} is newer or different from the versions this app knows (${KNOWN_TEMPLATE_VERSIONS.join(', ')}); the file is read as if it were the current template.`,
      ),
    );
  }

  // R-03: UNITS marker and unit header row.
  if (dataSheet.text(1, 1).trim() !== MARKER_UNITS) {
    issues.push(
      issue('R-03', 'HEADER_MISMATCH', 'error', dataRowRef(1), 'A', `Cell A1 should read "${MARKER_UNITS}".`),
    );
  }
  checkHeaders(dataSheet, 3, UNIT_HEADERS, 'R-03', issues, 'Unit');

  // R-04: separator and INDIVIDUALS markers.
  const maxRow = dataSheet.maxRow;
  let sep: number | null = null;
  for (let r = 4; r <= maxRow; r++) {
    if (dataSheet.rowCells(r).some((c) => c.text.trim().toUpperCase() === MARKER_SEPARATOR)) {
      sep = r;
      break;
    }
  }
  let ind: number | null = null;
  for (let r = (sep ?? 3) + 1; r <= maxRow; r++) {
    if (dataSheet.text(r, 1).trim().toUpperCase() === MARKER_INDIVIDUALS) {
      ind = r;
      break;
    }
  }
  if (sep === null) {
    issues.push(
      issue(
        'R-04',
        'MARKER_MISSING',
        'error',
        null,
        null,
        `The "${MARKER_SEPARATOR}" separator row was not found below the units.`,
      ),
    );
  }
  if (ind === null) {
    issues.push(
      issue('R-04', 'MARKER_MISSING', 'error', null, null, `The "${MARKER_INDIVIDUALS}" marker row was not found.`),
    );
  }

  // Units: rows 4 .. separator (or INDIVIDUALS marker) exclusive.
  const units: ObservedUnit[] = [];
  const unitEnd = sep ?? ind ?? maxRow + 1;
  for (let r = 4; r < unitEnd; r++) {
    if (!rowHasValue(dataSheet, r, 13)) continue;
    const t = (c: number): string => dataSheet.text(r, c);
    units.push({
      rowRef: dataRowRef(r),
      name: t(1),
      unitIdNo: t(2),
      type: t(3),
      alias: t(4),
      location: t(5),
      description: t(6),
      englishDescription: t(7),
      branchName: t(8),
      branchDescription: t(9),
      parentOrg: t(10),
      subordinateOrg: t(11),
      orgLevel: t(12),
      country: t(13),
    });
  }

  // R-05: individuals header row and rows.
  const people: ObservedPerson[] = [];
  let hdr: number | null = null;
  let lastPerson: number | null = null;
  if (ind !== null) {
    for (let r = ind + 1; r <= Math.min(maxRow, ind + 10); r++) {
      if (dataSheet.text(r, 1).trim() === PERSON_HEADERS[0]) {
        hdr = r;
        break;
      }
    }
    if (hdr === null) {
      issues.push(
        issue(
          'R-05',
          'HEADER_MISMATCH',
          'error',
          dataRowRef(ind),
          'A',
          `The individuals header row (starting "${PERSON_HEADERS[0]}") was not found below the "${MARKER_INDIVIDUALS}" marker.`,
        ),
      );
    } else {
      checkHeaders(dataSheet, hdr, PERSON_HEADERS, 'R-05', issues, 'Individuals');
      let blanks = 0;
      for (let r = hdr + 1; r <= maxRow; r++) {
        if (!rowHasValue(dataSheet, r, 19)) {
          blanks += 1;
          if (blanks >= 2) break;
          continue;
        }
        blanks = 0;
        lastPerson = r;
        const t = (c: number): string => dataSheet.text(r, c);
        people.push({
          rowRef: dataRowRef(r),
          unitName: t(1),
          isHeadOfUnit: parseBool(dataSheet.cell(r, 2)),
          surname: t(3),
          name1: t(4),
          name2: t(5),
          name3: t(6),
          name4: t(7),
          passport: t(8),
          nationalId: t(9),
          titleRank: t(10),
          fatherName: t(11),
          motherName: t(12),
          dob: rawDateFromRequestCell(dataSheet.cell(r, 13)),
          pobCity: t(14),
          pobState: t(15),
          pobCountry: t(16),
          nationality: t(17),
          searchCountry: t(18),
          sex: t(19),
        });
      }
    }
  }

  const layout: RequestLayout = {
    firstUnitRow: 4,
    separatorRow: sep,
    individualsRow: ind,
    individualsHeaderRow: hdr,
    firstPersonRow: hdr === null ? null : hdr + 1,
    lastPersonRow: lastPerson,
  };
  return { templateVersion, instructionsVersion, units, people, issues, reference, layout };
}
