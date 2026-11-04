// VSS core domain model. Source of truth for every lane. Change only via the contracts owner.
export type IsoDate = string; // 'YYYY-MM-DD'
export type IsoDateTime = string; // UTC ISO-8601
export type Ulid = string; // 26-char ULID; every entity id

export type Script = 'Latn' | 'Thai' | 'Khmr' | 'Laoo' | 'Mymr' | 'Hani' | 'Other' | 'Mixed';
export type Sex = 'M' | 'F';
export type UnitType = 'Military' | 'Other' | 'Police' | 'Prison';

export interface PersonName {
  surname: string;
  given: string[];
  raw: string;
  script: Script;
}
export interface NameKey {
  fullTokens: string[]; // folded, sorted multiset incl. particles
  coreTokens: string[]; // without particles/honorifics, variants canonicalised
  particles: string[];
  phonetic: string[];
  folded: string; // search blob fragment
}
export type DobPrecision = 'exact' | 'ambiguous-dm' | 'year-only' | 'unknown';
export interface PlaceOfBirth {
  city: string | null;
  state: string | null;
  country: string | null;
}
export interface Identifier {
  type: 'passport' | 'national-id';
  value: string;
  valueFolded: string;
  issuingCountry: string | null;
}

export interface Person {
  id: Ulid;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  canonical: PersonName;
  aliases: PersonName[];
  dob: IsoDate | null;
  dobPrecision: DobPrecision;
  sex: Sex | null;
  pob: PlaceOfBirth;
  nationality: string | null;
  identifiers: Identifier[];
  state: 'active' | 'merged' | 'purged';
  mergedInto: Ulid | null;
  notes: string;
}

export interface Unit {
  id: Ulid;
  name: string;
  type: UnitType;
  country: string;
  unitIdNo: string | null;
  alias: string | null;
  location: string | null;
  description: string | null;
  englishDescription: string | null;
  branchName: string | null;
  branchDescription: string | null;
  parentOrg: string | null;
  subordinateOrg: string | null;
  orgLevel: string | null;
  aliases: string[];
}

export interface RawDate {
  kind: 'serial' | 'text' | 'empty';
  value: string;
  parsed: IsoDate | null;
  ambiguousDayMonth: boolean;
}

/** Exactly one INVESTc individual row, verbatim. */
export interface ObservedPerson {
  rowRef: string;
  unitName: string;
  isHeadOfUnit: boolean | null;
  surname: string;
  name1: string;
  name2: string;
  name3: string;
  name4: string;
  passport: string;
  nationalId: string;
  titleRank: string;
  fatherName: string;
  motherName: string;
  dob: RawDate;
  pobCity: string;
  pobState: string;
  pobCountry: string;
  nationality: string;
  searchCountry: string;
  sex: string;
}
export interface ObservedUnit {
  rowRef: string;
  name: string;
  unitIdNo: string;
  type: string;
  alias: string;
  location: string;
  description: string;
  englishDescription: string;
  branchName: string;
  branchDescription: string;
  parentOrg: string;
  subordinateOrg: string;
  orgLevel: string;
  country: string;
}

