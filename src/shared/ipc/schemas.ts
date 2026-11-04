/**
 * Zod schemas for every IPC payload. `ipcSchemas` has one `{req, res}` entry per `VssApi` method; the type of the table
 * forces each schema to be assignable to the DTO type in `contract.ts`, so the two cannot drift silently.
 * Requests use strict objects (unknown keys are rejected). Main validates requests (always) and responses (dev/test).
 */
import { z } from 'zod';
import type { ChannelName } from './channels';
import { parseChannel } from './channels';
import { EMAIL_TEMPLATE_PURPOSES } from '../domain/types';
import { isValidEmailAddress } from '../email-address';
import { ERROR_CODES, EVENT_NAMES } from './contract';
import type { VssApi, VssEventMap, VssEventName } from './contract';

// ---------------------------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------------------------

export const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'invalid id');
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
export const isoDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, 'expected UTC ISO-8601');
const str = (max = 1024) => z.string().max(max);
const path = z.string().min(1).max(4096);
const password = z.string().min(1).max(1024);
const b64 = z
  .string()
  .max(16384)
  .regex(/^[A-Za-z0-9+/_-]*={0,2}$/);
const pageQuery = { offset: z.number().int().min(0), limit: z.number().int().min(1).max(500) };
const sortDirection = z.enum(['asc', 'desc']);

// ---------------------------------------------------------------------------------------------------------------
// Domain enums and objects (mirror src/shared/domain/types.ts)
// ---------------------------------------------------------------------------------------------------------------

export const scriptSchema = z.enum(['Latn', 'Thai', 'Khmr', 'Laoo', 'Mymr', 'Hani', 'Other', 'Mixed']);
export const sexSchema = z.enum(['M', 'F']);
export const unitTypeSchema = z.enum(['Military', 'Other', 'Police', 'Prison']);
export const dobPrecisionSchema = z.enum(['exact', 'ambiguous-dm', 'year-only', 'unknown']);
export const vettingStatusSchema = z.enum(['unknown', 'pending', 'approved', 'expiring', 'expired', 'non-approved']);
export const linkStateSchema = z.enum(['auto', 'confirmed', 'pending-review', 'unlinked', 'new-person']);
export const exportDecisionSchema = z.enum(['include', 'exclude', 'manual-include', 'manual-exclude']);
export const requestStatusSchema = z.enum([
  'received',
  'validated',
  'exported',
  'sent-to-dc',
  'responded',
  'finished',
  'closed',
  'withdrawn',
]);
export const responseSectionSchema = z.enum([
  'approved-unit',
  'approved-individual',
  'nonapproved-unit',
  'nonapproved-individual',
]);
export const reviewKindSchema = z.enum([
  'response-row-match',
  'request-item-link',
  'duplicate-persons',
  'dob-conflict',
  'unmatched-response-row',
  'unanswered-request-item',
  'disposition-unclear',
]);
export const validationCodeSchema = z.enum([
  'PKG_NOT_XLSX',
  'PKG_SHEETS_MISMATCH',
  'TEMPLATE_VERSION_UNKNOWN',
  'HEADER_MISMATCH',
  'MARKER_MISSING',
  'REQUIRED_MISSING',
  'CHAR_LIMIT',
  'UNIT_DUPLICATE',
  'UNIT_TYPE_INVALID',
  'UNIT_NOT_DECLARED',
  'UNIT_UNUSED',
  'COUNTRY_NOT_IN_LIST',
  'DOB_INVALID',
  'DOB_TEXT',
  'DOB_AMBIGUOUS_DM',
  'DOB_UNDER_18',
  'DOB_FUTURE',
  'SEX_INVALID',
  'ID_WITHOUT_NATIONALITY',
  'ID_FORMAT_SUSPECT',
  'HEAD_OF_UNIT_NONE',
  'HEAD_OF_UNIT_MULTIPLE',
  'DUPLICATE_ROW',
  'NAME_HAS_HONORIFIC',
  'NAME_EMPTY_GIVEN',
  'UNEXPECTED_UNIT',
  'UNEXPECTED_SCRIPT',
  'PERSON_KNOWN_NAME_MISMATCH',
  'PERSON_KNOWN_DOB_MISMATCH',
  'PERSON_KNOWN_ID_MISMATCH',
  'PERSON_NON_APPROVED',
  'LOOKS_LIKE_REQUEST',
  'RESULTS_SHEET_NOT_FOUND',
  'META_LABEL_MISSING',
  'HEADER_COLUMN_MISSING',
  'HEADER_COLUMN_EXTRA',
  'SECTION_IMPLICIT',
  'SECTION_EMPTY',
  'DISP_UNRECOGNISED',
  'DISP_SECTION_CONFLICT',
  'NAME_MIXED_SCRIPT',
]);
export const matchEvidenceSchema = z.enum([
  'NAME_CORE_EQUAL',
  'NAME_FULL_EQUAL',
  'NAME_SUBSET_1',
  'NAME_SURNAME_EQUAL',
  'NAME_JW_HIGH',
  'NAME_PHONETIC_EQUAL',
  'DOB_EQUAL',
  'DOB_SWAPPED',
  'DOB_YEAR_EQUAL',
  'DOB_CONFLICT',
  'DOB_MISSING',
  'POB_COUNTRY_EQUAL',
  'POB_CONFLICT',
  'UNIT_EQUAL',
  'UNIT_CONFLICT',
  'ID_EQUAL',
  'ID_CONFLICT',
  'SEX_CONFLICT',
  'POB_PLACE_EQUAL',
  'POB_PLACE_CONFLICT',
  'DOB_PLACEHOLDER',
  'FATHER_CONFLICT',
  'NAME_SCRIPT_CONFLICT',
  'NAME_SCRIPT_IGNORED',
]);
export const dispClassSchema = z.enum(['approved', 'non-approved', 'unknown']);
export const sectionSourceSchema = z.enum(['label', 'implicit']);

