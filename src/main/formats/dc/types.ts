import type { IsoDate, PersonName, PlaceOfBirth, RawDate, ResponseSection } from '../../../shared/domain/types.ts';

export type ResponseRuleId = 'S-01' | 'S-02' | 'S-03' | 'S-04' | 'S-05' | 'S-06' | 'S-07';

export type ResponseIssueCode =
  | 'PKG_NOT_XLSX'
  | 'SHEET_MISSING'
  | 'HEADER_CELL_MISMATCH'
  | 'SECTION_HEADER_MISMATCH'
  | 'SECTION_MISSING'
  | 'SECTION_DUPLICATE'
  | 'SECTION_ORDER'
  | 'NO_SECTIONS'
  | 'ROW_INCOMPLETE'
  | 'DATE_UNPARSEABLE'
  | 'NAME_NO_COMMA'
  | 'NAME_EMPTY'
  | 'POB_TOO_MANY_PARTS'
  | 'UNKNOWN_SECTION'
  | 'EXTRA_SHEETS';

/** Issue raised while parsing a DC response workbook. The domain ValidationCode union has no response codes. */
export interface ResponseIssue {
  rule: ResponseRuleId;
  code: ResponseIssueCode;
  severity: 'error' | 'warning' | 'info';
  rowRef: string | null;
  field: string | null;
  message: string;
  /** For UNKNOWN_SECTION: the label exactly as found in the workbook. */
  rawLabel?: string;
}

/** A response row before ids and matching exist: everything the file says, nothing the app decided. */
export interface DcResponseDraftRow {
  rowRef: string;
  section: ResponseSection;
  /** DISP cell, verbatim. */
  disp: string;
  /** NAME cell, verbatim (trailing spaces and all). */
  nameRaw: string;
  name: PersonName;
  /** NAME surname part is UNKNOWN: the commander is not named. */
  unknownCommander: boolean;
  dob: RawDate;
  pob: PlaceOfBirth;
  unitType: string;
  unitName: string;
  certDate: RawDate;
  expires: RawDate;
}

/** DcResponse without ids, source file, import time, request link and match state. */
export interface DcResponseDraft {
  batchId: string | null;
  post: string | null;
  resultsAsOf: IsoDate | null;
  assistanceLine: string | null;
  rows: DcResponseDraftRow[];
}

export interface ParsedFinalResults {
  draft: DcResponseDraft;
  issues: ResponseIssue[];
  /** True when any error issue exists: the import must not proceed (S-06 fail loudly). */
  blocked: boolean;
  /** Raw labels of sections that could not be mapped (also reported as UNKNOWN_SECTION issues). */
  unknownSections: string[];
}
