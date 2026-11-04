/**
 * VSS IPC contract. Single source of truth for the preload bridge (`window.vss`), main-process handlers and the
 * renderer. Every method takes at most ONE request object and resolves to a `Result<T>` (errors never throw across
 * the bridge). Runtime validation of every payload lives in `./schemas.ts`; channel names in `./channels.ts`.
 * Change only via the contracts owner.
 */
import type {
  AuditEvent,
  DcResponse,
  DispClass,
  DobPrecision,
  EmailTemplatePurpose,
  EmailTemplateText,
  ExportDecision,
  IsoDate,
  IsoDateTime,
  MatchCandidate,
  MatchEvidence,
  MatchTier,
  ObservedUnit,
  Person,
  PersonName,
  RequestItem,
  Requestor,
  RequestorRecord,
  RequestStatus,
  ResponseRow,
  ResponseSection,
  ReviewItem,
  ReviewKind,
  SectionSource,
  Settings,
  Sex,
  Ulid,
  Unit,
  UnitType,
  UnitVettingRecord,
  ValidationIssue,
  VettingRecord,
  VettingRequest,
  VettingStatus,
} from '../domain/types';

// ---------------------------------------------------------------------------------------------------------------
// Errors and results
// ---------------------------------------------------------------------------------------------------------------

export const ERROR_CODES = [
  'BAD_REQUEST', // payload failed schema validation
  'UNTRUSTED_SENDER', // IPC from a frame that is not vss://app
  'NOT_SUPPORTED', // handler not implemented / feature disabled
  'INTERNAL',
  'CANCELLED', // user cancelled a dialog
  'VAULT_LOCKED',
  'VAULT_NOT_FOUND',
  'VAULT_EXISTS',
  'VAULT_CORRUPT',
  'BAD_CREDENTIALS',
  'REAUTH_REQUIRED',
  'FIDO2_UNAVAILABLE',
  'NOT_FOUND',
  'CONFLICT',
  'FILE_UNREADABLE',
  'FILE_INVALID', // not an INVESTc / DC workbook, or blocked by an error-severity issue
  'PREVIEW_EXPIRED',
  'EXPORT_BLOCKED', // export policy 'block' (unresolved flagged items) or nothing to export
  'UNRESOLVED_REVIEW',
  'NETWORK_DISABLED',
  'UPDATE_VERIFY_FAILED',
  'BACKUP_INVALID',
  'RATE_LIMITED',
  'SCHEMA_NEWER_THAN_APP', // the database was written by a newer VSS version; update the app first
  'VAULT_TAMPERED', // vault header MAC / integrity check failed (vault.json or vss.db modified outside VSS)
  'TEMPLATE_MISSING', // regenerate export needed but no template is stored in the vault (Settings > Templates)
  // Alpha 1
  'WRONG_FILE_KIND', // e.g. a vetting request workbook picked in the DC response importer (lanes C, F)
  'LIFECYCLE_CONFLICT', // request close / reopen not allowed from the current status (lane D)
  'REASON_REQUIRED', // an audited manual action needs a reason of at least 3 characters (lanes D, K)
] as const;
export type VssErrorCode = (typeof ERROR_CODES)[number];

export interface VssError {
  code: VssErrorCode;
  /** Human-readable, English, never contains personal data. */
  message: string;
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: VssError };

// ---------------------------------------------------------------------------------------------------------------
// Shared DTO building blocks
// ---------------------------------------------------------------------------------------------------------------

export interface PageQuery {
  /** 0-based. */
  offset: number;
  /** 1..500. */
  limit: number;
}
export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}
export type SortDirection = 'asc' | 'desc';

export interface Empty {
  _?: never;
}
export interface Ack {
  ok: true;
}
export interface IdRef {
  id: Ulid;
}

// ---------------------------------------------------------------------------------------------------------------
// vault
// ---------------------------------------------------------------------------------------------------------------