export type ValidationCode =
  | 'PKG_NOT_XLSX' | 'PKG_SHEETS_MISMATCH' | 'TEMPLATE_VERSION_UNKNOWN' | 'HEADER_MISMATCH' | 'MARKER_MISSING'
  | 'REQUIRED_MISSING' | 'CHAR_LIMIT' | 'UNIT_DUPLICATE' | 'UNIT_TYPE_INVALID' | 'UNIT_NOT_DECLARED' | 'UNIT_UNUSED'
  | 'COUNTRY_NOT_IN_LIST' | 'DOB_INVALID' | 'DOB_TEXT' | 'DOB_AMBIGUOUS_DM' | 'DOB_UNDER_18' | 'DOB_FUTURE'
  | 'SEX_INVALID' | 'ID_WITHOUT_NATIONALITY' | 'ID_FORMAT_SUSPECT' | 'HEAD_OF_UNIT_NONE' | 'HEAD_OF_UNIT_MULTIPLE'
  | 'DUPLICATE_ROW' | 'NAME_HAS_HONORIFIC' | 'NAME_EMPTY_GIVEN' | 'UNEXPECTED_UNIT' | 'UNEXPECTED_SCRIPT'
  | 'PERSON_KNOWN_NAME_MISMATCH' | 'PERSON_KNOWN_DOB_MISMATCH' | 'PERSON_KNOWN_ID_MISMATCH' | 'PERSON_NON_APPROVED'
  // Alpha 1 (lane C, structure-based DC response parser): response issue codes passed through 1:1.
  | 'LOOKS_LIKE_REQUEST' | 'RESULTS_SHEET_NOT_FOUND' | 'META_LABEL_MISSING' | 'HEADER_COLUMN_MISSING'
  | 'HEADER_COLUMN_EXTRA' | 'SECTION_IMPLICIT' | 'SECTION_EMPTY' | 'DISP_UNRECOGNISED' | 'DISP_SECTION_CONFLICT'
  | 'NAME_MIXED_SCRIPT';
export interface ValidationIssue {
  code: ValidationCode;
  severity: 'error' | 'warning' | 'info';
  rowRef: string | null;
  field: string | null;
  message: string;
}

export type VettingStatus = 'unknown' | 'pending' | 'approved' | 'expiring' | 'expired' | 'non-approved';
export interface VettingStatusSnapshot {
  status: VettingStatus;
  certDate: IsoDate | null;
  expiresAt: IsoDate | null;
  unitId: Ulid | null;
  source: Ulid | null;
  asOf: IsoDate;
}

export type LinkState = 'auto' | 'confirmed' | 'pending-review' | 'unlinked' | 'new-person';
export type ExportDecision = 'include' | 'exclude' | 'manual-include' | 'manual-exclude';

export interface RequestItem {
  id: Ulid;
  requestId: Ulid;
  observed: ObservedPerson;
  nameKey: NameKey;
  personId: Ulid | null;
  linkState: LinkState;
  unitId: Ulid | null;
  issues: ValidationIssue[];
  prior: VettingStatusSnapshot | null;
  exportDecision: ExportDecision;
  exportReason: string;
}
export interface Requestor {
  /** Alpha 1 (lane B): the saved requestor record this request uses; absent = not linked / new requestor. */
  id?: Ulid;
  name: string;
  email: string | null;
  organisation: string | null;
  phone?: string | null;
  notes?: string;
}
/** A saved, de-duplicated requestor (lane B). Requestors are staff, not vetted persons: person purge never touches them. */
export interface RequestorRecord {
  id: Ulid;
  name: string;
  email: string | null;
  organisation: string | null;
  phone: string | null;
  notes: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /** Requests that use this record. */
  requestCount: number;
  lastUsedAt: IsoDateTime | null;
}
/** 'finished' (lane D) is derived: every item has an outcome; never set by hand. */
export type RequestStatus =
  | 'received' | 'validated' | 'exported' | 'sent-to-dc' | 'responded' | 'finished' | 'closed' | 'withdrawn';
export interface StoredFile {
  id: Ulid;
  originalName: string;
  sha256: string;
  bytes: number;
  storedAt: IsoDateTime;
}
export interface VettingRequest {
  id: Ulid;
  kind: 'file' | 'manual';
  receivedAt: IsoDateTime;
  requestor: Requestor;
  eventName: string;
  eventStart: IsoDate | null;
  eventEnd: IsoDate | null;
  eventLocation: string | null;
  sourceFile: StoredFile | null;
  templateVersion: string | null;
  units: ObservedUnit[];
  items: RequestItem[];
  status: RequestStatus;
  sentToDcAt: IsoDateTime | null;
  respondedAt: IsoDateTime | null;
  responseKind: 'dc-file' | 'email-clearance' | null;
  batchId: string | null;
  notes: string;
  /** Alpha 1 lifecycle (lane D): when the request became Finished / was Closed; null otherwise. */
  finishedAt: IsoDateTime | null;
  closedAt: IsoDateTime | null;
  /** Manager's close note (kept on the row, never in the audit text); '' when none. */
  closeNote: string;
  reopenCount: number;
}