export const personNameSchema = z.object({
  surname: str(),
  given: z.array(str()),
  raw: str(),
  script: scriptSchema,
});
export const nameKeySchema = z.object({
  fullTokens: z.array(str()),
  coreTokens: z.array(str()),
  particles: z.array(str()),
  phonetic: z.array(str()),
  folded: str(4096),
});
export const placeOfBirthSchema = z.object({
  city: str().nullable(),
  state: str().nullable(),
  country: str().nullable(),
});
export const identifierSchema = z.object({
  type: z.enum(['passport', 'national-id']),
  value: str(),
  valueFolded: str(),
  issuingCountry: str().nullable(),
});
export const personSchema = z.object({
  id: ulid,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  canonical: personNameSchema,
  aliases: z.array(personNameSchema),
  dob: isoDate.nullable(),
  dobPrecision: dobPrecisionSchema,
  sex: sexSchema.nullable(),
  pob: placeOfBirthSchema,
  nationality: str().nullable(),
  identifiers: z.array(identifierSchema),
  state: z.enum(['active', 'merged', 'purged']),
  mergedInto: ulid.nullable(),
  notes: str(65536),
});
export const unitSchema = z.object({
  id: ulid,
  name: str(),
  type: unitTypeSchema,
  country: str(),
  unitIdNo: str().nullable(),
  alias: str().nullable(),
  location: str().nullable(),
  description: str().nullable(),
  englishDescription: str().nullable(),
  branchName: str().nullable(),
  branchDescription: str().nullable(),
  parentOrg: str().nullable(),
  subordinateOrg: str().nullable(),
  orgLevel: str().nullable(),
  aliases: z.array(str()),
});
export const rawDateSchema = z.object({
  kind: z.enum(['serial', 'text', 'empty']),
  value: str(),
  parsed: isoDate.nullable(),
  ambiguousDayMonth: z.boolean(),
});
export const observedPersonSchema = z.object({
  rowRef: str(32),
  unitName: str(),
  isHeadOfUnit: z.boolean().nullable(),
  surname: str(),
  name1: str(),
  name2: str(),
  name3: str(),
  name4: str(),
  passport: str(),
  nationalId: str(),
  titleRank: str(),
  fatherName: str(),
  motherName: str(),
  dob: rawDateSchema,
  pobCity: str(),
  pobState: str(),
  pobCountry: str(),
  nationality: str(),
  searchCountry: str(),
  sex: str(),
});
export const observedUnitSchema = z.object({
  rowRef: str(32),
  name: str(),
  unitIdNo: str(),
  type: str(),
  alias: str(),
  location: str(),
  description: str(),
  englishDescription: str(),
  branchName: str(),
  branchDescription: str(),
  parentOrg: str(),
  subordinateOrg: str(),
  orgLevel: str(),
  country: str(),
});
export const validationIssueSchema = z.object({
  code: validationCodeSchema,
  severity: z.enum(['error', 'warning', 'info']),
  rowRef: str(32).nullable(),
  field: str(64).nullable(),
  message: str(2048),
});
export const vettingStatusSnapshotSchema = z.object({
  status: vettingStatusSchema,
  certDate: isoDate.nullable(),
  expiresAt: isoDate.nullable(),
  unitId: ulid.nullable(),
  source: ulid.nullable(),
  asOf: isoDate,
});
export const requestorSchema = z.object({
  id: ulid.optional(),
  name: str(256),
  email: str(320).nullable(),
  organisation: str(256).nullable(),
  phone: str(64).nullable().optional(),
  notes: str(4096).optional(),
});
export const requestorRecordSchema = z.object({
  id: ulid,
  name: str(256),
  email: str(320).nullable(),
  organisation: str(256).nullable(),
  phone: str(64).nullable(),
  notes: str(4096),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  requestCount: z.number().int().min(0),
  lastUsedAt: isoDateTime.nullable(),
});
export const storedFileSchema = z.object({
  id: ulid,
  originalName: str(512),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().min(0),
  storedAt: isoDateTime,
});
export const requestItemSchema = z.object({
  id: ulid,
  requestId: ulid,
  observed: observedPersonSchema,
  nameKey: nameKeySchema,
  personId: ulid.nullable(),
  linkState: linkStateSchema,
  unitId: ulid.nullable(),
  issues: z.array(validationIssueSchema),
  prior: vettingStatusSnapshotSchema.nullable(),
  exportDecision: exportDecisionSchema,
  exportReason: str(),
});
export const vettingRequestSchema = z.object({
  id: ulid,
  kind: z.enum(['file', 'manual']),
  receivedAt: isoDateTime,
  requestor: requestorSchema,
  eventName: str(),
  eventStart: isoDate.nullable(),
  eventEnd: isoDate.nullable(),
  eventLocation: str().nullable(),
  sourceFile: storedFileSchema.nullable(),
  templateVersion: str(32).nullable(),
  units: z.array(observedUnitSchema),
  items: z.array(requestItemSchema),
  status: requestStatusSchema,
  sentToDcAt: isoDateTime.nullable(),
  respondedAt: isoDateTime.nullable(),
  responseKind: z.enum(['dc-file', 'email-clearance']).nullable(),
  batchId: str(64).nullable(),
  notes: str(65536),
  finishedAt: isoDateTime.nullable(),
  closedAt: isoDateTime.nullable(),
  closeNote: str(65536),
  reopenCount: z.number().int().min(0),
});
export const matchCandidateSchema = z.object({
  targetKind: z.enum(['request-item', 'person']),
  targetId: ulid,
  tier: z.enum(['T1', 'T2', 'T3', 'T4']),
  evidence: z.array(matchEvidenceSchema),
  score: z.number(),
});
export const rowMatchSchema = z.object({
  candidates: z.array(matchCandidateSchema),
  decision: z.enum(['auto', 'confirmed', 'pending', 'rejected', 'none']),
  chosen: ulid.nullable(),
  decidedBy: str().nullable(),
  decidedAt: isoDateTime.nullable(),
});
export const responseRowSchema = z.object({
  id: ulid,
  responseId: ulid,
  rowRef: str(32),
  section: responseSectionSchema,
  disp: str(),
  nameRaw: str(),
  name: personNameSchema,
  nameKey: nameKeySchema,
  dob: rawDateSchema,
  pob: placeOfBirthSchema,
  unitType: str(),
  unitName: str(),
  certDate: rawDateSchema,
  expires: rawDateSchema,
  match: rowMatchSchema,
  dispClass: dispClassSchema,
  sectionSource: sectionSourceSchema,
});
export const dcResponseSchema = z.object({
  id: ulid,
  batchId: str(64),
  post: str(),
  resultsAsOf: isoDate,
  assistanceLine: str(),
  sourceFile: storedFileSchema,
  importedAt: isoDateTime,
  requestId: ulid.nullable(),
  rows: z.array(responseRowSchema),
});
export const vettingRecordSchema = z.object({
  id: ulid,
  personId: ulid,
  unitId: ulid.nullable(),
  requestId: ulid.nullable(),
  responseRowId: ulid.nullable(),
  disposition: z.enum(['approved', 'non-approved', 'email-cleared']),
  certDate: isoDate.nullable(),
  expiresAt: isoDate.nullable(),
  expiryAssumed: z.boolean(),
  source: z.enum(['dc-file', 'email', 'manual']),
  recordedAt: isoDateTime,
  recordedBy: str(),
  note: str(65536),
});
export const unitVettingRecordSchema = z.object({
  id: ulid,
  unitId: ulid,
  requestId: ulid,
  responseRowId: ulid.nullable(),
  commanderPersonId: ulid.nullable(),
  disposition: z.enum(['approved', 'non-approved']),
  certDate: isoDate.nullable(),
  expiresAt: isoDate.nullable(),
  recordedAt: isoDateTime,
});
export const exportPolicySchema = z.object({
  includeUnknown: z.literal(true),
  includePending: z.boolean(),
  includeExpired: z.literal(true),
  expiringWithinDays: z.number().int().min(0).max(3650),
  includeUnitChanged: z.boolean(),
  includeNonApproved: z.boolean(),
  includeFlaggedUnresolved: z.enum(['include', 'exclude', 'block']),
});
/** An e-mail address under the same rule as main's `assertAddress` (src/shared/email-address.ts). */
export const emailAddressSchema = z.string().max(320).refine(isValidEmailAddress, 'invalid e-mail address');
export const contactSchema = z.strictObject({ name: str(256), email: emailAddressSchema });
export const vettingAuthoritySchema = z.strictObject({
  to: z.array(contactSchema).max(50),
  cc: z.array(contactSchema).max(50),
});
// eslint-disable-next-line no-control-regex
const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;
// eslint-disable-next-line no-control-regex
const NO_CONTROL_EXCEPT_WS = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;
export const templateSubjectSchema = z.string().max(200).regex(NO_CONTROL, 'control characters are not allowed');
export const templateBodySchema = z
  .string()
  .max(20_000)
  .regex(NO_CONTROL_EXCEPT_WS, 'control characters are not allowed');
