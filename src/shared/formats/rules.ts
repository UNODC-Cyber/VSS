/** Registry of every rule id in docs/FILE-FORMATS.md. A unit test keeps this file and the document in sync. */
import type { ValidationCode } from '../domain/types';

export type RuleSeverity = 'error' | 'warning' | 'info';
export type RuleGroup = 'request' | 'export' | 'response';

export interface RuleDef {
  id: string;
  group: RuleGroup;
  /** Highest severity the rule can raise (some rules raise a lighter one in specific cases). */
  severity: RuleSeverity;
  description: string;
  /** Validation codes the rule can emit (parse/validate rules only). */
  codes: readonly ValidationCode[];
}

const make =
  (group: RuleGroup) =>
  (id: string, severity: RuleSeverity, description: string, codes: readonly ValidationCode[] = []): RuleDef => ({
    id,
    group,
    severity,
    description,
    codes,
  });
const R = make('request');
const X = make('export');
const S = make('response');

export const RULES: readonly RuleDef[] = [
  R(
    'R-01',
    'error',
    'Zip package with [Content_Types].xml and xl/workbook.xml; sheet names/order exact; third sheet hidden (warn if not).',
    ['PKG_NOT_XLSX', 'PKG_SHEETS_MISMATCH'],
  ),
  R(
    'R-02',
    'warning',
    'Template version cells match the expected patterns; unknown version continues with a warning.',
    ['TEMPLATE_VERSION_UNKNOWN'],
  ),
  R('R-03', 'error', 'Data!A1 is UNITS and the unit header row matches exactly.', ['HEADER_MISMATCH']),
  R('R-04', 'error', 'Unit rows run from row 4 to the LEAVE A ROW BLANK separator; markers must exist.', [
    'MARKER_MISSING',
  ]),
  R('R-05', 'error', 'Individuals header row has the 19 headers; rows end at two consecutive empty rows.', [
    'HEADER_MISMATCH',
    'MARKER_MISSING',
  ]),
  R('R-06', 'error', 'Required fields present for units and individuals.', ['REQUIRED_MISSING']),
  R('R-07', 'error', 'Unit type, sex and country values come from the reference lists (case differences warn).', [
    'UNIT_TYPE_INVALID',
    'SEX_INVALID',
    'COUNTRY_NOT_IN_LIST',
  ]),
  R('R-08', 'error', 'DOB parsing: serial or text; ambiguous day/month warns; under 18 or future is an error.', [
    'DOB_INVALID',
    'DOB_TEXT',
    'DOB_AMBIGUOUS_DM',
    'DOB_UNDER_18',
    'DOB_FUTURE',
  ]),
  R(
    'R-09',
    'error',
    'Each individual unit must be a declared unit; unused units warn; duplicate unit names are errors.',
    ['UNIT_NOT_DECLARED', 'UNIT_UNUSED', 'UNIT_DUPLICATE'],
  ),
  R('R-10', 'error', 'Exactly one head of unit per unit (none warns, several is an error).', [
    'HEAD_OF_UNIT_NONE',
    'HEAD_OF_UNIT_MULTIPLE',
  ]),
  R('R-11', 'error', 'Passport or national ID present requires a nationality.', ['ID_WITHOUT_NATIONALITY']),
  R('R-12', 'error', 'Character limits per field are respected.', ['CHAR_LIMIT']),
  R('R-13', 'error', 'Two rows with equal core name key and DOB: the later row is a duplicate.', ['DUPLICATE_ROW']),
  R('R-14', 'warning', 'A name field starting with an honorific or rank is flagged.', ['NAME_HAS_HONORIFIC']),
  R(
    'R-15',
    'warning',
    'Expectation checks against the database: unseen unit, known-person mismatches, non-approved person.',
    [
      'UNEXPECTED_UNIT',
      'PERSON_KNOWN_NAME_MISMATCH',
      'PERSON_KNOWN_DOB_MISMATCH',
      'PERSON_KNOWN_ID_MISMATCH',
      'PERSON_NON_APPROVED',
    ],
  ),
  X('X-01', 'error', 'Exported workbook re-parses with zero errors (round trip).'),
  X(
    'X-02',
    'error',
    'Regenerate mode: base is the vault template (none shipped); all parts except sheet2, sharedStrings and docProps unchanged; creator VSS.',
  ),
  X(
    'X-03',
    'error',
    'Filter-original mode: after the package whitelist, all parts except sheet2, sharedStrings and core are unchanged.',
  ),
  X('X-04', 'error', 'Row map, dimension and merges re-anchored for the new unit and individual counts.'),
  X('X-05', 'error', 'Data validations rewritten for the new row ranges with correct counts and preserved uids.'),
  X(
    'X-06',
    'error',
    'Cell encoding: shared strings escaped and NFC, booleans, DOB serial with template style, empty optionals omitted.',
  ),
  X(
    'X-07',
    'error',
    'Only included items are written; units referenced by included individuals are kept; order preserved.',
  ),
  X(
    'X-08',
    'warning',
    'CI only: OpenXML SDK validator reports 0 errors and LibreOffice headless converts with exit 0.',
  ),
  X(
    'X-09',
    'error',
    'Package whitelist (F-05): only known parts kept; metadata parts dropped; unknown parts force regenerate from the vault template.',
  ),
  X(
    'X-10',
    'error',
    'Template capture: whitelist applied, every unit and individual row removed, document properties reset.',
  ),
  S('S-01', 'error', 'Sheet Final_Results with the four header cells matching their patterns.'),
  S(
    'S-02',
    'error',
    'Sections located by exact label, then the 8-column header row; data ends at an empty NAME and DISP.',
  ),
  S('S-03', 'warning', 'Dates are M/D/YYYY text or serial; otherwise parsed is null with a warning.'),
  S('S-04', 'warning', 'NAME is split at the first comma; UNKNOWN surname means an unknown commander.'),
  S('S-05', 'warning', 'POB is split on " - " into city, state, country with blanks as null.'),
  S(
    'S-06',
    'error',
    'Disposition derives from the section; an unknown section label blocks the import and is shown raw.',
  ),
  S('S-07', 'warning', 'Hidden or extra columns are ignored; extra sheets warn.'),
];

export const RULE_IDS: readonly string[] = RULES.map((r) => r.id);
export const RULES_BY_ID: ReadonlyMap<string, RuleDef> = new Map(RULES.map((r) => [r.id, r]));