export type ResponseSection = 'approved-unit' | 'approved-individual' | 'nonapproved-unit' | 'nonapproved-individual';
export type MatchTier = 'T1' | 'T2' | 'T3' | 'T4';
export type MatchEvidence =
  | 'NAME_CORE_EQUAL' | 'NAME_FULL_EQUAL' | 'NAME_SUBSET_1' | 'NAME_SURNAME_EQUAL' | 'NAME_JW_HIGH' | 'NAME_PHONETIC_EQUAL'
  | 'DOB_EQUAL' | 'DOB_SWAPPED' | 'DOB_YEAR_EQUAL' | 'DOB_CONFLICT' | 'DOB_MISSING'
  | 'POB_COUNTRY_EQUAL' | 'POB_CONFLICT' | 'UNIT_EQUAL' | 'UNIT_CONFLICT' | 'ID_EQUAL' | 'ID_CONFLICT' | 'SEX_CONFLICT'
  // security review F-06: place of birth below country level, placeholder DOBs, father's name
  | 'POB_PLACE_EQUAL' | 'POB_PLACE_CONFLICT' | 'DOB_PLACEHOLDER' | 'FATHER_CONFLICT'
  // Alpha 1 (lane C): non-Latin given-name tokens differ (caps at T2) / present on one side only (information).
  | 'NAME_SCRIPT_CONFLICT' | 'NAME_SCRIPT_IGNORED';
export interface MatchCandidate {
  targetKind: 'request-item' | 'person';
  targetId: Ulid;
  tier: MatchTier;
  evidence: MatchEvidence[];
  score: number;
}
export interface RowMatch {
  candidates: MatchCandidate[];
  decision: 'auto' | 'confirmed' | 'pending' | 'rejected' | 'none';
  chosen: Ulid | null;
  decidedBy: string | null;
  decidedAt: IsoDateTime | null;
}
export interface ResponseRow {
  id: Ulid;
  responseId: Ulid;
  rowRef: string;
  section: ResponseSection;
  disp: string;
  nameRaw: string;
  name: PersonName;
  nameKey: NameKey;
  dob: RawDate;
  pob: PlaceOfBirth;
  unitType: string;
  unitName: string;
  certDate: RawDate;
  expires: RawDate;
  match: RowMatch;
  /** Alpha 1 (lane C): DISP classified, never guessed; 'unknown' rows become a disposition-unclear review item. */
  dispClass: DispClass;
  /** 'implicit' when the section had no label row (first section without a label). */
  sectionSource: SectionSource;
}
export type DispClass = 'approved' | 'non-approved' | 'unknown';
export type SectionSource = 'label' | 'implicit';
export interface DcResponse {
  id: Ulid;
  batchId: string;
  post: string;
  resultsAsOf: IsoDate;
  assistanceLine: string;
  sourceFile: StoredFile;
  importedAt: IsoDateTime;
  requestId: Ulid | null;
  rows: ResponseRow[];
}

export interface VettingRecord {
  id: Ulid;
  personId: Ulid;
  unitId: Ulid | null;
  requestId: Ulid | null;
  responseRowId: Ulid | null;
  disposition: 'approved' | 'non-approved' | 'email-cleared';
  certDate: IsoDate | null;
  expiresAt: IsoDate | null;
  /** true when expiresAt was defaulted by policy (email-only clearance, default 30 days) rather than stated by a source. */
  expiryAssumed: boolean;
  source: 'dc-file' | 'email' | 'manual';
  recordedAt: IsoDateTime;
  recordedBy: string;
  note: string;
}
export interface UnitVettingRecord {
  id: Ulid;
  unitId: Ulid;
  requestId: Ulid;
  responseRowId: Ulid | null;
  commanderPersonId: Ulid | null;
  disposition: 'approved' | 'non-approved';
  certDate: IsoDate | null;
  expiresAt: IsoDate | null;
  recordedAt: IsoDateTime;
}