export const emailTemplatePurposeSchema = z.enum(EMAIL_TEMPLATE_PURPOSES);
export const emailTemplateTextSchema = z.strictObject({ subject: templateSubjectSchema, body: templateBodySchema });
export const emailTemplatesSchema = z.strictObject({
  'status-to-requestor': emailTemplateTextSchema.nullable(),
  'all-clear': emailTemplateTextSchema.nullable(),
  'request-to-dc': emailTemplateTextSchema.nullable(),
  reminder: emailTemplateTextSchema.nullable(),
  acknowledgement: emailTemplateTextSchema.nullable(),
});
const tableOrColumnId = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, 'invalid id');
export const tableColumnsSchema = z
  .record(tableOrColumnId, z.array(tableOrColumnId).max(64))
  .refine((r) => Object.keys(r).length <= 64, 'too many tables');
export const settingsSchema = z.object({
  autoLockMinutes: z.number().int().min(1).max(240),
  updateCheckEnabled: z.boolean(),
  peerModeEnabled: z.boolean(),
  clipboardClearSeconds: z.number().int().min(5).max(600),
  emailClearanceDefaultDays: z.number().int().min(1).max(3650),
  exportPolicy: exportPolicySchema,
  redactionMode: z.boolean(),
  emailTemplates: emailTemplatesSchema,
  vettingAuthority: vettingAuthoritySchema,
  uiDensity: z.enum(['comfortable', 'compact']),
  tableColumns: tableColumnsSchema,
});
export const reviewItemSchema = z.object({
  id: ulid,
  kind: reviewKindSchema,
  createdAt: isoDateTime,
  subjectIds: z.array(ulid),
  candidates: z.array(matchCandidateSchema),
  state: z.enum(['open', 'resolved', 'dismissed']),
  resolution: str().nullable(),
});
export const auditEventSchema = z.object({
  seq: z.number().int().min(0),
  at: isoDateTime,
  actor: str(),
  type: str(),
  subjectType: str(),
  subjectId: ulid.nullable(),
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  prevHash: str(256),
  hash: str(256),
});

// ---------------------------------------------------------------------------------------------------------------
// Shared DTO schemas
// ---------------------------------------------------------------------------------------------------------------

export const vssErrorSchema = z.object({ code: z.enum(ERROR_CODES), message: str(2048) });
export const ack = z.object({ ok: z.literal(true) });
export const idRef = z.strictObject({ id: ulid });
const page = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number().int().min(0),
    offset: z.number().int().min(0),
    limit: z.number().int().min(0),
  });
const filePickResult = z.object({ path: path.nullable(), displayPath: path.nullable().optional() });

