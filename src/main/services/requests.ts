/**
 * `requests.*` service (WP-14/16): INVESTc import preview + commit, manual requests, export, DC/email status.
 * Identity rule: never guess. Items link automatically only on a matcher 'auto' (single unvetoed T1, one-to-one in the
 * batch); everything ambiguous becomes pending-review with a ReviewItem; a new person is created only for a row with
 * no candidate at all (inside or outside the batch).
 */
import { isManualTarget } from '@shared/domain/lifecycle';
import { addDays, daysBetween } from '@shared/domain/status';
import type {
  ExportPolicy,
  IsoDate,
  LinkState,
  MatchCandidate,
  ObservedPerson,
  ObservedUnit,
  RequestItem,
  RowMatch,
  Ulid,
  ValidationIssue,
  VettingRequest,
  VettingStatus,
  VettingStatusSnapshot,
} from '@shared/domain/types';
import type {
  Ack,
  DiscardPreviewRequest,
  EmailClearanceRequest,
  EmailClearanceResult,
  ExportCommitRequest,
  ExportMode,
  ExportPreview,
  ExportRequest,
  ExportResult,
  IdRef,
  ImportCommitRequest,
  ImportPreview,
  ImportPreviewItem,
  ImportRequestPreviewRequest,
  ManualRequestInput,
  Page,
  RequestLinkItemRequest,
  RequestListQuery,
  RequestSetItemDecisionRequest,
  RequestSetStatusRequest,
  RequestSummary,
  RequestUpdateRequest,
  Result,
} from '@shared/ipc/contract';
import { buildNameKey } from '@shared/names/key';
import { foldForSearch, searchIds } from '../db/search';
import { sha256Hex } from '../db/repos/storedFile';
import { newId } from '../db/repos/util';
import type { RequestHeader, RequestItemInput } from '../db/repos';
import { undoRequest } from '../db/undo';
import type { UndoRequestResult } from '../db/undo';
import { parseInvestc } from '../formats/investc/parse';
import { validateRequest } from '../formats/investc/validate';
import { coreKey as formatsCoreKey, normalizeUnitName } from '../formats/investc/names';
import { KNOWN_TEMPLATE_VERSIONS } from '../formats/investc/layout';
import type { KnownPerson, ParsedInvestc, RequestLookups } from '../formats/investc/types';
import { matchObservations, preselectedCandidate, rankTargets } from '../matching/matcher';
import { observedName, subjectFromObserved } from '../matching/records';
import type { MatchSubject } from '../matching/types';
import type { ExporterPort } from './exporter-port';
import { activeTemplateBytes, captureIfNone } from './templates';
import {
  addAliasIfNew,
  addIdentifiersIfNew,
  createPersonForItem,
  linkItemToPerson,
  personInputFromObserved,
  refreshItemPolicy,
} from './people-ops';
import { DbNegativePairs, SqlCandidateSource } from './people-source';
import { applyExportPolicy, isIncluded, snapshotsFor } from './vetting-status';
import { baseName, blankToNull, displayName, fail, makeCtx, PreviewStore, run, toUnitType } from './vetting-common';
import type { Ctx, ServiceDeps } from './vetting-common';

export interface RequestsDeps extends ServiceDeps {
  exporter: ExporterPort;
}

// Promoted into the IPC contract (lane J); aliases kept for callers and tests.
export type EmailClearanceInput = EmailClearanceRequest;
export type { EmailClearanceResult };
export type ExportCommitInput = ExportCommitRequest;
export interface UndoImportInput extends IdRef {
  /** Also remove linked DC responses (and the records created from them). */
  includeResponses?: boolean;
}

export interface RequestsService {
  list(req: RequestListQuery): Promise<Result<Page<RequestSummary>>>;
  get(req: IdRef): Promise<Result<VettingRequest>>;
  /** Contract method: reads `path` through FileIo then previews. */
  importPreview(req: ImportRequestPreviewRequest): Promise<Result<ImportPreview>>;
  /** Same as importPreview for bytes already in memory. Nothing is written. */
  importFile(fileName: string, bytes: Uint8Array): Promise<Result<ImportPreview>>;
  /** Drop all pending import previews (vault lock; F-14). */
  clearPreviews(): void;
  /** Drop one preview at once (wizard Cancel); unknown ids are fine. */
  discardPreview(req: DiscardPreviewRequest): Promise<Result<Ack>>;
  importCommit(req: ImportCommitRequest): Promise<Result<RequestSummary>>;
  createManual(req: ManualRequestInput): Promise<Result<RequestSummary>>;
  update(req: RequestUpdateRequest): Promise<Result<RequestSummary>>;
  setStatus(req: RequestSetStatusRequest): Promise<Result<RequestSummary>>;
  setItemDecision(req: RequestSetItemDecisionRequest): Promise<Result<RequestItem>>;
  linkItem(req: RequestLinkItemRequest): Promise<Result<RequestItem>>;
  revalidate(req: IdRef): Promise<Result<RequestSummary>>;
  exportPreview(req: ExportRequest): Promise<Result<ExportPreview>>;
  export(req: ExportCommitInput): Promise<Result<ExportResult>>;
  markSentToDc(req: { id: Ulid; at?: string }): Promise<Result<RequestSummary>>;
  markRespondedByEmail(req: EmailClearanceInput): Promise<Result<EmailClearanceResult>>;
  undoImport(req: UndoImportInput): Promise<Result<UndoRequestResult>>;
  /** Contract `remove`: undo without responses (CONFLICT when responses are linked). */
  remove(req: IdRef): Promise<Result<Ack>>;
}