export interface ExportPolicy {
  includeUnknown: true;
  includePending: boolean;
  includeExpired: true;
  expiringWithinDays: number; // default 30 (owner decision 2026-11-03)
  includeUnitChanged: boolean;
  includeNonApproved: boolean;
  includeFlaggedUnresolved: 'include' | 'exclude' | 'block';
}

export type ReviewKind =
  | 'response-row-match' | 'request-item-link' | 'duplicate-persons' | 'dob-conflict'
  | 'unmatched-response-row' | 'unanswered-request-item'
  // Alpha 1 (lane C): DISP not recognised or contradicting its section; resolved with 'set-disposition'.
  | 'disposition-unclear';
export interface ReviewItem {
  id: Ulid;
  kind: ReviewKind;
  createdAt: IsoDateTime;
  subjectIds: Ulid[];
  candidates: MatchCandidate[];
  state: 'open' | 'resolved' | 'dismissed';
  resolution: string | null;
}

export interface AuditEvent {
  seq: number;
  at: IsoDateTime;
  actor: string;
  type: string;
  subjectType: string;
  subjectId: Ulid | null;
  details: Record<string, string | number | boolean>; // allowlisted, never PII
  prevHash: string;
  hash: string;
}

/** A named e-mail address (vetting-authority contacts, lane E). */
export interface Contact {
  name: string;
  email: string;
}
/** Default To / Cc of the "send request to DC" draft (lane E). */
export interface VettingAuthorityContacts {
  to: Contact[];
  cc: Contact[];
}
/** E-mail template purposes (lane E). */
export const EMAIL_TEMPLATE_PURPOSES = [
  'status-to-requestor',
  'all-clear',
  'request-to-dc',
  'reminder',
  'acknowledgement',
] as const;
export type EmailTemplatePurpose = (typeof EMAIL_TEMPLATE_PURPOSES)[number];
export interface EmailTemplateText {
  subject: string;
  body: string;
}
export type UiDensity = 'comfortable' | 'compact';

export interface Settings {
  autoLockMinutes: number; // default 10
  updateCheckEnabled: boolean; // default true (only network feature)
  peerModeEnabled: boolean; // default false, experimental
  clipboardClearSeconds: number; // default 30
  emailClearanceDefaultDays: number; // default 30
  exportPolicy: ExportPolicy;
  redactionMode: boolean;
  /** Per purpose: the user's override, or null = the built-in default text (lane E). */
  emailTemplates: Record<EmailTemplatePurpose, EmailTemplateText | null>;
  vettingAuthority: VettingAuthorityContacts;
  /** Table density (lane G1). */
  uiDensity: UiDensity;
  /** Hidden column ids per table id (lane G1). */
  tableColumns: Record<string, string[]>;
}
export const DEFAULT_SETTINGS: Settings = {
  autoLockMinutes: 10,
  updateCheckEnabled: true,
  peerModeEnabled: false,
  clipboardClearSeconds: 30,
  emailClearanceDefaultDays: 30,
  exportPolicy: {
    includeUnknown: true,
    includePending: false,
    includeExpired: true,
    expiringWithinDays: 30,
    includeUnitChanged: true,
    includeNonApproved: false,
    includeFlaggedUnresolved: 'block',
  },
  redactionMode: false,
  emailTemplates: {
    'status-to-requestor': null,
    'all-clear': null,
    'request-to-dc': null,
    reminder: null,
    acknowledgement: null,
  },
  vettingAuthority: { to: [], cc: [] },
  uiDensity: 'comfortable',
  tableColumns: {},
};