// vault
export const keySlotInfo = z.object({
  id: str(64),
  kind: z.enum(['password', 'fido2-prf', 'password+prf']),
  label: str(128),
  createdAt: isoDateTime,
});
export const vaultStatus = z.object({
  state: z.enum(['no-vault', 'locked', 'unlocked']),
  vaultPath: path.nullable(),
  slots: z.array(keySlotInfo),
  autoLockInSeconds: z.number().nullable(),
  failedAttempts: z.number().int().min(0),
  lockedOutUntil: isoDateTime.nullable(),
});
const vaultCreateReq = z.strictObject({ password: password.min(12), displayName: str(128) });
const vaultOpenReq = z.strictObject({ path });
const vaultUnlockReq = z.strictObject({
  password,
  prfOutputB64: b64.optional(),
  slotId: str(64).optional(),
});
const vaultChangePasswordReq = z.strictObject({ currentPassword: password, newPassword: password.min(12) });
const vaultEnrollFido2Req = z.strictObject({
  password,
  credentialIdB64: b64,
  prfOutputB64: b64,
  label: str(128),
  requirePasswordToo: z.boolean(),
});
const vaultRemoveSlotReq = z.strictObject({ password, slotId: str(64) });
const vaultBackupReq = z.strictObject({ destPath: path, passphrase: password.min(12) });
const vaultBackupResult = z.object({
  path,
  bytes: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const vaultRestoreReq = z.strictObject({ srcPath: path, passphrase: password, destDirectory: path });
const vaultWipeReq = z.strictObject({
  password,
  confirm: z.literal('WIPE'),
  alsoDeleteScheduledBackups: z.boolean().optional(),
});

// settings
const settingsUpdateReq = z.strictObject({
  settings: settingsSchema,
  reauth: z.strictObject({ password, prfOutputB64: b64.optional() }),
});

// requests
export const requestSummary = z.object({
  id: ulid,
  kind: z.enum(['file', 'manual']),
  receivedAt: isoDateTime,
  requestor: requestorSchema,
  eventName: str(),
  eventStart: isoDate.nullable(),
  eventEnd: isoDate.nullable(),
  status: requestStatusSchema,
  sentToDcAt: isoDateTime.nullable(),
  respondedAt: isoDateTime.nullable(),
  responseKind: z.enum(['dc-file', 'email-clearance']).nullable(),
  batchId: str(64).nullable(),
  itemCount: z.number().int().min(0),
  unitCount: z.number().int().min(0),
  openIssueCount: z.number().int().min(0),
  errorCount: z.number().int().min(0),
  unresolvedLinkCount: z.number().int().min(0),
  answeredCount: z.number().int().min(0),
  agingDays: z.number().nullable(),
  templateCaptured: z.lazy(() => templateInfo).optional(),
  finishedAt: isoDateTime.nullable(),
  closedAt: isoDateTime.nullable(),
  closeNote: str(65536),
  reopenCount: z.number().int().min(0),
});
const requestListQuery = z.strictObject({
  ...pageQuery,
  text: str(256).optional(),
  statuses: z.array(requestStatusSchema).max(16).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  outstandingOnly: z.boolean().optional(),
  sort: z.enum(['receivedAt', 'sentToDcAt', 'eventStart', 'agingDays']).optional(),
  direction: sortDirection.optional(),
});
const importRequestPreviewReq = z.strictObject({ path });
const importPreviewItem = z.object({
  rowRef: str(32),
  displayName: str(),
  unitName: str(),
  dob: isoDate.nullable(),
  dobRaw: str(),
  issues: z.array(validationIssueSchema),
  suggestedPersonId: ulid.nullable(),
  linkState: linkStateSchema,
  candidates: z.array(matchCandidateSchema),
  prior: z.object({ status: vettingStatusSchema, expiresAt: isoDate.nullable() }).nullable(),
  exportDecision: exportDecisionSchema,
  exportReason: str(),
});
const importPreview = z.object({
  previewId: str(128),
  fileName: str(512),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().min(0),
  templateVersion: str(32).nullable(),
  units: z.array(observedUnitSchema),
  items: z.array(importPreviewItem),
  issues: z.array(validationIssueSchema),
  errorCount: z.number().int().min(0),
  warningCount: z.number().int().min(0),
  duplicateOfRequestId: ulid.nullable(),
  canCommit: z.boolean(),
});
const importCommitReq = z.strictObject({
  previewId: str(128),
  requestor: requestorSchema,
  eventName: str(512),
  eventStart: isoDate.nullable(),
  eventEnd: isoDate.nullable(),
  eventLocation: str(512).nullable(),
  notes: str(65536),
  exportDecisions: z
    .array(z.strictObject({ rowRef: str(32), decision: exportDecisionSchema, reason: str(1024) }))
    .max(5000)
    .optional(),
});
const manualRequestItemInput = z.strictObject({
  surname: str(128).min(1),
  givenNames: z.array(str(64)).max(4),
  dob: isoDate.nullable(),
  dobPrecision: dobPrecisionSchema,
  sex: sexSchema.nullable(),
  unitName: str(512).min(1),
  unitType: unitTypeSchema,
  unitCountry: str(128),
  pobCountry: str(128).nullable(),
  nationality: str(128).nullable(),
  isHeadOfUnit: z.boolean().nullable(),
  pobCity: str(128).nullable().optional(),
  pobState: str(128).nullable().optional(),
  passport: str(64).nullable().optional(),
  nationalId: str(64).nullable().optional(),
  fatherName: str(256).nullable().optional(),
});
const manualRequestInput = z.strictObject({
  requestor: requestorSchema,
  eventName: str(512),
  eventStart: isoDate.nullable(),
  eventEnd: isoDate.nullable(),
  eventLocation: str(512).nullable(),
  sentToDcAt: isoDateTime.nullable(),
  notes: str(65536),
  items: z.array(manualRequestItemInput).max(5000),
});
const requestUpdateReq = z.strictObject({
  id: ulid,
  patch: z.strictObject({
    requestor: requestorSchema.optional(),
    eventName: str(512).optional(),
    eventStart: isoDate.nullable().optional(),
    eventEnd: isoDate.nullable().optional(),
    eventLocation: str(512).nullable().optional(),
    batchId: str(64).nullable().optional(),
    notes: str(65536).optional(),
  }),
});
const requestSetStatusReq = z.strictObject({ id: ulid, status: requestStatusSchema, at: isoDateTime.optional() });
const requestSetItemDecisionReq = z.strictObject({ itemId: ulid, decision: exportDecisionSchema, reason: str(1024) });
const requestLinkItemReq = z.strictObject({ itemId: ulid, personId: ulid.nullable() });
const reasonText = str(1024);
const requestCloseReq = z.strictObject({ id: ulid, note: str(4096) });
const requestReopenReq = z.strictObject({ id: ulid, reason: reasonText });
const discardPreviewReq = z.strictObject({ previewId: str(128) });
const exportModeSchema = z.enum(['regenerate', 'filter-original']);
const exportReq = z.strictObject({
  requestId: ulid,
  mode: exportModeSchema,
  includeItemIds: z.array(ulid).max(5000).optional(),
});
const exportPreviewItem = z.object({
  itemId: ulid,
  displayName: str(),
  unitName: str(),
  included: z.boolean(),
  reason: str(),
  status: vettingStatusSchema,
});
const exportPreview = z.object({
  requestId: ulid,
  mode: exportModeSchema,
  items: z.array(exportPreviewItem),
  includedCount: z.number().int().min(0),
  excludedCount: z.number().int().min(0),
  blockingItemIds: z.array(ulid),
  unitsWritten: z.number().int().min(0),
  filterOriginalAvailable: z.boolean(),
  templateAvailable: z.boolean().optional(),
});
const exportCommitReq = z.strictObject({
  requestId: ulid,
  mode: exportModeSchema,
  includeItemIds: z.array(ulid).max(5000).optional(),
  destPath: path,
  overrideReason: str(1024).optional(),
});
const exportResult = z.object({
  exportId: ulid,
  path,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().min(0),
  includedCount: z.number().int().min(0),
  excludedCount: z.number().int().min(0),
  mode: exportModeSchema,
  notices: z.array(str(2048)).max(50).optional(),
});

// templates
const templateInfo = z.object({
  id: ulid,
  kind: z.literal('investc-request'),
  source: z.enum(['auto-capture', 'manual']),
  originalName: str(512),
  templateVersion: str(32).nullable(),
  instructionsVersion: str(32).nullable(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().min(0),
  createdAt: isoDateTime,
  active: z.boolean(),
  replacedAt: isoDateTime.nullable(),
});
const templateList = z.object({ active: templateInfo.nullable(), history: z.array(templateInfo).max(1000) });
const templateImportReq = z.strictObject({ path });
const templateImportResult = z.object({
  template: templateInfo,
  removedParts: z.number().int().min(0),
  list: templateList,
});

// responses
export const responseSummary = z.object({
  id: ulid,
  batchId: str(64),
  post: str(),
  resultsAsOf: isoDate,
  importedAt: isoDateTime,
  requestId: ulid.nullable(),
  rowCount: z.number().int().min(0),
  approvedCount: z.number().int().min(0),
  nonApprovedCount: z.number().int().min(0),
  unresolvedCount: z.number().int().min(0),
});
const responseListQuery = z.strictObject({ ...pageQuery, text: str(256).optional(), requestId: ulid.optional() });
const importResponsePreviewReq = z.strictObject({ path, requestId: ulid.optional() });
const responsePreviewRow = z.object({
  rowId: ulid,
  rowRef: str(32),
  section: responseSectionSchema,
  disp: str(),
  nameRaw: str(),
  dobRaw: str(),
  dob: isoDate.nullable(),
  certDate: isoDate.nullable(),
  expires: isoDate.nullable(),
  unitName: str(),
  candidates: z.array(matchCandidateSchema),
  decision: z.enum(['auto', 'confirmed', 'pending', 'rejected', 'none']),
  chosenRequestItemId: ulid.nullable(),
  chosenPersonId: ulid.nullable(),
  dispClass: dispClassSchema,
  sectionSource: sectionSourceSchema,
});
const responsePreview = z.object({
  previewId: str(128),
  fileName: str(512),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  batchId: str(64).nullable(),
  fileKindGuess: z.enum(['dc-response', 'investc-request', 'unknown']),
  post: str(),
  resultsAsOf: isoDate.nullable(),
  assistanceLine: str(),
  suggestedRequestId: ulid.nullable(),
  rows: z.array(responsePreviewRow),
  issues: z.array(validationIssueSchema),
  errorCount: z.number().int().min(0),
  warningCount: z.number().int().min(0),
  autoMatchedCount: z.number().int().min(0),
  needsReviewCount: z.number().int().min(0),
  unmatchedCount: z.number().int().min(0),
  unansweredItemIds: z.array(ulid),
  duplicateOfResponseId: ulid.nullable(),
  canCommit: z.boolean(),
  requestCandidates: z.array(
    z.object({
      requestId: ulid,
      eventName: str(),
      score: z.number(),
      matchedRows: z.number().int().min(0),
      batchIdMatch: z.boolean(),
    }),
  ),
  matchedRequestId: ulid.nullable(),
});
const responseRowDecision = z.union([ulid, z.literal('new'), z.literal('skip')]);
const responseCommitReq = z.strictObject({
  previewId: str(128),
  requestId: ulid.nullable(),
  decisions: z.record(ulid, responseRowDecision).optional(),
  batchIdOverride: str(64).min(1).optional(),
});
const responseCommitResult = z.object({
  response: responseSummary,
  recordsCreated: z.number().int().min(0),
  reviewItemsCreated: z.number().int().min(0),
  responseDays: z.number().nullable(),
});
const responseSetRowMatchReq = z.strictObject({
  rowId: ulid,
  chosen: ulid.nullable(),
  decision: z.enum(['confirmed', 'rejected', 'none']),
});
const emailClearanceReq = z.strictObject({
  requestId: ulid,
  itemIds: z.array(ulid).min(1).max(5000),
  certDate: isoDate,
  expiresAt: isoDate.nullable(),
  disposition: z.enum(['approved', 'non-approved']),
  dispositions: z.record(ulid, z.enum(['approved', 'non-approved'])).optional(),
  note: str(65536),
});
const emailClearanceResult = z.object({
  recordIds: z.array(ulid),
  responseDays: z.number().nullable(),
  expiryAssumed: z.boolean(),
});
const manualRecordReq = z.strictObject({
  personId: ulid,
  unitId: ulid.nullable(),
  disposition: z.enum(['approved', 'non-approved', 'email-cleared']),
  certDate: isoDate.nullable(),
  expiresAt: isoDate.nullable(),
  note: str(65536),
});
const recordsCreated = z.object({ recordIds: z.array(ulid) });

// persons
export const personSummary = z.object({
  id: ulid,
  displayName: str(),
  dob: isoDate.nullable(),
  dobPrecision: dobPrecisionSchema,
  sex: sexSchema.nullable(),
  nationality: str().nullable(),
  status: vettingStatusSchema,
  certDate: isoDate.nullable(),
  expiresAt: isoDate.nullable(),
  currentUnitName: str().nullable(),
  requestCount: z.number().int().min(0),
  hasOpenReview: z.boolean(),
});
const personListQuery = z.strictObject({
  ...pageQuery,
  text: str(256).optional(),
  statuses: z.array(vettingStatusSchema).max(8).optional(),
  unitId: ulid.optional(),
  expiringBefore: isoDate.optional(),
  sort: z.enum(['name', 'expiresAt', 'status', 'updatedAt']).optional(),
  direction: sortDirection.optional(),
});
const mergeLogEntry = z.object({
  id: ulid,
  at: isoDateTime,
  actor: str(),
  survivorId: ulid,
  mergedId: ulid,
  reason: str(),
});
const personDetail = z.object({
  person: personSchema,
  status: vettingStatusSchema,
  statusAsOf: isoDate,
  records: z.array(vettingRecordSchema),
  units: z.array(unitSchema),
  requests: z.array(requestSummary),
  mergeHistory: z.array(mergeLogEntry),
  openReviewItemIds: z.array(ulid),
});
const personPatchReq = z.strictObject({
  id: ulid,
  patch: z.strictObject({
    canonical: personNameSchema.optional(),
    dob: isoDate.nullable().optional(),
    dobPrecision: dobPrecisionSchema.optional(),
    sex: sexSchema.nullable().optional(),
    nationality: str().nullable().optional(),
    pob: placeOfBirthSchema.optional(),
    notes: str(65536).optional(),
  }),
  reason: str(1024),
});
const personMergeReq = z.strictObject({ survivorId: ulid, mergedId: ulid, reason: str(1024) });
const personUnmergeReq = z.strictObject({ mergeLogId: ulid, reason: str(1024).optional() });
const personSplitReq = z.strictObject({ personId: ulid, itemIds: z.array(ulid).min(1).max(5000), reason: str(1024) });
const duplicateScanResult = z.object({
  pairsFound: z.number().int().min(0),
  reviewItemsCreated: z.number().int().min(0),
});
const personNotSameReq = z.strictObject({ a: ulid, b: ulid });
const personPurgeReq = z.strictObject({ id: ulid, password });
const personSuggestReq = z.strictObject({
  forSubject: z.strictObject({ kind: z.enum(['review-item', 'request-item', 'response-row']), id: ulid }),
  text: str(256).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
const personSuggestion = z.object({
  person: personSummary,
  tier: z.enum(['T1', 'T2', 'T3', 'T4']).nullable(),
  evidence: z.array(matchEvidenceSchema),
  why: z.enum(['candidate', 'recent', 'search']),
});

// requestors
const requestorSearchReq = z.strictObject({ text: str(256), limit: z.number().int().min(1).max(50).optional() });
const requestorListReq = z.strictObject({ ...pageQuery, text: str(256).optional() });
const requestorUpsertReq = z.strictObject({ requestor: z.strictObject(requestorSchema.shape) });
const requestorMergeReq = z.strictObject({ survivorId: ulid, mergedId: ulid });

// units
const unitSummary = z.object({
  id: ulid,
  name: str(),
  type: unitTypeSchema,
  country: str(),
  personCount: z.number().int().min(0),
  lastVetting: unitVettingRecordSchema.nullable(),
});
const unitListQuery = z.strictObject({
  ...pageQuery,
  text: str(256).optional(),
  country: str(128).optional(),
  type: unitTypeSchema.optional(),
});
const unitDetail = z.object({
  unit: unitSchema,
  vettingRecords: z.array(unitVettingRecordSchema),
  personIds: z.array(ulid),
});
const unitPatchReq = z.strictObject({
  id: ulid,
  patch: z.strictObject(unitSchema.omit({ id: true }).partial().shape),
});
const unitAliasReq = z.strictObject({ id: ulid, alias: str(512).min(1) });
const unitMergeReq = z.strictObject({ survivorId: ulid, mergedId: ulid });

// review
const reviewListQuery = z.strictObject({
  ...pageQuery,
  kinds: z.array(reviewKindSchema).max(8).optional(),
  state: z.enum(['open', 'resolved', 'dismissed']).optional(),
});
const reviewSubject = z.object({
  id: ulid,
  kind: z.enum(['person', 'request-item', 'response-row']),
  displayName: str(),
  dob: isoDate.nullable(),
  dobRaw: str(),
  sex: sexSchema.nullable(),
  pobCountry: str().nullable(),
  unitName: str().nullable(),
  identifiers: z.array(str()),
  source: str(),
});
const reviewSubjectEx = reviewSubject.extend({
  edited: z.boolean(),
  original: reviewSubject.partial().optional(),
});
const reviewItemDetail = z.object({ item: reviewItemSchema, subjects: z.array(reviewSubjectEx) });
const reviewItemSummary = reviewItemSchema.extend({
  subjectName: str(),
  subjectDob: isoDate.nullable(),
  unitName: str().nullable(),
  context: z
    .union([z.object({ requestId: ulid, eventName: str() }), z.object({ responseId: ulid, batchId: str(64) })])
    .nullable(),
  bestTier: z.enum(['T1', 'T2', 'T3', 'T4']).nullable(),
});
export const reviewResolutionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('link'), targetId: ulid }),
  z.strictObject({ action: z.literal('new-person') }),
  z.strictObject({ action: z.literal('not-same') }),
  z.strictObject({ action: z.literal('merge'), survivorId: ulid, mergedId: ulid }),
  z.strictObject({ action: z.literal('keep-dob'), subjectId: ulid }),
  z.strictObject({ action: z.literal('dismiss') }),
  z.strictObject({ action: z.literal('set-disposition'), disposition: z.enum(['approved', 'non-approved']) }),
]);
const reviewResolveReq = z.strictObject({ id: ulid, resolution: reviewResolutionSchema });
const reviewManualValidateReq = z.strictObject({
  id: ulid,
  target: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('person'), personId: ulid }),
    z.strictObject({ kind: z.literal('request-item'), itemId: ulid }),
    z.strictObject({ kind: z.literal('new-person') }),
  ]),
  reason: reasonText,
});
const responseRowPatch = z.strictObject({
  nameRaw: str(512).optional(),
  dob: isoDate.nullable().optional(),
  pob: z.strictObject({ city: str().nullable(), state: str().nullable(), country: str().nullable() }).optional(),
  unitName: str(512).optional(),
  certDate: isoDate.nullable().optional(),
  expires: isoDate.nullable().optional(),
  dispClass: dispClassSchema.optional(),
});
const reviewEditSubjectReq = z.strictObject({
  id: ulid,
  subject: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('response-row'), rowId: ulid, patch: responseRowPatch }),
    z.strictObject({ kind: z.literal('person'), personId: ulid, patch: personPatchReq.shape.patch }),
  ]),
  reason: reasonText,
});
const reviewCounts = z.object({
  open: z.number().int().min(0),
  byKind: z.partialRecord(reviewKindSchema, z.number().int()),
});