export type VaultState = 'no-vault' | 'locked' | 'unlocked';
export type KeySlotKind = 'password' | 'fido2-prf' | 'password+prf';
export interface KeySlotInfo {
  id: string;
  kind: KeySlotKind;
  label: string;
  createdAt: IsoDateTime;
}
export interface VaultStatus {
  state: VaultState;
  /** Absolute path of vault.json when known. */
  vaultPath: string | null;
  slots: KeySlotInfo[];
  /** Seconds until auto-lock, null when locked. */
  autoLockInSeconds: number | null;
  failedAttempts: number;
  /** ISO time until which unlock attempts are refused (back-off), else null. */
  lockedOutUntil: IsoDateTime | null;
}
/** The vault always lives in the app data folder (VSS_DATA_DIR, else %LOCALAPPDATA%/VSS/vault); never renderer-chosen. */
export interface VaultCreateRequest {
  password: string;
  displayName: string;
}
export interface VaultOpenRequest {
  /** Path to an existing vault.json (or its directory). */
  path: string;
}
export interface VaultUnlockRequest {
  password: string;
  /** Base64 PRF/hmac-secret output from the renderer WebAuthn ceremony, when a prf slot is used. */
  prfOutputB64?: string;
  slotId?: string;
}
export interface VaultChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}
export interface VaultEnrollFido2Request {
  password: string;
  credentialIdB64: string;
  prfOutputB64: string;
  label: string;
  requirePasswordToo: boolean;
}
export interface VaultRemoveSlotRequest {
  password: string;
  slotId: string;
}
export interface VaultBackupRequest {
  destPath: string;
  passphrase: string;
}
export interface VaultBackupResult {
  path: string;
  bytes: number;
  sha256: string;
}
export interface VaultRestoreRequest {
  srcPath: string;
  passphrase: string;
  destDirectory: string;
}
export interface VaultWipeRequest {
  password: string;
  /** Must equal the literal string 'WIPE'. */
  confirm: 'WIPE';
  /** Also delete VSS's own automatic backups in the configured backup folder (lane L). Default false. */
  alsoDeleteScheduledBackups?: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------------------------------------------

export interface SettingsUpdateRequest {
  settings: Settings;
  /** Settings are protected: re-entry of the password (or PRF) is required. */
  reauth: { password: string; prfOutputB64?: string };
}

// ---------------------------------------------------------------------------------------------------------------
// requests
// ---------------------------------------------------------------------------------------------------------------

export interface RequestSummary {
  id: Ulid;
  kind: 'file' | 'manual';
  receivedAt: IsoDateTime;
  requestor: Requestor;
  eventName: string;
  eventStart: IsoDate | null;
  eventEnd: IsoDate | null;
  status: RequestStatus;
  sentToDcAt: IsoDateTime | null;
  respondedAt: IsoDateTime | null;
  responseKind: 'dc-file' | 'email-clearance' | null;
  batchId: string | null;
  itemCount: number;
  unitCount: number;
  openIssueCount: number;
  errorCount: number;
  unresolvedLinkCount: number;
  answeredCount: number;
  /** Days since sentToDcAt when still unanswered, else null. */
  agingDays: number | null;
  /** importCommit only: the export template that was captured from this file (first valid import), if any. */
  templateCaptured?: TemplateInfo;
  /** Alpha 1 lifecycle (lane D). */
  finishedAt: IsoDateTime | null;
  closedAt: IsoDateTime | null;
  closeNote: string;
  reopenCount: number;
}
export interface RequestListQuery extends PageQuery {
  text?: string;
  statuses?: RequestStatus[];
  from?: IsoDate;
  to?: IsoDate;
  outstandingOnly?: boolean;
  sort?: 'receivedAt' | 'sentToDcAt' | 'eventStart' | 'agingDays';
  direction?: SortDirection;
}
/** 'directory' picks a folder (pickOpen only); 'csv' is the expiry-watch export. */
export type FileKind =
  'request-xlsx' | 'response-xlsx' | 'vault' | 'backup' | 'eml' | 'csv' | 'audit' | 'directory' | 'any';

export interface ImportRequestPreviewRequest {
  path: string;
}
export interface ImportPreviewItem {
  rowRef: string;
  displayName: string;
  unitName: string;
  dob: IsoDate | null;
  dobRaw: string;
  issues: ValidationIssue[];
  /** Best candidate person (never auto-created), null if none. */
  suggestedPersonId: Ulid | null;
  linkState: RequestItem['linkState'];
  candidates: MatchCandidate[];
  prior: { status: VettingStatus; expiresAt: IsoDate | null } | null;
  exportDecision: ExportDecision;
  exportReason: string;
}
export interface ImportPreview {
  /** Opaque token valid for this session only; pass to importCommit. */
  previewId: string;
  fileName: string;
  sha256: string;
  bytes: number;
  templateVersion: string | null;
  units: ObservedUnit[];
  items: ImportPreviewItem[];
  issues: ValidationIssue[];
  errorCount: number;
  warningCount: number;
  /** Duplicate of an already imported file (same sha256). */
  duplicateOfRequestId: Ulid | null;
  canCommit: boolean;
}
/** Per-row export decision chosen on the import preview (keyed by the preview item's rowRef). */
export interface ImportExportDecision {
  rowRef: string;
  decision: ExportDecision;
  reason: string;
}
export interface ImportCommitRequest {
  previewId: string;
  requestor: Requestor;
  eventName: string;
  eventStart: IsoDate | null;
  eventEnd: IsoDate | null;
  eventLocation: string | null;
  notes: string;
  /** Overrides of the policy-derived export decision for individual rows (unknown rowRefs are rejected). */
  exportDecisions?: ImportExportDecision[];
}

export interface ManualRequestItemInput {
  surname: string;
  givenNames: string[];
  dob: IsoDate | null;
  dobPrecision: DobPrecision;
  sex: Sex | null;
  unitName: string;
  unitType: UnitType;
  unitCountry: string;
  pobCountry: string | null;
  nationality: string | null;
  isHeadOfUnit: boolean | null;
  /**
   * Optional identity details (security review F-06): a manual entry links automatically to a known person only
   * with an equal passport / national ID, or the same unit and the same POB city or state.
   */
  pobCity?: string | null;
  pobState?: string | null;
  passport?: string | null;
  nationalId?: string | null;
  fatherName?: string | null;
}
export interface ManualRequestInput {
  requestor: Requestor;
  eventName: string;
  eventStart: IsoDate | null;
  eventEnd: IsoDate | null;
  eventLocation: string | null;
  sentToDcAt: IsoDateTime | null;
  notes: string;
  items: ManualRequestItemInput[];
}
export interface RequestUpdateRequest {
  id: Ulid;
  patch: {
    requestor?: Requestor;
    eventName?: string;
    eventStart?: IsoDate | null;
    eventEnd?: IsoDate | null;
    eventLocation?: string | null;
    batchId?: string | null;
    notes?: string;
  };
}
export interface RequestSetStatusRequest {
  id: Ulid;
  status: RequestStatus;
  /** For 'sent-to-dc': when it was actually sent (defaults to now). */
  at?: IsoDateTime;
}
export interface RequestSetItemDecisionRequest {
  itemId: Ulid;
  decision: ExportDecision;
  reason: string;
}
/** Close a Finished request (lane D); `note` is kept on the row, never in the audit text. */
export interface RequestCloseRequest {
  id: Ulid;
  note: string;
}
/** Reopen a Closed request (lane D); `reason` >= 3 characters (REASON_REQUIRED). */
export interface RequestReopenRequest {
  id: Ulid;
  reason: string;
}
/** Drop an import preview at once (wizard Cancel, lane F). Unknown or expired ids are fine (no-op). */
export interface DiscardPreviewRequest {
  previewId: string;
}
export interface RequestLinkItemRequest {
  itemId: Ulid;
  /** null => create a new person from this row (explicit user action). */
  personId: Ulid | null;
}
export type ExportMode = 'regenerate' | 'filter-original';
export interface ExportRequest {
  requestId: Ulid;
  mode: ExportMode;
  /** Override item selection; default is the stored exportDecision of each item. */
  includeItemIds?: Ulid[];
}
export interface ExportPreviewItem {
  itemId: Ulid;
  displayName: string;
  unitName: string;
  included: boolean;
  reason: string;
  status: VettingStatus;
}
export interface ExportPreview {
  requestId: Ulid;
  mode: ExportMode;
  items: ExportPreviewItem[];
  includedCount: number;
  excludedCount: number;
  /** Items blocking export under policy includeFlaggedUnresolved='block'. */
  blockingItemIds: Ulid[];
  unitsWritten: number;
  /** filter-original only possible when the source workbook is stored. */
  filterOriginalAvailable: boolean;
  /** An export template is stored in the vault (needed for regenerate and for the filter-original fallback). */
  templateAvailable?: boolean;
}
export interface ExportCommitRequest extends ExportRequest {
  destPath: string;
  /**
   * Required when policy includeFlaggedUnresolved='block' and included items are still flagged (pending review /
   * unlinked): exporting anyway is an explicit override, stored with the export row (not in the audit text).
   */
  overrideReason?: string;
}
export interface ExportResult {
  exportId: Ulid;
  path: string;
  sha256: string;
  bytes: number;
  includedCount: number;
  excludedCount: number;
  /** The mode actually used (filter-original falls back to regenerate when the original cannot be filtered). */
  mode: ExportMode;
  /** Information for the user (e.g. why the original was not filtered, or which parts were not carried over). */
  notices?: string[];
}

// ---------------------------------------------------------------------------------------------------------------
// templates (export templates kept in the vault; VSS ships none)
// ---------------------------------------------------------------------------------------------------------------

export type TemplateKind = 'investc-request';
export interface TemplateInfo {
  id: Ulid;
  kind: TemplateKind;
  /** 'auto-capture': taken from the first valid request import; 'manual': imported in Settings > Templates. */
  source: 'auto-capture' | 'manual';
  /** File name it was taken from (no path). */
  originalName: string;
  /** `Template Instructions!C2` version, e.g. 1.11.0. */
  templateVersion: string | null;
  /** `Template Instructions!A2` version, e.g. 2.6.0. */
  instructionsVersion: string | null;
  sha256: string;
  bytes: number;
  createdAt: IsoDateTime;
  active: boolean;
  /** When it stopped being the active template (history rows). */
  replacedAt: IsoDateTime | null;
}
export interface TemplateList {
  active: TemplateInfo | null;
  /** Earlier (replaced) templates, newest first. */
  history: TemplateInfo[];
}
export interface TemplateImportRequest {
  /** A blank INVESTc workbook or any INVESTc request; it is sanitised and every data row removed. */
  path: string;
}
export interface TemplateImportResult {
  template: TemplateInfo;
  /** Number of package parts the whitelist removed (comments, custom XML, pictures, ...). */
  removedParts: number;
  list: TemplateList;
}

// ---------------------------------------------------------------------------------------------------------------
// responses
// ---------------------------------------------------------------------------------------------------------------

export interface ResponseSummary {
  id: Ulid;
  batchId: string;
  post: string;
  resultsAsOf: IsoDate;
  importedAt: IsoDateTime;
  requestId: Ulid | null;
  rowCount: number;
  approvedCount: number;
  nonApprovedCount: number;
  unresolvedCount: number;
}
export interface ResponseListQuery extends PageQuery {
  text?: string;
  requestId?: Ulid;
}
export interface ImportResponsePreviewRequest {
  path: string;
  /** Hint: request to match against; otherwise the batch/assistance line and names are used. */
  requestId?: Ulid;
}
/** What the picked file looks like (lane C): a request workbook in the response importer is refused plainly. */
export type FileKindGuess = 'dc-response' | 'investc-request' | 'unknown';
export interface ResponsePreviewRow {
  /** Id the row will have once committed; the key of ResponseCommitRequest.decisions. */
  rowId: Ulid;
  rowRef: string;
  section: ResponseSection;
  disp: string;
  nameRaw: string;
  dobRaw: string;
  /** The DOB as parsed on import (ISO), null when the cell could not be read as a date. */
  dob: IsoDate | null;
  certDate: IsoDate | null;
  expires: IsoDate | null;
  unitName: string;
  candidates: MatchCandidate[];
  decision: ResponseRow['match']['decision'];
  chosenRequestItemId: Ulid | null;
  chosenPersonId: Ulid | null;
  /** Alpha 1 (lane C), mirrors ResponseRow. */
  dispClass: DispClass;
  sectionSource: SectionSource;
}
/** A request the response may answer, ranked by assistance line, event date, units and row overlap. */
export interface ResponseRequestCandidate {
  requestId: Ulid;
  eventName: string;
  /** Higher is better; a ranking hint only, never an automatic choice. */
  score: number;
  /** Person rows of the response with a T1/T2 candidate on this request. */
  matchedRows: number;
  /** The response's batch ID equals the request's. */
  batchIdMatch: boolean;
}
export interface ResponsePreview {
  previewId: string;
  fileName: string;
  sha256: string;
  /** null when the file has no Batch ID label (lane C: META_LABEL_MISSING; the wizard asks for one). */
  batchId: string | null;
  /** Alpha 1 (lane C). */
  fileKindGuess: FileKindGuess;
  post: string;
  resultsAsOf: IsoDate | null;
  assistanceLine: string;
  /**
   * The request the importer may pre-select: the best-ranked candidate, only when it is confident (score and at
   * least one matched person row, shared/domain/request-suggest.ts). Null means the user must choose.
   */
  suggestedRequestId: Ulid | null;
  rows: ResponsePreviewRow[];
  issues: ValidationIssue[];
  errorCount: number;
  warningCount: number;
  autoMatchedCount: number;
  needsReviewCount: number;
  unmatchedCount: number;
  /** Request items that no response row answers. */
  unansweredItemIds: Ulid[];
  duplicateOfResponseId: Ulid | null;
  /** False when S-06 blocks (unknown section label) or error-severity issues exist. */
  canCommit: boolean;
  /** Ranked candidate requests (best first). */
  requestCandidates: ResponseRequestCandidate[];
  /** The request the rows were matched against (the `requestId` hint), else null. */
  matchedRequestId: Ulid | null;
}
/** Per-row decision: a request item id of the chosen request, 'new' (create a person from the row) or 'skip'. */
export type ResponseRowDecision = Ulid | 'new' | 'skip';
export interface ResponseCommitRequest {
  previewId: string;
  requestId: Ulid | null;
  /**
   * rowId -> decision. Rows not listed keep the matcher's proposal: 'auto' rows are confirmed, everything else stays
   * pending and becomes a review item.
   */
  decisions?: Record<Ulid, ResponseRowDecision>;
  /** Batch id typed in the wizard when the file has none (lane C/F); overrides the file's value. */
  batchIdOverride?: string;
}
export interface ResponseCommitResult {
  response: ResponseSummary;
  recordsCreated: number;
  reviewItemsCreated: number;
  /** Days from sentToDcAt to this import; null when no request is linked or it was never marked sent. */
  responseDays: number | null;
}
export interface ResponseSetRowMatchRequest {
  rowId: Ulid;
  /** Request item or person id; null with decision 'rejected'/'none'. */
  chosen: Ulid | null;
  decision: 'confirmed' | 'rejected' | 'none';
}
export interface EmailClearanceRequest {
  requestId: Ulid;
  itemIds: Ulid[];
  certDate: IsoDate;
  /** null => certDate + settings.emailClearanceDefaultDays and expiryAssumed=true. */
  expiresAt: IsoDate | null;
  disposition: 'approved' | 'non-approved';
  /** Per-item override of `disposition` (keys must be in itemIds). */
  dispositions?: Record<Ulid, 'approved' | 'non-approved'>;
  note: string;
}
export interface EmailClearanceResult {
  recordIds: Ulid[];
  /** Days from sentToDcAt to the clearance being recorded; null when the request was never marked sent. */
  responseDays: number | null;
  /** True when at least one approved record got the assumed default expiry. */
  expiryAssumed: boolean;
}
export interface ManualRecordRequest {
  personId: Ulid;
  unitId: Ulid | null;
  disposition: VettingRecord['disposition'];
  certDate: IsoDate | null;
  expiresAt: IsoDate | null;
  note: string;
}
export interface RecordsCreated {
  recordIds: Ulid[];
}

// ---------------------------------------------------------------------------------------------------------------
// persons
// ---------------------------------------------------------------------------------------------------------------

export interface PersonSummary {
  id: Ulid;
  displayName: string;
  dob: IsoDate | null;
  dobPrecision: DobPrecision;
  sex: Sex | null;
  nationality: string | null;
  status: VettingStatus;
  certDate: IsoDate | null;
  expiresAt: IsoDate | null;
  currentUnitName: string | null;
  requestCount: number;
  hasOpenReview: boolean;
}
export interface PersonListQuery extends PageQuery {
  /** Trigram full-text query over names, ids, units. */
  text?: string;
  statuses?: VettingStatus[];
  unitId?: Ulid;
  expiringBefore?: IsoDate;
  sort?: 'name' | 'expiresAt' | 'status' | 'updatedAt';
  direction?: SortDirection;
}
export interface MergeLogEntry {
  id: Ulid;
  at: IsoDateTime;
  actor: string;
  survivorId: Ulid;
  mergedId: Ulid;
  reason: string;
}
export interface PersonDetail {
  person: Person;
  status: VettingStatus;
  statusAsOf: IsoDate;
  records: VettingRecord[];
  units: Unit[];
  requests: RequestSummary[];
  mergeHistory: MergeLogEntry[];
  openReviewItemIds: Ulid[];
}
export interface PersonPatch {
  id: Ulid;
  patch: {
    canonical?: PersonName;
    dob?: IsoDate | null;
    dobPrecision?: DobPrecision;
    sex?: Sex | null;
    nationality?: string | null;
    pob?: { city: string | null; state: string | null; country: string | null };
    notes?: string;
  };
  reason: string;
}
export interface PersonMergeRequest {
  survivorId: Ulid;
  mergedId: Ulid;
  reason: string;
}
export interface PersonUnmergeRequest {
  mergeLogId: Ulid;
  /** Why the merge (or split) is undone; kept with the merge log entry, never in the audit text. */
  reason?: string;
}
export interface PersonSplitRequest {
  personId: Ulid;
  /** Request items that belong to a different person; they (and what hangs off them) move to a new person. */
  itemIds: Ulid[];
  reason: string;
}
export interface DuplicateScanResult {
  pairsFound: number;
  reviewItemsCreated: number;
}
export interface PersonNotSameRequest {
  a: Ulid;
  b: Ulid;
}
export interface PersonPurgeRequest {
  id: Ulid;
  password: string;
}
/** The thing a person is being chosen for (lane K picker). */
export interface SuggestSubject {
  kind: 'review-item' | 'request-item' | 'response-row';
  id: Ulid;
}
export interface PersonSuggestRequest {
  forSubject: SuggestSubject;
  /** Free text typed in the picker; absent = candidates and recent persons only. */
  text?: string;
  /** Default 20, max 50. */
  limit?: number;
}
export interface PersonSuggestion {
  person: PersonSummary;
  tier: MatchTier | null;
  evidence: MatchEvidence[];
  why: 'candidate' | 'recent' | 'search';
}

// ---------------------------------------------------------------------------------------------------------------
// units
// ---------------------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------------------
// requestors (lane B)
// ---------------------------------------------------------------------------------------------------------------

export interface RequestorSearchQuery {
  /** Matched against folded name and e-mail. */
  text: string;
  /** Default 8, max 50. */
  limit?: number;
}
export interface RequestorListQuery extends PageQuery {
  text?: string;
}
export interface RequestorUpsertRequest {
  /** With `id`: update that record; without: dedupe (same folded e-mail, else name + organisation) or create. */
  requestor: Requestor;
}
export interface RequestorMergeRequest {
  survivorId: Ulid;
  mergedId: Ulid;
}

export interface UnitSummary {
  id: Ulid;
  name: string;
  type: UnitType;
  country: string;
  personCount: number;
  lastVetting: UnitVettingRecord | null;
}
export interface UnitListQuery extends PageQuery {
  text?: string;
  country?: string;
  type?: UnitType;
}
export interface UnitDetail {
  unit: Unit;
  vettingRecords: UnitVettingRecord[];
  personIds: Ulid[];
}
export interface UnitPatch {
  id: Ulid;
  patch: Partial<Omit<Unit, 'id'>>;
}
export interface UnitAliasRequest {
  id: Ulid;
  alias: string;
}
export interface UnitMergeRequest {
  survivorId: Ulid;
  mergedId: Ulid;
}

// ---------------------------------------------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------------------------------------------

export interface ReviewListQuery extends PageQuery {
  kinds?: ReviewKind[];
  state?: ReviewItem['state'];
}
export interface ReviewSubject {
  id: Ulid;
  kind: 'person' | 'request-item' | 'response-row';
  displayName: string;
  dob: IsoDate | null;
  dobRaw: string;
  sex: Sex | null;
  pobCountry: string | null;
  unitName: string | null;
  identifiers: string[];
  source: string;
  /** Alpha 1 (lane K): the subject was corrected in VSS; `original` holds the values as the source stated them. */
  edited: boolean;
  original?: Partial<Omit<ReviewSubject, 'original'>>;
}
/** Where a review item comes from (lane K list context). */
export type ReviewItemContext = { requestId: Ulid; eventName: string } | { responseId: Ulid; batchId: string };
/** A review list row: the item plus who it is about (lane K). Personal data: the renderer honours redactionMode. */
export interface ReviewItemSummary extends ReviewItem {
  subjectName: string;
  subjectDob: IsoDate | null;
  unitName: string | null;
  context: ReviewItemContext | null;
  bestTier: MatchTier | null;
}
export interface ReviewItemDetail {
  item: ReviewItem;
  /** Side-by-side subjects for the UI, personal data included (renderer must honour redactionMode). */
  subjects: ReviewSubject[];
}
export type ReviewResolution =
  | { action: 'link'; targetId: Ulid }
  | { action: 'new-person' }
  | { action: 'not-same' }
  | { action: 'merge'; survivorId: Ulid; mergedId: Ulid }
  | { action: 'keep-dob'; subjectId: Ulid }
  | { action: 'dismiss' }
  // Alpha 1 (lanes C, K): resolve a disposition-unclear item.
  | { action: 'set-disposition'; disposition: 'approved' | 'non-approved' };
export interface ReviewResolveRequest {
  id: Ulid;
  resolution: ReviewResolution;
}
/** Assert manually that a response row is a valid DC answer for the target (lane K); reason >= 3 characters. */
export interface ReviewManualValidateRequest {
  id: Ulid;
  target: { kind: 'person'; personId: Ulid } | { kind: 'request-item'; itemId: Ulid } | { kind: 'new-person' };
  reason: string;
}
/** Correctable fields of a response row (lane K); the DC original is kept on first edit. */
export interface ResponseRowPatch {
  nameRaw?: string;
  dob?: IsoDate | null;
  pob?: { city: string | null; state: string | null; country: string | null };
  unitName?: string;
  certDate?: IsoDate | null;
  expires?: IsoDate | null;
  dispClass?: DispClass;
}
export type ReviewEditSubject =
  | { kind: 'response-row'; rowId: Ulid; patch: ResponseRowPatch }
  | { kind: 'person'; personId: Ulid; patch: PersonPatch['patch'] };
export interface ReviewEditSubjectRequest {
  id: Ulid;
  subject: ReviewEditSubject;
  reason: string;
}
export interface ReviewCounts {
  open: number;
  byKind: Partial<Record<ReviewKind, number>>;
}

// ---------------------------------------------------------------------------------------------------------------
// email
// ---------------------------------------------------------------------------------------------------------------

export type EmailTemplateId = 'request-to-dc' | 'request-acknowledgement' | 'clearance-notice' | 'reminder-outstanding';
/** Optional columns of the status table; each is opt-in (default off: Name, Unit, Status, Valid until only). */
export interface EmailFieldSet {
  dob?: boolean;
  /** Passport / national ID numbers. */
  ids?: boolean;
}
export interface EmailDraftRequest {
  template: EmailTemplateId;
  requestId: Ulid;
  to?: string[];
  cc?: string[];
  fields?: EmailFieldSet;
}
export interface EmailDraft {
  to: string[];
  cc: string[];
  subject: string;
  bodyText: string;
  attachmentName: string | null;
  /** true when the body names individuals (never the default). */
  containsPersonalData: boolean;
}
export interface EmailWriteEmlRequest {
  draft: EmailDraft;
  /** Attach a previously produced export by id. */
  attachExportId?: Ulid;
  destPath: string;
}
/** Render a template (lane E) for a request: the user's override or the default, plus `overrides` typed in the dialog. */
export interface EmailRenderTemplateRequest {
  template: EmailTemplatePurpose;
  requestId: Ulid;
  overrides?: Partial<EmailTemplateText>;
}
/** Preview a template text against a fixed synthetic sample (never vault data). */
export interface EmailPreviewTemplateRequest {
  template: EmailTemplatePurpose;
  subject: string;
  body: string;
}
export interface EmailTemplateRender {
  subject: string;
  body: string;
  /** Placeholders that were not recognised and stay literal. */
  unknownPlaceholders: string[];
  containsPersonalData: boolean;
}
export interface EmailMailtoResult {
  /** mailto: URL (subject/body only; no attachment support). */
  url: string;
  truncated: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------------------------------------------

export interface DashboardOutstandingRequest {
  requestId: Ulid;
  eventName: string;
  sentToDcAt: IsoDateTime;
  agingDays: number;
  itemCount: number;
  answeredCount: number;
}
export interface TurnaroundStats {
  count: number;
  meanDays: number | null;
  medianDays: number | null;
  maxDays: number | null;
}
export interface Dashboard {
  asOf: IsoDate;
  counts: Record<VettingStatus, number>;
  totalPersons: number;
  openReviewItems: number;
  outstandingRequests: DashboardOutstandingRequest[];
  /** Turnaround from sentToDcAt to respondedAt, in days, over answered requests. */
  turnaround: { count: number; meanDays: number | null; medianDays: number | null; maxDays: number | null };
  expiringSoon: { personId: Ulid; displayName: string; expiresAt: IsoDate }[];
  recentRequests: RequestSummary[];
  /** Outstanding requests by days since sent (or received when never sent). */
  agingBuckets: { '0-7': number; '8-14': number; '15-30': number; '>30': number };
  /** Turnaround split by how the answer arrived: DC Final_Results file vs email-only clearance. */
  turnaroundByKind: { file: TurnaroundStats; email: TurnaroundStats };
  /** Last 12 calendar months (UTC), oldest first. */
  perMonth: { month: string; received: number; sent: number; responded: number }[];
  /** Persons whose deciding record expires within N days of asOf (inclusive, not yet expired). */
  expiringWithin: { d30: number; d60: number; d90: number };
  /** Time of the last successful backup (scheduled, on-lock or "run now"), null when never. */
  lastBackupAt: IsoDateTime | null;
  /** Whole days since lastBackupAt, null when never. */
  lastBackupAgeDays: number | null;
  /**
   * Informational retention hint: active persons with no activity (request, record, edit) for 3+ years. Nothing is
   * purged automatically; the manual, password-gated purge stays the only way to delete.
   */
  inactivePersons: { count: number; sample: { personId: Ulid; displayName: string; lastActivityAt: IsoDate }[] };
  /** Requests per status (lane D tiles). */
  requestsByStatus: Record<RequestStatus, number>;
}
export interface DashboardQuery {
  /** Window for turnaround statistics. */
  sinceDays?: number;
}
export interface ExpiryWatchQuery {
  /** Default 90. */
  withinDays?: number;
  includeExpired?: boolean;
}
export interface ExpiryWatchRow {
  personId: Ulid;
  displayName: string;
  status: VettingStatus;
  expiresAt: IsoDate;
  daysLeft: number;
  expiryAssumed: boolean;
  unitName: string | null;
}
/** The CSV holds personal data: the password is re-entered and the file goes only where the user chose. */
export interface ExpiryCsvRequest extends ExpiryWatchQuery {
  password: string;
  destPath: string;
}
export interface ExpiryCsvResult {
  path: string;
  count: number;
  bytes: number;
}

// ---------------------------------------------------------------------------------------------------------------
// backup (scheduled / on-lock encrypted backups to a user-chosen folder)
// ---------------------------------------------------------------------------------------------------------------

export interface BackupConfigInput {
  /** Absolute folder (pick it with files.pickOpen kind 'directory'); never the vault folder. */
  dir: string;
  /** Most recent backups to keep, 1..100. */
  keep: number;
  /** Back up when the vault locks (manual / idle). */
  onLock: boolean;
  /** Also back up every N hours while unlocked; null = off. */
  everyHours: number | null;
}
export interface BackupConfigureRequest {
  /** null clears the configuration (no more automatic backups). */
  config: BackupConfigInput | null;
  /**
   * Generate a new recovery passphrase (older backups keep needing the old one). A passphrase is always generated
   * on the first setup; it is never chosen by the user.
   */
  regeneratePassphrase?: boolean;
  /** Backup settings are protected like Settings. */
  reauth: { password: string };
}
export interface BackupConfigPublic {
  dir: string;
  keep: number;
  onLock: boolean;
  everyHours: number | null;
  hasPassphrase: true;
}
export interface BackupFileInfo {
  name: string;
  /** Absolute path (inside the configured folder). */
  path: string;
  bytes: number;
  modifiedAt: IsoDateTime;
}
export interface BackupListResult {
  config: BackupConfigPublic | null;
  backups: BackupFileInfo[];
  lastBackupAt: IsoDateTime | null;
}
export interface BackupConfigureResult extends BackupListResult {
  /**
   * The high-entropy recovery passphrase, returned exactly ONCE (first setup or regenerate) so the UI can show it
   * with a "I have saved it" confirmation; null otherwise. It is kept inside the encrypted vault for unattended
   * backups and is never returned again.
   */
  newPassphrase: string | null;
}
/** Restore a backup into the app data folder. Only possible while no vault exists there (state 'no-vault'). */
export interface BackupRestoreRequest {
  srcPath: string;
  passphrase: string;
}

// ---------------------------------------------------------------------------------------------------------------
// clipboard
// ---------------------------------------------------------------------------------------------------------------

export type ClipboardField = 'name' | 'dob' | 'passport' | 'national-id' | 'unit' | 'status-line' | 'plain';
export interface ClipboardCopyRequest {
  /** Either a registered field of a person, or plain text composed by the UI. */
  personId?: Ulid;
  field: ClipboardField;
  text?: string;
}
export interface ClipboardCopyResult {
  clearsInSeconds: number;
}

// ---------------------------------------------------------------------------------------------------------------
// updates
// ---------------------------------------------------------------------------------------------------------------

export type UpdatePhase =
  | 'idle'
  | 'disabled'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'verified'
  | 'verify-failed'
  | 'error';
export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  releaseNotes: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  checkedAt: IsoDateTime | null;
  /** Only set when phase is 'verify-failed' or 'error'. */
  message: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------------------------------------------

export interface AuditListQuery extends PageQuery {
  type?: string;
  subjectType?: string;
  subjectId?: Ulid;
  from?: IsoDateTime;
  to?: IsoDateTime;
}
export interface AuditVerifyResult {
  ok: boolean;
  checked: number;
  /** First sequence number whose hash chain is broken. */
  brokenAtSeq: number | null;
}
export interface AuditExportRequest {
  destPath: string;
}

// ---------------------------------------------------------------------------------------------------------------
// peer (LAN, experimental, OFF by default)
// ---------------------------------------------------------------------------------------------------------------

export interface PeerInfo {
  id: string;
  label: string;
  fingerprint: string;
  lastSeenAt: IsoDateTime | null;
  trusted: boolean;
}
export interface PeerStatus {
  enabled: boolean;
  listening: boolean;
  ownFingerprint: string | null;
  peers: PeerInfo[];
}
export interface PeerSetEnabledRequest {
  enabled: boolean;
}
export interface PeerPairRequest {
  /** Short code shown on the other machine. */
  code: string;
}
export interface PeerIdRequest {
  peerId: string;
}
export interface PeerSyncResult {
  peerId: string;
  sent: number;
  received: number;
  conflicts: number;
}

// ---------------------------------------------------------------------------------------------------------------
// files (native dialogs; paths chosen by the user only)
// ---------------------------------------------------------------------------------------------------------------

export interface FilePickOpenRequest {
  kind: FileKind;
  title?: string;
}
export interface FilePickSaveRequest {
  kind: FileKind;
  suggestedName: string;
  title?: string;
}
export interface FilePickResult {
  /**
   * null when the user cancelled. From files.pickOpen / files.pickSave this is an OPAQUE TOKEN (security review
   * F-02): pass it unchanged as the `path` / `destPath` / `srcPath` / backup `dir` of the next call. Main resolves it
   * to the path the user chose in the dialog; raw paths are refused. Results of writes (email.writeEml,
   * audit.export) carry the real path written, for display.
   */
  path: string | null;
  /** What to show the user (the chosen path) for a token; absent on write results. */
  displayPath?: string | null;
}
export interface FileRevealRequest {
  path: string;
}
export interface FileSaveStoredRequest {
  fileId: Ulid;
  destPath: string;
}

// ---------------------------------------------------------------------------------------------------------------
// app (lane I: channel, About, feedback)
// ---------------------------------------------------------------------------------------------------------------

export type AppChannel = 'dev' | 'alpha' | 'release';
export interface AppInfo {
  version: string;
  channel: AppChannel;
  /** process.platform */
  platform: string;
  /** Highest DB schema version this build understands. */
  schemaVersion: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Events (main -> renderer)
// ---------------------------------------------------------------------------------------------------------------

export const EVENT_NAMES = [
  'vault:locked',
  'vault:unlocked',
  'vault:lock-warning',
  'review:counts',
  'updates:state',
  'clipboard:cleared',
  'peer:status',
  'app:crash-recovered',
] as const;
export type VssEventName = (typeof EVENT_NAMES)[number];
export interface VssEventMap {
  'vault:locked': { reason: 'manual' | 'idle' | 'suspend' | 'screen-lock' | 'error' };
  'vault:unlocked': VaultStatus;
  'vault:lock-warning': { secondsRemaining: number };
  'review:counts': ReviewCounts;
  'updates:state': UpdateState;
  'clipboard:cleared': Empty;
  'peer:status': PeerStatus;
  /** Lane J crash guard: the vault was locked after a fault. `code` only, never the error message. */
  'app:crash-recovered': { code: string };
}

// ---------------------------------------------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------------------------------------------

type R<T> = Promise<Result<T>>;

export interface VssApi {
  vault: {
    status(): R<VaultStatus>;
    create(req: VaultCreateRequest): R<VaultStatus>;
    open(req: VaultOpenRequest): R<VaultStatus>;
    unlock(req: VaultUnlockRequest): R<VaultStatus>;
    lock(): R<VaultStatus>;
    changePassword(req: VaultChangePasswordRequest): R<Ack>;
    enrollFido2(req: VaultEnrollFido2Request): R<VaultStatus>;
    removeSlot(req: VaultRemoveSlotRequest): R<VaultStatus>;
    backup(req: VaultBackupRequest): R<VaultBackupResult>;
    restore(req: VaultRestoreRequest): R<VaultStatus>;
    wipe(req: VaultWipeRequest): R<VaultStatus>;
    /** Resets the idle timer (renderer calls on user activity). */
    touch(): R<Ack>;
  };
  settings: {
    get(): R<Settings>;
    update(req: SettingsUpdateRequest): R<Settings>;
  };
  requests: {
    list(req: RequestListQuery): R<Page<RequestSummary>>;
    get(req: IdRef): R<VettingRequest>;
    importPreview(req: ImportRequestPreviewRequest): R<ImportPreview>;
    importCommit(req: ImportCommitRequest): R<RequestSummary>;
    createManual(req: ManualRequestInput): R<RequestSummary>;
    update(req: RequestUpdateRequest): R<RequestSummary>;
    setStatus(req: RequestSetStatusRequest): R<RequestSummary>;
    setItemDecision(req: RequestSetItemDecisionRequest): R<RequestItem>;
    linkItem(req: RequestLinkItemRequest): R<RequestItem>;
    exportPreview(req: ExportRequest): R<ExportPreview>;
    export(req: ExportCommitRequest): R<ExportResult>;
    remove(req: IdRef): R<Ack>;
    /** Lane D: Finished -> Closed (LIFECYCLE_CONFLICT otherwise). */
    close(req: RequestCloseRequest): R<RequestSummary>;
    /** Lane D: Closed -> Finished / Responded (recomputed). */
    reopen(req: RequestReopenRequest): R<RequestSummary>;
    discardPreview(req: DiscardPreviewRequest): R<Ack>;
  };
  /** Lane B. */
  requestors: {
    search(req: RequestorSearchQuery): R<RequestorRecord[]>;
    get(req: IdRef): R<RequestorRecord>;
    upsert(req: RequestorUpsertRequest): R<RequestorRecord>;
    merge(req: RequestorMergeRequest): R<RequestorRecord>;
    list(req: RequestorListQuery): R<Page<RequestorRecord>>;
  };
  responses: {
    list(req: ResponseListQuery): R<Page<ResponseSummary>>;
    get(req: IdRef): R<DcResponse>;
    importPreview(req: ImportResponsePreviewRequest): R<ResponsePreview>;
    importCommit(req: ResponseCommitRequest): R<ResponseCommitResult>;
    setRowMatch(req: ResponseSetRowMatchRequest): R<ResponseRow>;
    recordEmailClearance(req: EmailClearanceRequest): R<EmailClearanceResult>;
    recordManual(req: ManualRecordRequest): R<RecordsCreated>;
    discardPreview(req: DiscardPreviewRequest): R<Ack>;
  };
  persons: {
    list(req: PersonListQuery): R<Page<PersonSummary>>;
    get(req: IdRef): R<PersonDetail>;
    update(req: PersonPatch): R<PersonDetail>;
    merge(req: PersonMergeRequest): R<PersonDetail>;
    unmerge(req: PersonUnmergeRequest): R<PersonDetail>;
    /** Move the given request items (and their records) to a new person; undo via unmerge. Returns the new person. */
    split(req: PersonSplitRequest): R<PersonDetail>;
    markNotSame(req: PersonNotSameRequest): R<Ack>;
    purge(req: PersonPurgeRequest): R<Ack>;
    /** Compare all active persons and open a 'duplicate-persons' review item per likely pair. */
    scanDuplicates(): R<DuplicateScanResult>;
    /** Lane K picker: candidates, recent and tolerant search hits for a subject. Never links anything. */
    suggest(req: PersonSuggestRequest): R<PersonSuggestion[]>;
  };
  units: {
    list(req: UnitListQuery): R<Page<UnitSummary>>;
    get(req: IdRef): R<UnitDetail>;
    update(req: UnitPatch): R<UnitDetail>;
    addAlias(req: UnitAliasRequest): R<UnitDetail>;
    merge(req: UnitMergeRequest): R<UnitDetail>;
  };
  review: {
    list(req: ReviewListQuery): R<Page<ReviewItemSummary>>;
    get(req: IdRef): R<ReviewItemDetail>;
    resolve(req: ReviewResolveRequest): R<ReviewCounts>;
    counts(): R<ReviewCounts>;
    /** Lane K. */
    manualValidate(req: ReviewManualValidateRequest): R<ReviewCounts>;
    /** Lane K. */
    editSubject(req: ReviewEditSubjectRequest): R<ReviewItemDetail>;
  };
  email: {
    draft(req: EmailDraftRequest): R<EmailDraft>;
    writeEml(req: EmailWriteEmlRequest): R<FilePickResult>;
    mailto(req: EmailDraft): R<EmailMailtoResult>;
    /** Lane E. */
    renderTemplate(req: EmailRenderTemplateRequest): R<EmailTemplateRender>;
    /** Lane E: renders against a synthetic sample only. */
    previewTemplate(req: EmailPreviewTemplateRequest): R<EmailTemplateRender>;
  };
  stats: {
    dashboard(req: DashboardQuery): R<Dashboard>;
    expiryWatch(req: ExpiryWatchQuery): R<ExpiryWatchRow[]>;
    exportExpiryCsv(req: ExpiryCsvRequest): R<ExpiryCsvResult>;
  };
  backup: {
    configure(req: BackupConfigureRequest): R<BackupConfigureResult>;
    list(): R<BackupListResult>;
    runNow(): R<VaultBackupResult>;
    restore(req: BackupRestoreRequest): R<VaultStatus>;
  };
  clipboard: {
    copy(req: ClipboardCopyRequest): R<ClipboardCopyResult>;
    clear(): R<Ack>;
  };
  updates: {
    state(): R<UpdateState>;
    check(): R<UpdateState>;
    download(): R<UpdateState>;
    install(): R<Ack>;
  };
  audit: {
    list(req: AuditListQuery): R<Page<AuditEvent>>;
    verify(): R<AuditVerifyResult>;
    export(req: AuditExportRequest): R<FilePickResult>;
  };
  peer: {
    status(): R<PeerStatus>;
    setEnabled(req: PeerSetEnabledRequest): R<PeerStatus>;
    pair(req: PeerPairRequest): R<PeerStatus>;
    forget(req: PeerIdRequest): R<PeerStatus>;
    syncNow(req: PeerIdRequest): R<PeerSyncResult>;
  };
  templates: {
    list(): R<TemplateList>;
    import(req: TemplateImportRequest): R<TemplateImportResult>;
    setActive(req: IdRef): R<TemplateList>;
    remove(req: IdRef): R<TemplateList>;
  };
  files: {
    pickOpen(req: FilePickOpenRequest): R<FilePickResult>;
    pickSave(req: FilePickSaveRequest): R<FilePickResult>;
    reveal(req: FileRevealRequest): R<Ack>;
    saveStored(req: FileSaveStoredRequest): R<Ack>;
  };
  app: {
    info(): R<AppInfo>;
    /** Lane I: opens the fixed, allowlisted feedback URL (version, OS and architecture only). */
    openFeedback(): R<Ack>;
    /** R16: forget the remembered window size/position and re-centre the window. */
    resetWindowState(): R<Ack>;
  };
  /** Subscribe to main-process events. Returns an unsubscribe function. */
  on<E extends VssEventName>(event: E, listener: (payload: VssEventMap[E]) => void): () => void;
}