// ---------------------------------------------------------------------------------------------------------------
// planning (pure w.r.t. the DB: reads only)
// ---------------------------------------------------------------------------------------------------------------

interface PlannedItem {
  id: Ulid;
  observed: ObservedPerson;
  match: RowMatch;
  linkState: LinkState;
  personId: Ulid | null;
  suggestedPersonId: Ulid | null;
  issues: ValidationIssue[];
  prior: VettingStatusSnapshot | null;
  exportDecision: RequestItem['exportDecision'];
  exportReason: string;
  unitKey: string;
}
interface PlannedUnit {
  key: string;
  observed: ObservedUnit;
  existingId: Ulid | null;
  id: Ulid;
}
interface PlannedImport {
  requestId: Ulid;
  kind: 'file' | 'manual';
  fileName: string;
  bytes: Uint8Array | null;
  sha256: string;
  templateVersion: string | null;
  units: PlannedUnit[];
  items: PlannedItem[];
  /** All issues (file-level and per row). */
  issues: ValidationIssue[];
  duplicateOf: Ulid | null;
  structuralError: boolean;
}

const unitKey = (name: string): string => foldForSearch(normalizeUnitName(name));
const isFlagged = (s: LinkState): boolean => s === 'pending-review' || s === 'unlinked';
const errorsOf = (issues: readonly ValidationIssue[]): number => issues.filter((i) => i.severity === 'error').length;
const warningsOf = (issues: readonly ValidationIssue[]): number =>
  issues.filter((i) => i.severity === 'warning').length;

function lookupsFor(ctx: Ctx, autoByRow: Map<string, Ulid>): RequestLookups {
  return {
    isKnownUnit: (name) => ctx.repos.units.findByName(name).length > 0,
    findKnownPerson: (q): KnownPerson | null => {
      const pid = autoByRow.get(q.rowRef);
      const p = pid ? ctx.repos.persons.get(pid) : null;
      if (!p) return null;
      const latest = ctx.repos.vetting.latestByPerson(p.id);
      return {
        coreKey: formatsCoreKey(p.canonical.surname, ...p.canonical.given),
        dobIso: p.dob,
        passports: p.identifiers.filter((i) => i.type === 'passport').map((i) => i.value),
        nationalIds: p.identifiers.filter((i) => i.type === 'national-id').map((i) => i.value),
        nonApproved: latest?.disposition === 'non-approved',
      };
    },
  };
}

function planImport(
  ctx: Ctx,
  input: {
    kind: 'file' | 'manual';
    fileName: string;
    bytes: Uint8Array | null;
    units: ObservedUnit[];
    people: ObservedPerson[];
    parsed: ParsedInvestc | null;
    templateVersion: string | null;
  },
): PlannedImport {
  const requestId = newId();
  // Units: one per folded name; reuse an existing unit with that name (and country) when there is one.
  const units = new Map<string, PlannedUnit>();
  for (const u of input.units) {
    if (u.name.trim() === '') continue;
    const key = unitKey(u.name);
    if (units.has(key)) continue;
    const existing = ctx.repos.units.findByName(u.name, u.country.trim() === '' ? undefined : u.country)[0];
    units.set(key, { key, observed: u, existingId: existing?.id ?? null, id: existing?.id ?? newId() });
  }
  const unitIdFor = (name: string): Ulid | null => {
    const k = unitKey(name);
    const pu = units.get(k);
    if (pu) return pu.existingId; // a unit created by this import has no history to match on
    return ctx.repos.units.findByName(name)[0]?.id ?? null;
  };

  const ids = input.people.map(() => newId());
  const subjects: MatchSubject[] = input.people.map((o, i) =>
    subjectFromObserved(ids[i]!, o, { unitId: unitIdFor(o.unitName) }),
  );
  const mctx = {
    source: new SqlCandidateSource(ctx.db, ctx.repos),
    negativePairs: new DbNegativePairs(ctx.repos),
    mode: 'cross-request' as const,
    now: () => ctx.nowIso(),
  };
  const matches = matchObservations(subjects, mctx);

  // Within-batch duplicates: two rows of the same file that look like one person are never two new persons.
  const batchTargets = subjects.map((s) => ({ ...s, kind: 'request-item' as const }));
  const batchDup: MatchCandidate[][] = subjects.map((s) =>
    rankTargets(s, batchTargets, 'within-request', {}).filter((c) => c.tier === 'T1' || c.tier === 'T2'),
  );

  const autoByRow = new Map<string, Ulid>();
  const planned: Omit<PlannedItem, 'issues' | 'prior' | 'exportDecision' | 'exportReason'>[] = input.people.map(
    (o, i) => {
      let m = matches[i]!;
      const dups = batchDup[i]!;
      if (dups.length > 0) {
        m = {
          candidates: [...m.candidates, ...dups],
          decision: 'pending',
          chosen: null,
          decidedBy: null,
          decidedAt: null,
        };
      }
      let linkState: LinkState;
      let personId: Ulid | null = null;
      if (m.decision === 'auto' && m.chosen) {
        linkState = 'auto';
        personId = m.chosen;
        autoByRow.set(o.rowRef, m.chosen);
      } else if (m.decision === 'pending') linkState = 'pending-review';
      else linkState = 'new-person';
      const pre = preselectedCandidate(m);
      const suggested =
        personId ??
        (pre?.targetKind === 'person' ? pre.targetId : null) ??
        m.candidates.find((c) => c.targetKind === 'person')?.targetId ??
        null;
      return {
        id: ids[i]!,
        observed: o,
        match: m,
        linkState,
        personId,
        suggestedPersonId: suggested,
        unitKey: unitKey(o.unitName),
      };
    },
  );

  // Validation (R-06..R-15); R-15 only compares rows with their automatically linked person.
  let issues: ValidationIssue[] = [];
  if (input.parsed) {
    issues = [...input.parsed.issues, ...validateRequest(input.parsed, lookupsFor(ctx, autoByRow), ctx.now())].map(
      ({ code, severity, rowRef, field, message }) => ({ code, severity, rowRef, field, message }),
    );
  }
  const structuralError = issues.some((i) => i.severity === 'error' && i.rowRef === null);

  const policy = ctx.settings().exportPolicy;
  const snaps = snapshotsFor(
    ctx,
    planned.flatMap((p) => (p.personId ? [p.personId] : [])),
  );
  const items: PlannedItem[] = planned.map((p) => {
    const prior = p.personId ? (snaps.get(p.personId) ?? null) : null;
    const unitIdNow = units.get(p.unitKey)?.existingId ?? null;
    const o = applyExportPolicy({ linkState: p.linkState, prior, unitId: unitIdNow }, policy);
    return {
      ...p,
      issues: issues.filter((x) => x.rowRef === p.observed.rowRef),
      prior,
      exportDecision: o.decision,
      exportReason: o.reason,
    };
  });

  const sha = input.bytes ? sha256Hex(input.bytes) : '';
  const duplicateOf = input.bytes ? (ctx.repos.requests.findBySourceSha256(sha)[0]?.id ?? null) : null;
  return {
    requestId,
    kind: input.kind,
    fileName: input.fileName,
    bytes: input.bytes,
    sha256: sha,
    templateVersion: input.templateVersion,
    units: [...units.values()],
    items,
    issues,
    duplicateOf,
    structuralError,
  };
}