// email
const emailTemplateId = z.enum([
  'request-to-dc',
  'request-acknowledgement',
  'clearance-notice',
  'reminder-outstanding',
]);
const emailAddresses = z.array(str(320)).max(50);
const emailDraftReq = z.strictObject({
  template: emailTemplateId,
  requestId: ulid,
  to: emailAddresses.optional(),
  cc: emailAddresses.optional(),
  fields: z.strictObject({ dob: z.boolean().optional(), ids: z.boolean().optional() }).optional(),
});
const emailDraft = z.object({
  to: emailAddresses,
  cc: emailAddresses,
  subject: str(998),
  bodyText: str(1_000_000),
  attachmentName: str(512).nullable(),
  containsPersonalData: z.boolean(),
});
const emailDraftStrict = z.strictObject({ ...emailDraft.shape });
const emailWriteEmlReq = z.strictObject({ draft: emailDraftStrict, attachExportId: ulid.optional(), destPath: path });
const emailMailtoResult = z.object({ url: str(8192), truncated: z.boolean() });
const emailRenderTemplateReq = z.strictObject({
  template: emailTemplatePurposeSchema,
  requestId: ulid,
  overrides: z
    .strictObject({ subject: templateSubjectSchema.optional(), body: templateBodySchema.optional() })
    .optional(),
});
const emailPreviewTemplateReq = z.strictObject({
  template: emailTemplatePurposeSchema,
  subject: templateSubjectSchema,
  body: templateBodySchema,
});
const emailTemplateRender = z.object({
  subject: str(998),
  body: str(1_000_000),
  unknownPlaceholders: z.array(str(64)).max(100),
  containsPersonalData: z.boolean(),
});

// stats
const turnaroundStats = z.object({
  count: z.number().int().min(0),
  meanDays: z.number().nullable(),
  medianDays: z.number().nullable(),
  maxDays: z.number().nullable(),
});
const dashboard = z.object({
  asOf: isoDate,
  counts: z.record(vettingStatusSchema, z.number().int().min(0)),
  totalPersons: z.number().int().min(0),
  openReviewItems: z.number().int().min(0),
  outstandingRequests: z.array(
    z.object({
      requestId: ulid,
      eventName: str(),
      sentToDcAt: isoDateTime,
      agingDays: z.number(),
      itemCount: z.number().int().min(0),
      answeredCount: z.number().int().min(0),
    }),
  ),
  turnaround: z.object({
    count: z.number().int().min(0),
    meanDays: z.number().nullable(),
    medianDays: z.number().nullable(),
    maxDays: z.number().nullable(),
  }),
  expiringSoon: z.array(z.object({ personId: ulid, displayName: str(), expiresAt: isoDate })),
  recentRequests: z.array(requestSummary),
  agingBuckets: z.object({
    '0-7': z.number().int().min(0),
    '8-14': z.number().int().min(0),
    '15-30': z.number().int().min(0),
    '>30': z.number().int().min(0),
  }),
  turnaroundByKind: z.object({ file: turnaroundStats, email: turnaroundStats }),
  perMonth: z.array(
    z.object({
      month: z.string().regex(/^\d{4}-\d{2}$/),
      received: z.number().int().min(0),
      sent: z.number().int().min(0),
      responded: z.number().int().min(0),
    }),
  ),
  expiringWithin: z.object({
    d30: z.number().int().min(0),
    d60: z.number().int().min(0),
    d90: z.number().int().min(0),
  }),
  lastBackupAt: isoDateTime.nullable(),
  lastBackupAgeDays: z.number().int().min(0).nullable(),
  inactivePersons: z.object({
    count: z.number().int().min(0),
    sample: z.array(z.object({ personId: ulid, displayName: str(), lastActivityAt: isoDate })),
  }),
  requestsByStatus: z.record(requestStatusSchema, z.number().int().min(0)),
});
const dashboardQuery = z.strictObject({ sinceDays: z.number().int().min(1).max(3650).optional() });
const expiryWatchFields = {
  withinDays: z.number().int().min(0).max(3650).optional(),
  includeExpired: z.boolean().optional(),
};
const expiryWatchQuery = z.strictObject(expiryWatchFields);
const expiryWatchRow = z.object({
  personId: ulid,
  displayName: str(),
  status: vettingStatusSchema,
  expiresAt: isoDate,
  daysLeft: z.number().int(),
  expiryAssumed: z.boolean(),
  unitName: str().nullable(),
});
const expiryCsvReq = z.strictObject({ ...expiryWatchFields, password, destPath: path });
const expiryCsvResult = z.object({ path, count: z.number().int().min(0), bytes: z.number().int().min(0) });