function previewOf(previewId: string, plan: PlannedImport): ImportPreview {
  return {
    previewId,
    fileName: plan.fileName,
    sha256: plan.sha256,
    bytes: plan.bytes?.byteLength ?? 0,
    templateVersion: plan.templateVersion,
    units: plan.units.map((u) => u.observed),
    items: plan.items.map((it): ImportPreviewItem => ({
      rowRef: it.observed.rowRef,
      displayName: displayName(observedName(it.observed)),
      unitName: it.observed.unitName,
      dob: it.observed.dob.parsed,
      dobRaw: it.observed.dob.value,
      issues: it.issues,
      suggestedPersonId: it.suggestedPersonId,
      linkState: it.linkState,
      candidates: it.match.candidates,
      prior: it.prior ? { status: it.prior.status, expiresAt: it.prior.expiresAt } : null,
      exportDecision: it.exportDecision,
      exportReason: it.exportReason,
    })),
    issues: plan.issues,
    errorCount: errorsOf(plan.issues),
    warningCount: warningsOf(plan.issues),
    duplicateOfRequestId: plan.duplicateOf,
    canCommit: !plan.structuralError && plan.duplicateOf === null,
  };
}

/** Writes everything a plan describes. Must run inside ctx.tx(). Returns the request id. */
function persistPlan(
  ctx: Ctx,
  plan: PlannedImport,
  header: Omit<ImportCommitRequest, 'previewId'> & { sentToDcAt?: string | null },
): { requestId: Ulid; reviewItems: number; personsCreated: number } {
  const at = ctx.nowIso();
  const fileId = plan.bytes
    ? ctx.repos.files.put({ originalName: plan.fileName, content: plan.bytes, storedAt: at }).id
    : null;
  for (const u of plan.units) {
    if (u.existingId) continue;
    const o = u.observed;
    ctx.repos.units.insert({
      id: u.id,
      name: normalizeUnitName(o.name),
      type: toUnitType(o.type),
      country: o.country.trim(),
      unitIdNo: blankToNull(o.unitIdNo),
      alias: blankToNull(o.alias),
      location: blankToNull(o.location),
      description: blankToNull(o.description),
      englishDescription: blankToNull(o.englishDescription),
      branchName: blankToNull(o.branchName),
      branchDescription: blankToNull(o.branchDescription),
      parentOrg: blankToNull(o.parentOrg),
      subordinateOrg: blankToNull(o.subordinateOrg),
      orgLevel: blankToNull(o.orgLevel),
      createdByRequestId: plan.requestId,
    });
  }
  const unitIds = new Map(plan.units.map((u) => [u.key, u.id]));
  const chosen = new Map((header.exportDecisions ?? []).map((d) => [d.rowRef, d]));
  let personsCreated = 0;
  const items: RequestItemInput[] = plan.items.map((it) => {
    let personId = it.personId;
    if (it.linkState === 'new-person') {
      personId = ctx.repos.persons.insert({
        ...personInputFromObserved(it.observed, it.id, plan.requestId),
        at,
      }).id;
      personsCreated++;
    }
    const name = observedName(it.observed);
    const unitId = unitIds.get(it.unitKey) ?? ctx.repos.units.findByName(it.observed.unitName)[0]?.id ?? null;
    let prior = it.prior;
    let decision = it.exportDecision;
    let reason = it.exportReason;
    if (it.linkState === 'new-person') {
      prior = null;
      const o = applyExportPolicy({ linkState: 'new-person', prior: null, unitId }, ctx.settings().exportPolicy);
      decision = o.decision;
      reason = o.reason;
    }
    const pick = chosen.get(it.observed.rowRef);
    if (pick) {
      decision = pick.decision;
      reason = pick.reason;
    }
    return {
      id: it.id,
      observed: it.observed,
      nameKey: buildNameKey(name),
      personId,
      linkState: it.linkState,
      unitId,
      issues: it.issues,
      prior,
      exportDecision: decision,
      exportReason: reason,
    };
  });
  const errors = errorsOf(plan.issues);
  const sent = header.sentToDcAt ?? null;
  ctx.repos.requests.insert(
    {
      id: plan.requestId,
      kind: plan.kind,
      receivedAt: at,
      requestor: header.requestor,
      eventName: header.eventName,
      eventStart: header.eventStart,
      eventEnd: header.eventEnd,
      eventLocation: header.eventLocation,
      sourceFileId: fileId,
      templateVersion: plan.templateVersion,
      units: plan.units.map((u) => u.observed),
      status: sent ? 'sent-to-dc' : errors > 0 ? 'received' : 'validated',
      sentToDcAt: sent,
      respondedAt: null,
      responseKind: null,
      batchId: null,
      notes: header.notes,
    },
    items,
  );
  let reviewItems = 0;
  for (const it of plan.items) {
    if (it.linkState === 'auto' && it.personId) {
      addAliasIfNew(ctx, it.personId, observedName(it.observed), 'request-item', it.id);
      addIdentifiersIfNew(ctx, it.personId, it.observed, it.id);
    }
    if (it.linkState === 'pending-review') {
      ctx.repos.reviews.insert({
        kind: 'request-item-link',
        subjectIds: [it.id],
        candidates: it.match.candidates,
        createdAt: at,
      });
      reviewItems++;
    }
  }
  return { requestId: plan.requestId, reviewItems, personsCreated };
}