// backup
const backupConfigInput = z.strictObject({
  dir: path,
  keep: z.number().int().min(1).max(100),
  onLock: z.boolean(),
  everyHours: z.number().int().min(1).max(720).nullable(),
});
const backupConfigureReq = z.strictObject({
  config: backupConfigInput.nullable(),
  regeneratePassphrase: z.boolean().optional(),
  reauth: z.strictObject({ password }),
});
const backupListResult = z.object({
  config: z
    .object({
      dir: path,
      keep: z.number().int().min(1).max(100),
      onLock: z.boolean(),
      everyHours: z.number().int().nullable(),
      hasPassphrase: z.literal(true),
    })
    .nullable(),
  backups: z.array(z.object({ name: str(255), path, bytes: z.number().int().min(0), modifiedAt: isoDateTime })),
  lastBackupAt: isoDateTime.nullable(),
});
const backupConfigureResult = backupListResult.extend({ newPassphrase: str(256).nullable() });
const backupRestoreReq = z.strictObject({ srcPath: path, passphrase: password });

// clipboard
const clipboardCopyReq = z.strictObject({
  personId: ulid.optional(),
  field: z.enum(['name', 'dob', 'passport', 'national-id', 'unit', 'status-line', 'plain']),
  text: str(4096).optional(),
});
const clipboardCopyResult = z.object({ clearsInSeconds: z.number().int().min(0) });

// updates
export const updateState = z.object({
  phase: z.enum([
    'idle',
    'disabled',
    'checking',
    'up-to-date',
    'available',
    'downloading',
    'verifying',
    'verified',
    'verify-failed',
    'error',
  ]),
  currentVersion: str(64),
  availableVersion: str(64).nullable(),
  releaseNotes: str(65536).nullable(),
  downloadedBytes: z.number().min(0),
  totalBytes: z.number().min(0).nullable(),
  checkedAt: isoDateTime.nullable(),
  message: str(2048).nullable(),
});

// audit
const auditListQuery = z.strictObject({
  ...pageQuery,
  type: str(128).optional(),
  subjectType: str(128).optional(),
  subjectId: ulid.optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
});
const auditVerifyResult = z.object({
  ok: z.boolean(),
  checked: z.number().int().min(0),
  brokenAtSeq: z.number().int().nullable(),
});
const auditExportReq = z.strictObject({ destPath: path });

// peer
export const peerStatus = z.object({
  enabled: z.boolean(),
  listening: z.boolean(),
  ownFingerprint: str(256).nullable(),
  peers: z.array(
    z.object({
      id: str(64),
      label: str(128),
      fingerprint: str(256),
      lastSeenAt: isoDateTime.nullable(),
      trusted: z.boolean(),
    }),
  ),
});
const peerSetEnabledReq = z.strictObject({ enabled: z.boolean() });
const peerPairReq = z.strictObject({ code: z.string().regex(/^[A-Za-z0-9-]{4,32}$/) });
const peerIdReq = z.strictObject({ peerId: str(64).min(1) });
const peerSyncResult = z.object({
  peerId: str(64),
  sent: z.number().int().min(0),
  received: z.number().int().min(0),
  conflicts: z.number().int().min(0),
});

// files
const fileKind = z.enum([
  'request-xlsx',
  'response-xlsx',
  'vault',
  'backup',
  'eml',
  'csv',
  'audit',
  'directory',
  'any',
]);
const filePickOpenReq = z.strictObject({ kind: fileKind, title: str(256).optional() });
const filePickSaveReq = z.strictObject({
  kind: fileKind,
  // eslint-disable-next-line no-control-regex
  suggestedName: str(255).regex(/^[^\\/:*?"<>|\x00-\x1f]+$/, 'file name only'),
  title: str(256).optional(),
});
const fileRevealReq = z.strictObject({ path });
const fileSaveStoredReq = z.strictObject({ fileId: ulid, destPath: path });

// app
const appInfo = z.object({
  version: str(64),
  channel: z.enum(['dev', 'alpha', 'release']),
  platform: str(32),
  schemaVersion: z.number().int().min(1),
});

// ---------------------------------------------------------------------------------------------------------------
// The schema table (compile-time checked against VssApi)
// ---------------------------------------------------------------------------------------------------------------

type ArgOf<F> = F extends () => unknown ? void : F extends (arg: infer A) => unknown ? A : never;
type ValOf<F> = F extends (...args: never[]) => Promise<{ ok: true; value: infer V } | { ok: false; error: unknown }>
  ? V
  : never;
interface Entry<F> {
  req: z.ZodType<ArgOf<F>>;
  res: z.ZodType<ValOf<F>>;
}
type ApiNamespaces = Exclude<keyof VssApi, 'on'>;
export type SchemaTable = { [N in ApiNamespaces]: { [M in keyof VssApi[N]]: Entry<VssApi[N][M]> } };

const none = z.undefined();

export const ipcSchemas = {
  vault: {
    status: { req: none, res: vaultStatus },
    create: { req: vaultCreateReq, res: vaultStatus },
    open: { req: vaultOpenReq, res: vaultStatus },
    unlock: { req: vaultUnlockReq, res: vaultStatus },
    lock: { req: none, res: vaultStatus },
    changePassword: { req: vaultChangePasswordReq, res: ack },
    enrollFido2: { req: vaultEnrollFido2Req, res: vaultStatus },
    removeSlot: { req: vaultRemoveSlotReq, res: vaultStatus },
    backup: { req: vaultBackupReq, res: vaultBackupResult },
    restore: { req: vaultRestoreReq, res: vaultStatus },
    wipe: { req: vaultWipeReq, res: vaultStatus },
    touch: { req: none, res: ack },
  },
  settings: {
    get: { req: none, res: settingsSchema },
    update: { req: settingsUpdateReq, res: settingsSchema },
  },
  requests: {
    list: { req: requestListQuery, res: page(requestSummary) },
    get: { req: idRef, res: vettingRequestSchema },
    importPreview: { req: importRequestPreviewReq, res: importPreview },
    importCommit: { req: importCommitReq, res: requestSummary },
    createManual: { req: manualRequestInput, res: requestSummary },
    update: { req: requestUpdateReq, res: requestSummary },
    setStatus: { req: requestSetStatusReq, res: requestSummary },
    setItemDecision: { req: requestSetItemDecisionReq, res: requestItemSchema },
    linkItem: { req: requestLinkItemReq, res: requestItemSchema },
    exportPreview: { req: exportReq, res: exportPreview },
    export: { req: exportCommitReq, res: exportResult },
    remove: { req: idRef, res: ack },
    close: { req: requestCloseReq, res: requestSummary },
    reopen: { req: requestReopenReq, res: requestSummary },
    discardPreview: { req: discardPreviewReq, res: ack },
  },
  requestors: {
    search: { req: requestorSearchReq, res: z.array(requestorRecordSchema).max(50) },
    get: { req: idRef, res: requestorRecordSchema },
    upsert: { req: requestorUpsertReq, res: requestorRecordSchema },
    merge: { req: requestorMergeReq, res: requestorRecordSchema },
    list: { req: requestorListReq, res: page(requestorRecordSchema) },
  },
  responses: {
    list: { req: responseListQuery, res: page(responseSummary) },
    get: { req: idRef, res: dcResponseSchema },
    importPreview: { req: importResponsePreviewReq, res: responsePreview },
    importCommit: { req: responseCommitReq, res: responseCommitResult },
    setRowMatch: { req: responseSetRowMatchReq, res: responseRowSchema },
    recordEmailClearance: { req: emailClearanceReq, res: emailClearanceResult },
    recordManual: { req: manualRecordReq, res: recordsCreated },
    discardPreview: { req: discardPreviewReq, res: ack },
  },
  persons: {
    list: { req: personListQuery, res: page(personSummary) },
    get: { req: idRef, res: personDetail },
    update: { req: personPatchReq, res: personDetail },
    merge: { req: personMergeReq, res: personDetail },
    unmerge: { req: personUnmergeReq, res: personDetail },
    split: { req: personSplitReq, res: personDetail },
    markNotSame: { req: personNotSameReq, res: ack },
    purge: { req: personPurgeReq, res: ack },
    scanDuplicates: { req: none, res: duplicateScanResult },
    suggest: { req: personSuggestReq, res: z.array(personSuggestion).max(50) },
  },
  units: {
    list: { req: unitListQuery, res: page(unitSummary) },
    get: { req: idRef, res: unitDetail },
    update: { req: unitPatchReq, res: unitDetail },
    addAlias: { req: unitAliasReq, res: unitDetail },
    merge: { req: unitMergeReq, res: unitDetail },
  },
  review: {
    list: { req: reviewListQuery, res: page(reviewItemSummary) },
    get: { req: idRef, res: reviewItemDetail },
    resolve: { req: reviewResolveReq, res: reviewCounts },
    counts: { req: none, res: reviewCounts },
    manualValidate: { req: reviewManualValidateReq, res: reviewCounts },
    editSubject: { req: reviewEditSubjectReq, res: reviewItemDetail },
  },
  email: {
    draft: { req: emailDraftReq, res: emailDraft },
    writeEml: { req: emailWriteEmlReq, res: filePickResult },
    mailto: { req: emailDraftStrict, res: emailMailtoResult },
    renderTemplate: { req: emailRenderTemplateReq, res: emailTemplateRender },
    previewTemplate: { req: emailPreviewTemplateReq, res: emailTemplateRender },
  },
  stats: {
    dashboard: { req: dashboardQuery, res: dashboard },
    expiryWatch: { req: expiryWatchQuery, res: z.array(expiryWatchRow) },
    exportExpiryCsv: { req: expiryCsvReq, res: expiryCsvResult },
  },
  backup: {
    configure: { req: backupConfigureReq, res: backupConfigureResult },
    list: { req: none, res: backupListResult },
    runNow: { req: none, res: vaultBackupResult },
    restore: { req: backupRestoreReq, res: vaultStatus },
  },
  clipboard: {
    copy: { req: clipboardCopyReq, res: clipboardCopyResult },
    clear: { req: none, res: ack },
  },
  updates: {
    state: { req: none, res: updateState },
    check: { req: none, res: updateState },
    download: { req: none, res: updateState },
    install: { req: none, res: ack },
  },
  audit: {
    list: { req: auditListQuery, res: page(auditEventSchema) },
    verify: { req: none, res: auditVerifyResult },
    export: { req: auditExportReq, res: filePickResult },
  },
  peer: {
    status: { req: none, res: peerStatus },
    setEnabled: { req: peerSetEnabledReq, res: peerStatus },
    pair: { req: peerPairReq, res: peerStatus },
    forget: { req: peerIdReq, res: peerStatus },
    syncNow: { req: peerIdReq, res: peerSyncResult },
  },
  templates: {
    list: { req: none, res: templateList },
    import: { req: templateImportReq, res: templateImportResult },
    setActive: { req: idRef, res: templateList },
    remove: { req: idRef, res: templateList },
  },
  files: {
    pickOpen: { req: filePickOpenReq, res: filePickResult },
    pickSave: { req: filePickSaveReq, res: filePickResult },
    reveal: { req: fileRevealReq, res: ack },
    saveStored: { req: fileSaveStoredReq, res: ack },
  },
  app: {
    info: { req: none, res: appInfo },
    openFeedback: { req: none, res: ack },
    resetWindowState: { req: none, res: ack },
  },
} satisfies SchemaTable;

/** Event payload schemas, keyed by event name. */
export const eventSchemas = {
  'vault:locked': z.object({ reason: z.enum(['manual', 'idle', 'suspend', 'screen-lock', 'error']) }),
  'vault:unlocked': vaultStatus,
  'vault:lock-warning': z.object({ secondsRemaining: z.number().int().min(0) }),
  'review:counts': reviewCounts,
  'updates:state': updateState,
  'clipboard:cleared': z.object({}),
  'peer:status': peerStatus,
  'app:crash-recovered': z.object({ code: str(64) }),
} satisfies { [E in VssEventName]: z.ZodType<VssEventMap[E]> };

export const eventNameSchema = z.enum(EVENT_NAMES);

/** Look up request/response schemas for a channel name (null when the channel is unknown). */
export function schemasForChannel(channel: string): { req: z.ZodType; res: z.ZodType } | null {
  const parsed = parseChannel(channel);
  if (!parsed) return null;
  const [ns, method] = parsed;
  const table = ipcSchemas[ns] as Record<string, { req: z.ZodType; res: z.ZodType }>;
  return table[method] ?? null;
}
export type { ChannelName };