function manualObserved(req: ManualRequestInput): { units: ObservedUnit[]; people: ObservedPerson[] } {
  const units = new Map<string, ObservedUnit>();
  const people: ObservedPerson[] = req.items.map((it, i) => {
    const k = unitKey(it.unitName);
    if (!units.has(k) && it.unitName.trim() !== '')
      units.set(k, {
        rowRef: `Manual!U${units.size + 1}`,
        name: it.unitName,
        unitIdNo: '',
        type: it.unitType,
        alias: '',
        location: '',
        description: '',
        englishDescription: '',
        branchName: '',
        branchDescription: '',
        parentOrg: '',
        subordinateOrg: '',
        orgLevel: '',
        country: it.unitCountry,
      });
    const g = it.givenNames;
    const dobKnown = it.dob !== null && it.dobPrecision !== 'unknown';
    return {
      rowRef: `Manual!${i + 1}`,
      unitName: it.unitName,
      isHeadOfUnit: it.isHeadOfUnit,
      surname: it.surname,
      name1: g[0] ?? '',
      name2: g[1] ?? '',
      name3: g[2] ?? '',
      name4: g.slice(3).join(' '),
      passport: it.passport ?? '',
      nationalId: it.nationalId ?? '',
      titleRank: '',
      fatherName: it.fatherName ?? '',
      motherName: '',
      dob: {
        kind: dobKnown ? 'text' : 'empty',
        value: it.dob ?? '',
        parsed: dobKnown ? it.dob : null,
        ambiguousDayMonth: it.dobPrecision === 'ambiguous-dm',
      },
      pobCity: it.pobCity ?? '',
      pobState: it.pobState ?? '',
      pobCountry: it.pobCountry ?? '',
      nationality: it.nationality ?? '',
      searchCountry: it.unitCountry,
      sex: it.sex ?? '',
    };
  });
  return { units: [...units.values()], people };
}

// ---------------------------------------------------------------------------------------------------------------
// summaries
// ---------------------------------------------------------------------------------------------------------------

export function summarize(ctx: Ctx, headers: RequestHeader[]): RequestSummary[] {
  const stats = ctx.repos.requests.itemStats(headers.map((h) => h.id));
  const today = ctx.today();
  return headers.map((h) => {
    const s = stats.get(h.id)!;
    return {
      id: h.id,
      kind: h.kind,
      receivedAt: h.receivedAt,
      requestor: h.requestor,
      eventName: h.eventName,
      eventStart: h.eventStart,
      eventEnd: h.eventEnd,
      status: h.status,
      sentToDcAt: h.sentToDcAt,
      respondedAt: h.respondedAt,
      responseKind: h.responseKind,
      batchId: h.batchId,
      itemCount: s.itemCount,
      unitCount: h.units.length,
      openIssueCount: s.openIssueCount,
      errorCount: s.errorCount,
      unresolvedLinkCount: s.unresolvedLinkCount,
      answeredCount: s.answeredCount,
      agingDays: h.sentToDcAt && !h.respondedAt ? Math.max(0, daysBetween(h.sentToDcAt.slice(0, 10), today)) : null,
      finishedAt: h.finishedAt,
      closedAt: h.closedAt,
      closeNote: h.closeNote,
      reopenCount: h.reopenCount,
    };
  });
}

function summaryOf(ctx: Ctx, id: Ulid): RequestSummary {
  const h = ctx.repos.requests.getHeader(id);
  if (!h) return fail('NOT_FOUND', 'Request not found');
  return summarize(ctx, [h])[0]!;
}

// ---------------------------------------------------------------------------------------------------------------
// export selection
// ---------------------------------------------------------------------------------------------------------------

interface Selection {
  request: VettingRequest;
  included: RequestItem[];
  excluded: RequestItem[];
  blockingItemIds: Ulid[];
  errorItemIds: Ulid[];
  requestErrors: number;
  units: ObservedUnit[];
  statuses: Map<Ulid, VettingStatus>;
  filterOriginalAvailable: boolean;
}

function selectForExport(ctx: Ctx, req: ExportRequest): Selection {
  const request = ctx.repos.requests.get(req.requestId);
  if (!request) return fail('NOT_FOUND', 'Request not found');
  const policy = ctx.settings().exportPolicy;
  const pick = req.includeItemIds ? new Set(req.includeItemIds) : null;
  const included = request.items.filter((i) => (pick ? pick.has(i.id) : isIncluded(i.exportDecision)));
  const excluded = request.items.filter((i) => !included.includes(i));
  const blockingItemIds =
    policy.includeFlaggedUnresolved === 'block' ? included.filter((i) => isFlagged(i.linkState)).map((i) => i.id) : [];
  const errorItemIds = included.filter((i) => i.issues.some((x) => x.severity === 'error')).map((i) => i.id);
  // Request-level errors (unit rows, structure) are not stored per item: re-derive them from the stored workbook.
  let requestErrors = 0;
  const source = request.sourceFile ? ctx.repos.files.content(request.sourceFile.id) : null;
  if (source) {
    const parsed = parseInvestc(source);
    const rows = new Set(request.items.map((i) => i.observed.rowRef));
    requestErrors = [...parsed.issues, ...validateRequest(parsed, null, ctx.now())].filter(
      (i) => i.severity === 'error' && (i.rowRef === null || !rows.has(i.rowRef)),
    ).length;
  }
  const usedUnits = new Set(included.map((i) => unitKey(i.observed.unitName)));
  const units = request.units.filter((u) => usedUnits.has(unitKey(u.name)));
  const snaps = snapshotsFor(
    ctx,
    request.items.flatMap((i) => (i.personId ? [i.personId] : [])),
  );
  const statuses = new Map<Ulid, VettingStatus>(
    request.items.map((i) => [i.id, i.personId ? (snaps.get(i.personId)?.status ?? 'unknown') : 'unknown']),
  );
  const filterOriginalAvailable =
    !!source && request.templateVersion !== null && KNOWN_TEMPLATE_VERSIONS.includes(request.templateVersion);
  return {
    request,
    included,
    excluded,
    blockingItemIds,
    errorItemIds,
    requestErrors,
    units,
    statuses,
    filterOriginalAvailable,
  };
}

/** filter-original only when the stored source is a known template; otherwise regenerate. */
const resolveMode = (requested: ExportMode, available: boolean): ExportMode =>
  requested === 'filter-original' && available ? 'filter-original' : 'regenerate';

// ---------------------------------------------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------------------------------------------

export function createRequestsService(deps: RequestsDeps): RequestsService {
  const ctx = makeCtx(deps);
  const previews = new PreviewStore<PlannedImport>(ctx.now);

  const importFile = (fileName: string, bytes: Uint8Array): Promise<Result<ImportPreview>> =>
    run(() => {
      const parsed = parseInvestc(bytes);
      const plan = planImport(ctx, {
        kind: 'file',
        fileName,
        bytes,
        units: parsed.units,
        people: parsed.people,
        parsed,
        templateVersion: parsed.templateVersion,
      });
      const previewId = newId();
      previews.put(previewId, plan);
      return previewOf(previewId, plan);
    });

  const setStatusCore = (id: Ulid, status: VettingRequest['status'], at?: string): RequestSummary => {
    const before = ctx.repos.requests.getHeader(id);
    if (!before) return fail('NOT_FOUND', 'Request not found');
    // Finished and Closed are never set by hand: Finished is derived, Closed goes through requests.close.
    if (!isManualTarget(status)) return fail('LIFECYCLE_CONFLICT', 'This status is set automatically or by closing');
    if (before.status === 'closed') return fail('LIFECYCLE_CONFLICT', 'Reopen the request first');
    ctx.tx('requests.setStatus', () => {
      ctx.repos.requests.setStatus(id, status, at ?? ctx.nowIso());
      ctx.audit('request.status', 'request', id, { requestId: id, fromStatus: before.status, toStatus: status });
      ctx.hooks.onRequestAnswered(id);
    });
    return summaryOf(ctx, id);
  };

  return {
    list: (q) =>
      run(() => {
        const ids = q.text && q.text.trim() !== '' ? searchIds(ctx.db, 'request', q.text) : undefined;
        const r = ctx.repos.requests.list({
          offset: q.offset,
          limit: q.limit,
          ...(q.statuses ? { statuses: q.statuses } : {}),
          ...(q.from ? { from: q.from } : {}),
          ...(q.to ? { to: q.to } : {}),
          ...(q.outstandingOnly ? { outstandingOnly: true } : {}),
          ...(ids ? { ids } : {}),
          ...(q.sort ? { sort: q.sort } : {}),
          ...(q.direction ? { direction: q.direction } : {}),
        });
        return { items: summarize(ctx, r.items), total: r.total, offset: q.offset, limit: q.limit };
      }),

    get: ({ id }) => run(() => ctx.repos.requests.get(id) ?? fail('NOT_FOUND', 'Request not found')),

    importPreview: async ({ path }) => {
      let bytes: Uint8Array;
      try {
        bytes = await ctx.files.read(path);
      } catch {
        return { ok: false, error: { code: 'FILE_UNREADABLE', message: 'The file could not be read' } };
      }
      return importFile(baseName(path), bytes);
    },
    importFile,
    clearPreviews: () => previews.clear(),
    discardPreview: ({ previewId }) =>
      run((): Ack => {
        previews.delete(previewId);
        return { ok: true };
      }),

    importCommit: (req) =>
      run(() => {
        const plan = previews.get(req.previewId);
        if (plan.structuralError) return fail('FILE_INVALID', 'The workbook has structural errors');
        const rows = new Set(plan.items.map((i) => i.observed.rowRef));
        if ((req.exportDecisions ?? []).some((d) => !rows.has(d.rowRef)))
          return fail('BAD_REQUEST', 'Export decision for an unknown row');
        if (plan.bytes && ctx.repos.requests.findBySourceSha256(plan.sha256).length > 0)
          return fail('CONFLICT', 'This file has already been imported');
        const r = ctx.tx('requests.importCommit', () => {
          const out = persistPlan(ctx, plan, req);
          // Auto-capture: the first valid request workbook becomes the vault's export template (sanitised, rows removed).
          const captured = plan.bytes ? captureIfNone(ctx, plan.fileName, plan.bytes) : null;
          ctx.audit('request.import', 'request', out.requestId, {
            requestId: out.requestId,
            kind: plan.kind,
            itemCount: plan.items.length,
            unitCount: plan.units.length,
            errorCount: errorsOf(plan.issues),
            warningCount: warningsOf(plan.issues),
            reviewItemsCreated: out.reviewItems,
            sha256: plan.sha256,
            ...(captured ? { action: 'template-captured', templateVersion: captured.templateVersion ?? '' } : {}),
          });
          return { ...out, captured };
        });
        previews.delete(req.previewId);
        const summary = summaryOf(ctx, r.requestId);
        return r.captured ? { ...summary, templateCaptured: r.captured } : summary;
      }),

    createManual: (req) =>
      run(() => {
        const { units, people } = manualObserved(req);
        const plan = planImport(ctx, {
          kind: 'manual',
          fileName: '',
          bytes: null,
          units,
          people,
          parsed: null,
          templateVersion: null,
        });
        const r = ctx.tx('requests.createManual', () => {
          const out = persistPlan(ctx, plan, { ...req });
          ctx.audit('request.create-manual', 'request', out.requestId, {
            requestId: out.requestId,
            kind: 'manual',
            itemCount: plan.items.length,
            unitCount: plan.units.length,
            reviewItemsCreated: out.reviewItems,
          });
          return out;
        });
        return summaryOf(ctx, r.requestId);
      }),

    update: ({ id, patch }) =>
      run(() => {
        ctx.tx('requests.update', () => {
          ctx.repos.requests.update(id, patch);
          ctx.audit('request.update', 'request', id, { requestId: id, fields: Object.keys(patch).sort().join(',') });
        });
        return summaryOf(ctx, id);
      }),

    setStatus: ({ id, status, at }) => run(() => setStatusCore(id, status, at)),

    setItemDecision: ({ itemId, decision, reason }) =>
      run(() =>
        ctx.tx('requests.setItemDecision', () => {
          const item = ctx.repos.requests.getItem(itemId) ?? fail('NOT_FOUND', 'Request item not found');
          const out = ctx.repos.requests.updateItem(itemId, { exportDecision: decision, exportReason: reason });
          ctx.audit('request.item-decision', 'request-item', itemId, {
            requestId: item.requestId,
            itemId,
            exportDecision: decision,
          });
          ctx.hooks.onRequestAnswered(item.requestId);
          return out;
        }),
      ),

    linkItem: ({ itemId, personId }) =>
      run(() =>
        ctx.tx('requests.linkItem', () => {
          const out =
            personId === null ? createPersonForItem(ctx, itemId) : linkItemToPerson(ctx, itemId, personId, 'confirmed');
          ctx.audit('request.item-link', 'request-item', itemId, {
            requestId: out.requestId,
            itemId,
            personId: out.personId ?? '',
            linkState: out.linkState,
          });
          ctx.hooks.onRequestAnswered(out.requestId);
          return out;
        }),
      ),

    revalidate: ({ id }) =>
      run(() => {
        const request = ctx.repos.requests.get(id) ?? fail('NOT_FOUND', 'Request not found');
        const source = request.sourceFile ? ctx.repos.files.content(request.sourceFile.id) : null;
        let issues: ValidationIssue[] | null = null;
        if (source) {
          const parsed = parseInvestc(source);
          const linked = new Map<string, Ulid>();
          for (const it of request.items)
            if (it.personId && (it.linkState === 'auto' || it.linkState === 'confirmed'))
              linked.set(it.observed.rowRef, it.personId);
          issues = [...parsed.issues, ...validateRequest(parsed, lookupsFor(ctx, linked), ctx.now())].map(
            ({ code, severity, rowRef, field, message }) => ({ code, severity, rowRef, field, message }),
          );
        }
        ctx.tx('requests.revalidate', () => {
          for (const it of request.items) {
            if (issues)
              ctx.repos.requests.updateItem(it.id, { issues: issues.filter((x) => x.rowRef === it.observed.rowRef) });
            refreshItemPolicy(ctx, it.id);
          }
          ctx.audit('request.revalidate', 'request', id, {
            requestId: id,
            itemCount: request.items.length,
            errorCount: issues ? errorsOf(issues) : 0,
          });
        });
        return summaryOf(ctx, id);
      }),

    exportPreview: (req) =>
      run((): ExportPreview => {
        const s = selectForExport(ctx, req);
        const inc = new Set(s.included.map((i) => i.id));
        return {
          requestId: req.requestId,
          mode: resolveMode(req.mode, s.filterOriginalAvailable),
          items: s.request.items.map((i) => ({
            itemId: i.id,
            displayName: displayName(observedName(i.observed)),
            unitName: i.observed.unitName,
            included: inc.has(i.id),
            reason: i.exportReason,
            status: s.statuses.get(i.id) ?? 'unknown',
          })),
          includedCount: s.included.length,
          excludedCount: s.excluded.length,
          blockingItemIds: s.blockingItemIds,
          unitsWritten: s.units.length,
          filterOriginalAvailable: s.filterOriginalAvailable,
          templateAvailable: ctx.repos.templates.active('investc-request') !== null,
        };
      }),

    export: (req) =>
      run(async (): Promise<ExportResult> => {
        const s = selectForExport(ctx, req);
        if (s.included.length === 0) return fail('EXPORT_BLOCKED', 'Nothing to export');
        if (s.errorItemIds.length > 0 || s.requestErrors > 0)
          return fail('EXPORT_BLOCKED', 'Unresolved validation errors; fix or exclude the rows first');
        const override = req.overrideReason?.trim() ?? '';
        if (s.blockingItemIds.length > 0 && override === '')
          return fail('EXPORT_BLOCKED', 'Flagged items need review before export (or an override with a reason)');
        const requested = resolveMode(req.mode, s.filterOriginalAvailable);
        const source = requested === 'filter-original' ? ctx.repos.files.content(s.request.sourceFile!.id) : null;
        const template = activeTemplateBytes(ctx);
        if (requested === 'regenerate' && template === null) {
          return fail(
            'TEMPLATE_MISSING',
            s.filterOriginalAvailable
              ? 'No export template is stored in this vault. Choose "filter the original" or import a template in Settings > Templates.'
              : 'No export template is stored in this vault, and this request has no original workbook to filter. Import a blank INVESTc workbook (or any INVESTc request) in Settings > Templates, then export again.',
          );
        }
        let out: ReturnType<ExporterPort['exportInvestc']>;
        try {
          out = deps.exporter.exportInvestc({
            mode: requested,
            ...(source ? { source: new Uint8Array(source) } : {}),
            ...(template ? { template } : {}),
            units: s.units,
            people: s.included.map((i) => i.observed),
            now: ctx.now(),
          });
        } catch (e) {
          if (e instanceof Error && e.name === 'TemplateMissingError') return fail('TEMPLATE_MISSING', e.message);
          throw e;
        }
        const mode = out.modeUsed ?? requested;
        const notices = out.issues.filter((i) => i.severity === 'info').map((i) => i.message);
        if (out.issues.some((i) => i.severity === 'error'))
          return fail('EXPORT_BLOCKED', 'The exported workbook failed validation');
        await ctx.files.write(req.destPath, out.bytes);
        try {
          return ctx.tx('requests.export', () => {
            const name = deps.exporter.suggestExportFilename(s.request.eventName, ctx.now());
            const file = ctx.repos.files.put({ originalName: name, content: out.bytes, storedAt: ctx.nowIso() });
            const policy: ExportPolicy & { overrideReason?: string } = {
              ...ctx.settings().exportPolicy,
              ...(s.blockingItemIds.length > 0 ? { overrideReason: override } : {}),
            };
            const rec = ctx.repos.exports.insert({
              requestId: s.request.id,
              mode,
              fileId: file.id,
              policy,
              includedItemIds: s.included.map((i) => i.id),
              sha256: file.sha256,
              createdAt: ctx.nowIso(),
            });
            if (['received', 'validated', 'exported'].includes(s.request.status))
              ctx.repos.requests.setStatus(s.request.id, 'exported', ctx.nowIso());
            ctx.audit('request.export', 'request', s.request.id, {
              requestId: s.request.id,
              exportId: rec.id,
              mode,
              includedCount: s.included.length,
              excludedCount: s.excluded.length,
              sha256: file.sha256,
              ...(s.blockingItemIds.length > 0 ? { reasonCode: 'override-flagged' } : {}),
            });
            return {
              exportId: rec.id,
              path: req.destPath,
              sha256: file.sha256,
              bytes: file.bytes,
              includedCount: s.included.length,
              excludedCount: s.excluded.length,
              mode,
              ...(notices.length > 0 ? { notices } : {}),
            };
          });
        } catch (e) {
          await ctx.files.remove?.(req.destPath).catch(() => undefined);
          throw e;
        }
      }),

    markSentToDc: ({ id, at }) =>
      run(() => {
        const h = ctx.repos.requests.getHeader(id) ?? fail('NOT_FOUND', 'Request not found');
        if (!['received', 'validated', 'exported', 'sent-to-dc'].includes(h.status))
          return fail('CONFLICT', 'Request can no longer be marked as sent');
        return setStatusCore(id, 'sent-to-dc', at);
      }),

    markRespondedByEmail: (req) => run(() => recordEmailClearance(ctx, req)),

    undoImport: ({ id, includeResponses }) =>
      run(() =>
        ctx.tx('requests.undoImport', () => {
          const r = undoRequest(ctx.db, id, { includeResponses: includeResponses ?? false });
          ctx.audit('request.undo-import', 'request', id, {
            requestId: id,
            itemsDeleted: r.itemsDeleted,
            personsDeleted: r.personsDeleted.length,
            unitsDeleted: r.unitsDeleted.length,
            filesDeleted: r.filesDeleted,
          });
          return r;
        }),
      ),

    remove: ({ id }) =>
      run((): Ack => {
        ctx.tx('requests.remove', () => {
          const r = undoRequest(ctx.db, id, { includeResponses: false });
          ctx.audit('request.undo-import', 'request', id, {
            requestId: id,
            itemsDeleted: r.itemsDeleted,
            personsDeleted: r.personsDeleted.length,
            unitsDeleted: r.unitsDeleted.length,
            filesDeleted: r.filesDeleted,
          });
        });
        return { ok: true };
      }),
  };
}

/** Email-only clearance (or refusal) of request items; default expiry = certDate + emailClearanceDefaultDays. */
export function recordEmailClearance(ctx: Ctx, req: EmailClearanceInput): EmailClearanceResult {
  const h = ctx.repos.requests.getHeader(req.requestId) ?? fail('NOT_FOUND', 'Request not found');
  const items = ctx.repos.requests.getItems(req.itemIds);
  if (items.length !== new Set(req.itemIds).size || items.some((i) => i.requestId !== h.id))
    return fail('BAD_REQUEST', 'Items do not belong to the request');
  if (items.some((i) => !i.personId)) return fail('UNRESOLVED_REVIEW', 'Resolve the person link of every item first');
  if (Object.keys(req.dispositions ?? {}).some((id) => !req.itemIds.includes(id)))
    return fail('BAD_REQUEST', 'Disposition for an item that is not cleared');
  const days = ctx.settings().emailClearanceDefaultDays;
  const at = ctx.nowIso();
  return ctx.tx('requests.markRespondedByEmail', () => {
    const recordIds: Ulid[] = [];
    let assumed = false;
    for (const it of items) {
      const disp = req.dispositions?.[it.id] ?? req.disposition;
      const approved = disp === 'approved';
      const expiresAt: IsoDate | null = approved ? (req.expiresAt ?? addDays(req.certDate, days)) : req.expiresAt;
      const expiryAssumed = approved && req.expiresAt === null;
      assumed ||= expiryAssumed;
      recordIds.push(
        ctx.repos.vetting.insert({
          personId: it.personId!,
          unitId: it.unitId,
          requestId: h.id,
          responseRowId: null,
          disposition: approved ? 'email-cleared' : 'non-approved',
          certDate: req.certDate,
          expiresAt,
          expiryAssumed,
          source: 'email',
          recordedAt: at,
          recordedBy: ctx.actor(),
          note: req.note,
        }).id,
      );
    }
    ctx.repos.requests.update(h.id, { responseKind: 'email-clearance' });
    ctx.repos.requests.setStatus(h.id, 'responded', at);
    for (const it of items) refreshItemPolicy(ctx, it.id);
    ctx.hooks.onRequestAnswered(h.id);
    const after = ctx.repos.requests.getHeader(h.id)!;
    const responseDays =
      after.sentToDcAt && after.respondedAt
        ? daysBetween(after.sentToDcAt.slice(0, 10), after.respondedAt.slice(0, 10))
        : null;
    ctx.audit('request.email-clearance', 'request', h.id, {
      requestId: h.id,
      recordsCreated: recordIds.length,
      source: 'email',
      expiryAssumed: assumed,
      responseKind: 'email-clearance',
    });
    return { recordIds, responseDays, expiryAssumed: assumed };
  });
}
