/**
 * `responses.*` service (WP-15): DC Final_Results import. The preview proposes requests (assistance line, event date,
 * unit names, row overlap) but never commits on its own; with a request, rows are matched within that request only
 * (matchResponseRows). On commit only matcher 'auto' rows (single T1, one-to-one) are pre-confirmed; everything else
 * needs an explicit decision or becomes a ReviewItem. Certificate and expiry dates are stored exactly as stated.
 */
import { daysBetween } from '@shared/domain/status';
import type {
  DcResponse,
  IsoDate,
  RequestItem,
  ResponseRow,
  RowMatch,
  Ulid,
  UnitVettingRecord,
  ValidationCode,
  ValidationIssue,
  VettingRequest,
} from '@shared/domain/types';
import type {
  Ack,
  DiscardPreviewRequest,
  IdRef,
  ImportResponsePreviewRequest,
  ManualRecordRequest,
  Page,
  RecordsCreated,
  ResponseCommitRequest,
  ResponseCommitResult,
  ResponseListQuery,
  ResponsePreview,
  ResponsePreviewRow,
  ResponseRequestCandidate,
  ResponseRowDecision,
  ResponseSetRowMatchRequest,
  ResponseSummary,
  Result,
} from '@shared/ipc/contract';
import { tokenSetJaroWinkler } from '@shared/names/jaroWinkler';
import { buildNameKey } from '@shared/names/key';
import { foldUnitName } from '@shared/names/normalize';
import type { ResponseHeader } from '../db/repos';
import { sha256Hex } from '../db/repos/storedFile';
import { newId } from '../db/repos/util';
import { foldForSearch, searchIds } from '../db/search';
import { parseFinalResults, parseUsDate } from '../formats/dc/parse';
import type { DcResponseDraft, FileKindGuess, ResponseIssue } from '../formats/dc/types';
import { matchResponseRows } from '../matching/matcher';
import {
  addAliasIfNew,
  isIndividualSection,
  isLinkedDecision,
  personInputFromRow,
  recordFromRow,
  refreshItemPolicy,
} from './people-ops';
import { recordEmailClearance } from './requests';
import type { EmailClearanceInput, EmailClearanceResult } from './requests';
import { baseName, fail, makeCtx, PreviewStore, run } from './vetting-common';
import type { Ctx, ServiceDeps } from './vetting-common';

// Promoted into the IPC contract (lane J); kept as aliases for the service's callers and tests.
export type RowDecision = ResponseRowDecision;
export type ResponseCommitInput = ResponseCommitRequest;
export type ResponseCommitOutcome = ResponseCommitResult;
export type RequestCandidate = ResponseRequestCandidate;
export interface ResponsePreviewEx extends ResponsePreview {
  /** Response row ids in file order (same as rows[].rowId; keys of the decisions map). */
  rowIds: Ulid[];
}
export interface ResponseUndoResult {
  responseId: Ulid;
  rowsDeleted: number;
  recordsDeleted: number;
  unitRecordsDeleted: number;
  reviewItemsDeleted: number;
  personsDeleted: Ulid[];
}

export interface ResponsesService {
  list(req: ResponseListQuery): Promise<Result<Page<ResponseSummary>>>;
  get(req: IdRef): Promise<Result<DcResponse>>;
  importPreview(req: ImportResponsePreviewRequest): Promise<Result<ResponsePreviewEx>>;
  importFile(fileName: string, bytes: Uint8Array, requestId?: Ulid): Promise<Result<ResponsePreviewEx>>;
  /** Drop all pending import previews (vault lock; F-14). */
  clearPreviews(): void;
  /** Drop one preview at once (wizard Cancel); unknown ids are fine. */
  discardPreview(req: DiscardPreviewRequest): Promise<Result<Ack>>;
  importCommit(req: ResponseCommitInput): Promise<Result<ResponseCommitOutcome>>;
  setRowMatch(req: ResponseSetRowMatchRequest): Promise<Result<ResponseRow>>;
  recordEmailClearance(req: EmailClearanceInput): Promise<Result<EmailClearanceResult>>;
  recordManual(req: ManualRecordRequest): Promise<Result<RecordsCreated>>;
  undoImport(req: IdRef): Promise<Result<ResponseUndoResult>>;
}

interface PlannedResponse {
  responseId: Ulid;
  fileName: string;
  bytes: Uint8Array;
  sha256: string;
  draft: DcResponseDraft;
  unknownCommander: boolean[];
  rows: ResponseRow[];
  matchedRequestId: Ulid | null;
  issues: ValidationIssue[];
  blocked: boolean;
  duplicateOf: Ulid | null;
  candidates: RequestCandidate[];
  fileKindGuess: FileKindGuess;
}

const NO_MATCH: RowMatch = { candidates: [], decision: 'none', chosen: null, decidedBy: null, decidedAt: null };

/** Alpha 1 response codes exist in ValidationCode too and pass through 1:1, with a plain message (no rule code). */
const PASS_THROUGH: ReadonlySet<string> = new Set<ValidationCode>([
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

/** DC parser issues mapped onto the domain ValidationCode union; for the 0.1 codes, rule+code are kept in the message. */
function mapIssue(i: ResponseIssue): ValidationIssue {
  if (PASS_THROUGH.has(i.code))
    return {
      code: i.code as ValidationCode,
      severity: i.severity,
      rowRef: i.rowRef,
      field: i.field,
      message: i.message,
    };
  const code: ValidationCode =
    i.code === 'PKG_NOT_XLSX'
      ? 'PKG_NOT_XLSX'
      : i.code === 'SHEET_MISSING' || i.code === 'EXTRA_SHEETS'
        ? 'PKG_SHEETS_MISMATCH'
        : i.code === 'DATE_UNPARSEABLE'
          ? 'DOB_INVALID'
          : i.code === 'ROW_INCOMPLETE' || i.code === 'NAME_EMPTY' || i.code === 'NAME_NO_COMMA'
            ? 'REQUIRED_MISSING'
            : i.code === 'SECTION_MISSING' || i.code === 'NO_SECTIONS'
              ? 'MARKER_MISSING'
              : 'HEADER_MISMATCH';
  return {
    code,
    severity: i.severity,
    rowRef: i.rowRef,
    field: i.field,
    message: `[${i.rule} ${i.code}] ${i.message}`,
  };
}

/** Individuals and named commanders are matched in two separate one-to-one groups (a commander is usually also listed
 * as an individual); UNKNOWN commanders are never matched. */
function matchRows(ctx: Ctx, rows: ResponseRow[], unknown: boolean[], items: RequestItem[]): RowMatch[] {
  const mctx = { now: () => ctx.nowIso() };
  const out: RowMatch[] = rows.map(() => NO_MATCH);
  const groups = [
    rows.map((r, i) => i).filter((i) => isIndividualSection(rows[i]!.section)),
    rows.map((r, i) => i).filter((i) => !isIndividualSection(rows[i]!.section) && !unknown[i]),
  ];
  for (const g of groups) {
    const ms = matchResponseRows(
      g.map((i) => rows[i]!),
      items,
      mctx,
    );
    g.forEach((i, k) => (out[i] = ms[k]!));
  }
  return out;
}

function splitAssistance(line: string): { event: string; place: string; date: IsoDate | null } {
  const parts = line.split(' - ').map((s) => s.trim());
  if (parts.length < 3) return { event: line.trim(), place: '', date: null };
  return {
    event: parts.slice(0, -2).join(' - '),
    place: parts[parts.length - 2]!,
    date: parseUsDate(parts[parts.length - 1]!),
  };
}
const toks = (s: string | null | undefined): string[] =>
  foldForSearch(s ?? '')
    .split(' ')
    .filter(Boolean);

function rankRequests(ctx: Ctx, draft: DcResponseDraft, rows: ResponseRow[], unknown: boolean[]): RequestCandidate[] {
  const heads = ctx.repos.requests.list({
    offset: 0,
    limit: 200,
    statuses: ['validated', 'received', 'exported', 'sent-to-dc', 'responded'],
    sort: 'receivedAt',
    direction: 'desc',
  }).items;
  const a = splitAssistance(draft.assistanceLine ?? '');
  const rowUnits = new Set(rows.map((r) => foldUnitName(r.unitName)).filter(Boolean));
  const indiv = rows.filter((r) => isIndividualSection(r.section));
  const out: RequestCandidate[] = [];
  for (const h of heads) {
    let score = 0;
    if (draft.batchId && h.batchId === draft.batchId) score += 0.5;
    const ev = toks(h.eventName);
    if (ev.length > 0 && toks(a.event).length > 0) score += 0.25 * tokenSetJaroWinkler(toks(a.event), ev);
    if (a.place && h.eventLocation && foldForSearch(a.place) === foldForSearch(h.eventLocation)) score += 0.05;
    if (a.date && h.eventStart) {
      const d = Math.abs(daysBetween(a.date, h.eventStart));
      score += d === 0 ? 0.15 : d <= 7 ? 0.08 : 0;
    }
    const reqUnits = new Set(h.units.map((u) => foldUnitName(u.name)));
    if (rowUnits.size > 0) score += (0.15 * [...rowUnits].filter((u) => reqUnits.has(u)).length) / rowUnits.size;
    if (indiv.length > 0 && score > 0) {
      const items = ctx.repos.requests.listItems(h.id);
      const ms = matchRows(ctx, rows, unknown, items);
      const hit = rows.filter(
        (r, i) => isIndividualSection(r.section) && ms[i]!.candidates.some((c) => c.tier === 'T1' || c.tier === 'T2'),
      ).length;
      score += (0.4 * hit) / indiv.length;
    }
    if (score > 0) out.push({ requestId: h.id, eventName: h.eventName, score: Math.round(score * 1000) / 1000 });
  }
  return out.sort((x, y) => y.score - x.score || (x.requestId < y.requestId ? -1 : 1));
}

const norm = (s: string | null | undefined): string =>
  (s ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toUpperCase();

/**
 * Content fingerprint of a DC response, independent of the file bytes (security review F-13): a copy re-saved in
 * Excel has new bytes (zip timestamps, styles) but the same batch, date and rows. Only what the DC stated counts:
 * section, disposition, name, DOB, POB, unit, certification and expiry dates, case- and whitespace-folded, rows
 * sorted. Computed the same way from stored rows, so earlier imports are recognised too.
 */
export function responseContentHash(
  head: { batchId: string | null; resultsAsOf: string | null },
  rows: readonly Pick<
    ResponseRow,
    'section' | 'disp' | 'nameRaw' | 'dob' | 'pob' | 'unitName' | 'certDate' | 'expires'
  >[],
): string {
  const date = (d: { parsed: string | null; value: string }) => d.parsed ?? norm(d.value);
  const lines = rows
    .map((r) =>
      [
        r.section,
        norm(r.disp),
        norm(r.nameRaw),
        date(r.dob),
        norm(r.pob.city),
        norm(r.pob.state),
        norm(r.pob.country),
        norm(r.unitName),
        date(r.certDate),
        date(r.expires),
      ].join('\u001f'),
    )
    .sort();
  return sha256Hex(new TextEncoder().encode([norm(head.batchId), head.resultsAsOf ?? '', ...lines].join('\u001e')));
}

/** An earlier response with the same content (same batch id), if any. */
function sameContentAs(ctx: Ctx, batchId: string | null, resultsAsOf: string | null, hash: string): Ulid | null {
  if (!batchId) return null;
  const ids = (
    ctx.db
      .prepare('SELECT id, results_as_of AS r FROM response WHERE batch_id = ? ORDER BY imported_at, id')
      .all(batchId) as {
      id: string;
      r: string | null;
    }[]
  ).filter((x) => (x.r ?? '') === (resultsAsOf ?? ''));
  for (const { id } of ids) {
    if (responseContentHash({ batchId, resultsAsOf }, ctx.repos.responses.listRows(id)) === hash) return id;
  }
  return null;
}

function planResponse(ctx: Ctx, fileName: string, bytes: Uint8Array, requestId: Ulid | null): PlannedResponse {
  const parsed = parseFinalResults(bytes);
  const responseId = newId();
  const unknownCommander = parsed.draft.rows.map((r) => r.unknownCommander);
  const rows: ResponseRow[] = parsed.draft.rows.map((r) => ({
    id: newId(),
    responseId,
    rowRef: r.rowRef,
    section: r.section,
    disp: r.disp,
    nameRaw: r.nameRaw,
    name: r.name,
    nameKey: buildNameKey(r.name),
    dob: r.dob,
    pob: r.pob,
    unitType: r.unitType,
    unitName: r.unitName,
    certDate: r.certDate,
    expires: r.expires,
    match: NO_MATCH,
    dispClass: r.dispClass,
    sectionSource: r.sectionSource,
  }));
  if (requestId !== null) {
    if (!ctx.repos.requests.exists(requestId)) return fail('NOT_FOUND', 'Request not found');
    const ms = matchRows(ctx, rows, unknownCommander, ctx.repos.requests.listItems(requestId));
    rows.forEach((r, i) => (r.match = ms[i]!));
  }
  const sha = sha256Hex(bytes);
  const duplicateOf = ctx.repos.responses.findBySourceSha256(sha)[0]?.id ?? null;
  const issues = parsed.issues.map(mapIssue);
  if (duplicateOf === null && !parsed.blocked) {
    const same = sameContentAs(
      ctx,
      parsed.draft.batchId,
      parsed.draft.resultsAsOf,
      responseContentHash({ batchId: parsed.draft.batchId, resultsAsOf: parsed.draft.resultsAsOf }, rows),
    );
    if (same)
      issues.push({
        code: 'DUPLICATE_ROW',
        severity: 'warning',
        rowRef: null,
        field: null,
        message:
          '[F-13 RESPONSE_RESAVED] This file has the same content as a DC response that is already imported (a re-saved copy?). Importing it again records every result a second time.',
      });
  }
  // Items that already have a DC answer from an earlier response.
  for (const r of rows) {
    const itemId = r.match.decision === 'auto' ? r.match.chosen : null;
    if (itemId && ctx.repos.responses.rowsByRequestItem(itemId).length > 0)
      issues.push({
        code: 'DUPLICATE_ROW',
        severity: 'warning',
        rowRef: r.rowRef,
        field: null,
        message:
          '[F-13 ITEM_ALREADY_ANSWERED] This person already has a DC result for this request from an earlier response.',
      });
  }
  return {
    responseId,
    fileName,
    bytes,
    sha256: sha,
    draft: parsed.draft,
    unknownCommander,
    rows,
    matchedRequestId: requestId,
    issues,
    blocked: parsed.blocked,
    duplicateOf,
    candidates: parsed.blocked ? [] : rankRequests(ctx, parsed.draft, rows, unknownCommander),
    fileKindGuess: parsed.fileKindGuess,
  };
}

function unansweredItems(rows: ResponseRow[], items: RequestItem[]): Ulid[] {
  const touched = new Set<Ulid>();
  for (const r of rows) {
    if (!isIndividualSection(r.section)) continue;
    if (r.match.chosen) touched.add(r.match.chosen);
    for (const c of r.match.candidates) touched.add(c.targetId);
  }
  return items.filter((i) => !touched.has(i.id)).map((i) => i.id);
}

function previewOf(previewId: string, p: PlannedResponse, items: RequestItem[]): ResponsePreviewEx {
  const byId = new Map(items.map((i) => [i.id, i]));
  const indiv = p.rows.filter((r) => isIndividualSection(r.section));
  return {
    previewId,
    fileName: p.fileName,
    sha256: p.sha256,
    batchId: p.draft.batchId,
    fileKindGuess: p.fileKindGuess,
    post: p.draft.post ?? '',
    resultsAsOf: p.draft.resultsAsOf,
    assistanceLine: p.draft.assistanceLine ?? '',
    suggestedRequestId: p.matchedRequestId ?? p.candidates[0]?.requestId ?? null,
    rows: p.rows.map((r): ResponsePreviewRow => ({
      rowId: r.id,
      rowRef: r.rowRef,
      section: r.section,
      disp: r.disp,
      nameRaw: r.nameRaw,
      dobRaw: r.dob.value,
      certDate: r.certDate.parsed,
      expires: r.expires.parsed,
      unitName: r.unitName,
      candidates: r.match.candidates,
      decision: r.match.decision,
      chosenRequestItemId: r.match.decision === 'auto' ? r.match.chosen : null,
      chosenPersonId:
        r.match.decision === 'auto' && r.match.chosen ? (byId.get(r.match.chosen)?.personId ?? null) : null,
      dispClass: r.dispClass,
      sectionSource: r.sectionSource,
    })),
    issues: p.issues,
    errorCount: p.issues.filter((i) => i.severity === 'error').length,
    warningCount: p.issues.filter((i) => i.severity === 'warning').length,
    autoMatchedCount: indiv.filter((r) => r.match.decision === 'auto').length,
    needsReviewCount: indiv.filter((r) => r.match.decision === 'pending').length,
    unmatchedCount: indiv.filter((r) => r.match.decision === 'none').length,
    unansweredItemIds: p.matchedRequestId ? unansweredItems(p.rows, items) : [],
    duplicateOfResponseId: p.duplicateOf,
    canCommit: !p.blocked && p.duplicateOf === null,
    requestCandidates: p.candidates,
    matchedRequestId: p.matchedRequestId,
    rowIds: p.rows.map((r) => r.id),
  };
}

function summarize(ctx: Ctx, h: ResponseHeader): ResponseSummary {
  const rows = ctx.repos.responses.listRows(h.id);
  return {
    id: h.id,
    batchId: h.batchId,
    post: h.post,
    resultsAsOf: h.resultsAsOf,
    importedAt: h.importedAt,
    requestId: h.requestId,
    rowCount: rows.length,
    approvedCount: rows.filter((r) => r.dispClass === 'approved').length,
    nonApprovedCount: rows.filter((r) => r.dispClass === 'non-approved').length,
    unresolvedCount: rows.filter(
      (r) => isIndividualSection(r.section) && (r.match.decision === 'pending' || r.match.decision === 'none'),
    ).length,
  };
}

/** Unit for a unit-section row: a unit of the request (name or alias), else any unit with that name. */
function unitForRow(ctx: Ctx, row: ResponseRow, request: VettingRequest | null): Ulid | null {
  const f = foldUnitName(row.unitName);
  if (f === '') return null;
  if (request) {
    const ids = [...new Set(request.items.map((i) => i.unitId).filter((u): u is Ulid => !!u))];
    const u = ctx.repos.units
      .getMany(ids)
      .find((x) => foldUnitName(x.name) === f || x.aliases.some((a) => foldUnitName(a) === f));
    if (u) return u.id;
  }
  return ctx.repos.units.findByName(row.unitName)[0]?.id ?? null;
}

/** Unit record exactly as stated by a DC unit row whose disposition is known. */
function unitRecordFromRow(
  row: ResponseRow,
  unitId: Ulid,
  requestId: Ulid,
  commanderPersonId: Ulid | null,
  at: string,
): Omit<UnitVettingRecord, 'id'> {
  return {
    unitId,
    requestId,
    responseRowId: row.id,
    commanderPersonId,
    disposition: row.dispClass === 'approved' ? 'approved' : 'non-approved',
    certDate: row.certDate.parsed,
    expiresAt: row.expires.parsed,
    recordedAt: at,
  };
}

export interface DispositionResolved {
  row: ResponseRow;
  recordsCreated: number;
}

/**
 * Resolve a disposition-unclear row (S-06): a person states the disposition the DC meant. The row's dispClass (and the
 * approval half of its section) are set, then the vetting record (individual linked to a person) or unit record
 * (unit row of a request) that import skipped is written exactly from the row's own dates. Runs inside the caller's
 * transaction; the caller audits (review.resolve 'set-disposition' writes one `review.resolve` event, ids only).
 */
export function resolveRowDisposition(
  ctx: Ctx,
  rowId: Ulid,
  disposition: 'approved' | 'non-approved',
): DispositionResolved {
  const row = ctx.repos.responses.getRow(rowId) ?? fail('NOT_FOUND', 'Response row not found');
  // Already set to the same value (e.g. by an edit in place) is a no-op write; a different known value is a conflict.
  if (row.dispClass !== 'unknown' && row.dispClass !== disposition)
    return fail('CONFLICT', 'The disposition of this row is already known');
  const individual = isIndividualSection(row.section);
  const at = ctx.nowIso();
  // Lane K provenance: the stated disposition is a correction (the DC original is snapshotted on the first one, the
  // section follows the class). The edit row names only the class change, never personal data.
  const out =
    row.dispClass === disposition ? row : ctx.repos.responses.correctRow(rowId, { ...row, dispClass: disposition });
  if (out !== row)
    ctx.repos.responses.addEdit({
      rowId,
      at,
      actor: ctx.actor(),
      reason: 'set-disposition',
      diff: { dispClass: { from: row.dispClass, to: disposition } },
    });
  const resp = ctx.repos.responses.getHeader(out.responseId)!;
  const links = ctx.repos.responses.rowLinks(rowId) ?? { requestItemId: null, personId: null };
  const item = links.requestItemId ? ctx.repos.requests.getItem(links.requestItemId) : null;
  let recordsCreated = 0;
  if (individual) {
    const personId = links.personId ?? item?.personId ?? null;
    if (personId && isLinkedDecision(out.match) && ctx.repos.vetting.listByResponseRow(rowId).length === 0) {
      ctx.repos.vetting.insert(recordFromRow(ctx, out, personId, item?.unitId ?? null, resp.requestId));
      recordsCreated++;
    }
  } else if (resp.requestId) {
    const request = ctx.repos.requests.get(resp.requestId);
    const unitId = unitForRow(ctx, out, request);
    const already = ctx.db.prepare('SELECT 1 AS x FROM unit_vetting_record WHERE response_row_id = ?').get(rowId);
    if (unitId && request && !already) {
      const commander = isLinkedDecision(out.match) ? (item?.personId ?? null) : null;
      ctx.repos.unitVetting.insert(unitRecordFromRow(out, unitId, request.id, commander, at));
      recordsCreated++;
    }
  }
  if (item) refreshItemPolicy(ctx, item.id);
  if (resp.requestId) ctx.hooks.onRequestAnswered(resp.requestId);
  return { row: out, recordsCreated };
}

function personReferenced(ctx: Ctx, id: Ulid): boolean {
  return !!ctx.db
    .prepare(
      `SELECT 1 AS x FROM request_item WHERE person_id = @id
       UNION ALL SELECT 1 FROM response_row WHERE person_id = @id
       UNION ALL SELECT 1 FROM vetting_record WHERE person_id = @id
       UNION ALL SELECT 1 FROM unit_vetting_record WHERE commander_person_id = @id
       UNION ALL SELECT 1 FROM person WHERE merged_into = @id
       UNION ALL SELECT 1 FROM merge_log WHERE survivor_id = @id OR merged_id = @id
       UNION ALL SELECT 1 FROM negative_pair WHERE a = @id OR b = @id LIMIT 1`,
    )
    .get({ id });
}

export function createResponsesService(deps: ServiceDeps): ResponsesService {
  const ctx = makeCtx(deps);
  const previews = new PreviewStore<PlannedResponse>(ctx.now);

  const importFile = (fileName: string, bytes: Uint8Array, requestId?: Ulid): Promise<Result<ResponsePreviewEx>> =>
    run(() => {
      const plan = planResponse(ctx, fileName, bytes, requestId ?? null);
      const id = newId();
      previews.put(id, plan);
      return previewOf(id, plan, requestId ? ctx.repos.requests.listItems(requestId) : []);
    });

  return {
    list: (q) =>
      run(() => {
        const ids = q.text && q.text.trim() !== '' ? searchIds(ctx.db, 'response', q.text) : undefined;
        const r = ctx.repos.responses.list({
          offset: q.offset,
          limit: q.limit,
          ...(q.requestId ? { requestId: q.requestId } : {}),
          ...(ids ? { ids } : {}),
        });
        return { items: r.items.map((h) => summarize(ctx, h)), total: r.total, offset: q.offset, limit: q.limit };
      }),

    get: ({ id }) => run(() => ctx.repos.responses.get(id) ?? fail('NOT_FOUND', 'Response not found')),

    importPreview: async ({ path, requestId }) => {
      let bytes: Uint8Array;
      try {
        bytes = await ctx.files.read(path);
      } catch {
        return { ok: false, error: { code: 'FILE_UNREADABLE', message: 'The file could not be read' } };
      }
      return importFile(baseName(path), bytes, requestId);
    },
    importFile,
    clearPreviews: () => previews.clear(),
    discardPreview: ({ previewId }) =>
      run((): Ack => {
        previews.delete(previewId);
        return { ok: true };
      }),

    importCommit: (req) =>
      run((): ResponseCommitOutcome => {
        const plan = previews.get(req.previewId);
        if (plan.blocked) return fail('FILE_INVALID', 'The response file cannot be imported (see issues)');
        if (ctx.repos.responses.findBySourceSha256(plan.sha256).length > 0)
          return fail('CONFLICT', 'This response file has already been imported');
        const request = req.requestId ? ctx.repos.requests.get(req.requestId) : null;
        if (req.requestId && !request) return fail('NOT_FOUND', 'Request not found');
        const items = request?.items ?? [];
        const itemById = new Map(items.map((i) => [i.id, i]));
        const rows = plan.rows.map((r) => ({ ...r }));
        if ((req.requestId ?? null) !== plan.matchedRequestId) {
          const ms = request ? matchRows(ctx, rows, plan.unknownCommander, items) : rows.map(() => NO_MATCH);
          rows.forEach((r, i) => (r.match = ms[i]!));
        }
        const decisions = req.decisions ?? {};
        const rowIds = new Set(rows.map((r) => r.id));
        for (const [rowId, d] of Object.entries(decisions)) {
          if (!rowIds.has(rowId)) return fail('BAD_REQUEST', 'Decision for an unknown row');
          if (d !== 'new' && d !== 'skip' && !itemById.has(d))
            return fail('BAD_REQUEST', 'Decision names an item outside the request');
        }
        const at = ctx.nowIso();
        const actor = ctx.actor();
        // Final decisions per row.
        const newPersonRows = new Set<Ulid>();
        for (const r of rows) {
          const d = decisions[r.id];
          if (d === 'skip')
            r.match = { ...r.match, decision: 'rejected', chosen: null, decidedBy: actor, decidedAt: at };
          else if (d === 'new') {
            newPersonRows.add(r.id);
            r.match = { ...r.match, decision: 'confirmed', chosen: null, decidedBy: actor, decidedAt: at };
          } else if (d) r.match = { ...r.match, decision: 'confirmed', chosen: d, decidedBy: actor, decidedAt: at };
          else if (r.match.decision === 'auto') r.match = { ...r.match };
          else if (r.match.decision !== 'none') r.match = { ...r.match, decision: 'pending', chosen: null };
        }
        // One-to-one: within each group (individuals / commanders) one item per row.
        for (const group of [true, false]) {
          const seen = new Set<Ulid>();
          for (const r of rows) {
            if (isIndividualSection(r.section) !== group || !isLinkedDecision(r.match) || !r.match.chosen) continue;
            if (seen.has(r.match.chosen)) return fail('BAD_REQUEST', 'Two rows are linked to the same request item');
            seen.add(r.match.chosen);
          }
        }

        // META_LABEL_MISSING: the wizard asks for the batch id when the file has none (or overrides it).
        const batchId = req.batchIdOverride?.trim() || plan.draft.batchId || '';
        const outcome = ctx.tx('responses.importCommit', () => {
          const file = ctx.repos.files.put({ originalName: plan.fileName, content: plan.bytes, storedAt: at });
          const rowInputs = rows.map((r) => {
            const item = r.match.chosen && isLinkedDecision(r.match) ? itemById.get(r.match.chosen) : undefined;
            const { id, responseId: _r, ...rest } = r;
            void _r;
            return { ...rest, id, requestItemId: item?.id ?? null, personId: item?.personId ?? null };
          });
          ctx.repos.responses.insert(
            {
              id: plan.responseId,
              batchId,
              post: plan.draft.post ?? '',
              resultsAsOf: plan.draft.resultsAsOf ?? ('' as IsoDate),
              assistanceLine: plan.draft.assistanceLine ?? '',
              sourceFileId: file.id,
              importedAt: at,
              requestId: request?.id ?? null,
            },
            rowInputs,
          );
          let recordsCreated = 0;
          let reviewItemsCreated = 0;
          const answered = new Set<Ulid>();
          rows.forEach((r, i) => {
            const linkedItem = r.match.chosen && isLinkedDecision(r.match) ? itemById.get(r.match.chosen) : undefined;
            // S-06: an unclear disposition is a review item of its own and no record is written until a person sets
            // it (resolveRowDisposition). Linking (who the row is) still follows the normal rules below.
            const unclear = r.dispClass === 'unknown';
            if (unclear) {
              ctx.repos.reviews.insert({
                kind: 'disposition-unclear',
                subjectIds: [r.id],
                candidates: r.match.candidates,
                createdAt: at,
              });
              reviewItemsCreated++;
            }
            if (isIndividualSection(r.section)) {
              if (linkedItem) {
                answered.add(linkedItem.id);
                if (linkedItem.personId && !unclear) {
                  ctx.repos.vetting.insert(
                    recordFromRow(ctx, r, linkedItem.personId, linkedItem.unitId, request?.id ?? null),
                  );
                  addAliasIfNew(ctx, linkedItem.personId, r.name, `response:${plan.responseId}`, linkedItem.id);
                  recordsCreated++;
                }
              } else if (newPersonRows.has(r.id)) {
                const p = ctx.repos.persons.insert({ ...personInputFromRow(r, request?.id ?? null), at });
                ctx.repos.responses.setRowMatch(r.id, r.match, { requestItemId: null, personId: p.id });
                if (!unclear) {
                  ctx.repos.vetting.insert(recordFromRow(ctx, r, p.id, null, request?.id ?? null));
                  recordsCreated++;
                }
              } else if (r.match.decision === 'pending') {
                // Items proposed for a pending row are 'answered pending review', not unanswered.
                for (const c of r.match.candidates) answered.add(c.targetId);
                ctx.repos.reviews.insert({
                  kind: 'response-row-match',
                  subjectIds: [r.id],
                  candidates: r.match.candidates,
                  createdAt: at,
                });
                reviewItemsCreated++;
              } else if (r.match.decision === 'none') {
                ctx.repos.reviews.insert({
                  kind: 'unmatched-response-row',
                  subjectIds: [r.id],
                  candidates: [],
                  createdAt: at,
                });
                reviewItemsCreated++;
              }
              return;
            }
            // Unit / commander rows.
            if (!plan.unknownCommander[i] && r.match.decision === 'pending') {
              ctx.repos.reviews.insert({
                kind: 'response-row-match',
                subjectIds: [r.id],
                candidates: r.match.candidates,
                createdAt: at,
              });
              reviewItemsCreated++;
            }
            const unitId = unitForRow(ctx, r, request);
            if (unitId && request) {
              if (!unclear) {
                ctx.repos.unitVetting.insert(
                  unitRecordFromRow(r, unitId, request.id, linkedItem?.personId ?? null, at),
                );
                recordsCreated++;
              }
            } else {
              ctx.repos.reviews.insert({
                kind: 'unmatched-response-row',
                subjectIds: [r.id],
                candidates: [],
                createdAt: at,
              });
              reviewItemsCreated++;
            }
          });
          let responseDays: number | null = null;
          if (request) {
            for (const it of items)
              if (!answered.has(it.id)) {
                ctx.repos.reviews.insert({
                  kind: 'unanswered-request-item',
                  subjectIds: [it.id],
                  candidates: [],
                  createdAt: at,
                });
                reviewItemsCreated++;
              }
            ctx.repos.requests.update(request.id, {
              responseKind: 'dc-file',
              ...(request.batchId ? {} : { batchId: batchId || null }),
            });
            ctx.repos.requests.setStatus(request.id, 'responded', at);
            const h = ctx.repos.requests.getHeader(request.id)!;
            responseDays =
              h.sentToDcAt && h.respondedAt ? daysBetween(h.sentToDcAt.slice(0, 10), h.respondedAt.slice(0, 10)) : null;
          }
          if (request) ctx.hooks.onRequestAnswered(request.id);
          const header = ctx.repos.responses.getHeader(plan.responseId)!;
          const indiv = rows.filter((r) => isIndividualSection(r.section));
          ctx.audit('response.import', 'response', plan.responseId, {
            responseId: plan.responseId,
            requestId: request?.id ?? '',
            rowCount: rows.length,
            autoMatchedCount: indiv.filter((r) => r.match.decision === 'auto').length,
            needsReviewCount: indiv.filter((r) => r.match.decision === 'pending').length,
            unmatchedCount: indiv.filter((r) => r.match.decision === 'none').length,
            recordsCreated,
            reviewItemsCreated,
            sha256: plan.sha256,
          });
          return { response: summarize(ctx, header), recordsCreated, reviewItemsCreated, responseDays };
        });
        previews.delete(req.previewId);
        return outcome;
      }),

    setRowMatch: ({ rowId, chosen, decision }) =>
      run(() =>
        ctx.tx('responses.setRowMatch', () => {
          const row = ctx.repos.responses.getRow(rowId) ?? fail('NOT_FOUND', 'Response row not found');
          const resp = ctx.repos.responses.getHeader(row.responseId)!;
          for (const rec of ctx.repos.vetting.listByResponseRow(rowId)) ctx.repos.vetting.delete(rec.id);
          const at = ctx.nowIso();
          let out: ResponseRow;
          let answered: Ulid | null = resp.requestId;
          if (decision === 'confirmed') {
            if (!chosen) return fail('BAD_REQUEST', 'A confirmed match needs a target');
            const item = ctx.repos.requests.getItem(chosen);
            if (item) answered = item.requestId;
            let personId: Ulid | null;
            if (item) {
              if (resp.requestId && item.requestId !== resp.requestId)
                return fail('BAD_REQUEST', 'Item belongs to another request');
              const other = ctx.repos.responses
                .rowsByRequestItem(item.id)
                .find(
                  (r) =>
                    r.id !== rowId &&
                    r.responseId === resp.id &&
                    isIndividualSection(r.section) === isIndividualSection(row.section),
                );
              if (other) return fail('CONFLICT', 'Another row of this response is linked to that item');
              personId = item.personId;
            } else {
              const p = ctx.repos.persons.get(chosen);
              if (!p || p.state !== 'active') return fail('NOT_FOUND', 'Target not found');
              personId = p.id;
            }
            out = ctx.repos.responses.setRowMatch(
              rowId,
              { ...row.match, decision: 'confirmed', chosen, decidedBy: ctx.actor(), decidedAt: at },
              { requestItemId: item?.id ?? null, personId },
            );
            // A disposition-unclear row is linked but gets its record only once the disposition is set.
            if (personId && isIndividualSection(row.section) && row.dispClass !== 'unknown') {
              ctx.repos.vetting.insert(recordFromRow(ctx, out, personId, item?.unitId ?? null, resp.requestId));
              addAliasIfNew(ctx, personId, row.name, `response:${resp.id}`, item?.id ?? rowId);
            }
            if (item) {
              for (const r of ctx.repos.reviews.openForSubject(item.id))
                if (r.kind === 'unanswered-request-item') ctx.repos.reviews.resolve(r.id, 'resolved', 'answered', at);
            }
          } else {
            out = ctx.repos.responses.setRowMatch(
              rowId,
              { ...row.match, decision, chosen: null, decidedBy: ctx.actor(), decidedAt: at },
              { requestItemId: null, personId: null },
            );
          }
          if (decision !== 'none')
            for (const r of ctx.repos.reviews.openForSubject(rowId))
              ctx.repos.reviews.resolve(r.id, 'resolved', decision, at);
          ctx.audit('response.row-match', 'response-row', rowId, {
            responseId: resp.id,
            rowId,
            decision,
            section: row.section,
          });
          if (answered) ctx.hooks.onRequestAnswered(answered);
          return out;
        }),
      ),

    recordEmailClearance: (req) => run(() => recordEmailClearance(ctx, req)),

    recordManual: (req) =>
      run((): RecordsCreated =>
        ctx.tx('responses.recordManual', () => {
          const p = ctx.repos.persons.get(req.personId);
          if (!p || p.state !== 'active') return fail('NOT_FOUND', 'Person not found');
          const rec = ctx.repos.vetting.insert({
            personId: p.id,
            unitId: req.unitId,
            requestId: null,
            responseRowId: null,
            disposition: req.disposition,
            certDate: req.certDate,
            expiresAt: req.expiresAt,
            expiryAssumed: false,
            source: 'manual',
            recordedAt: ctx.nowIso(),
            recordedBy: ctx.actor(),
            note: req.note,
          });
          ctx.audit('vetting.record-manual', 'person', p.id, {
            personId: p.id,
            recordId: rec.id,
            disposition: req.disposition,
            source: 'manual',
          });
          return { recordIds: [rec.id] };
        }),
      ),

    undoImport: ({ id }) =>
      run(() =>
        ctx.tx('responses.undoImport', (): ResponseUndoResult => {
          const resp = ctx.repos.responses.get(id) ?? fail('NOT_FOUND', 'Response not found');
          const rowIds = resp.rows.map((r) => r.id);
          const rowJson = JSON.stringify(rowIds);
          const touched = new Set<Ulid>(
            (
              ctx.db
                .prepare(
                  `SELECT person_id AS id FROM response_row WHERE response_id = ? AND person_id IS NOT NULL
                   UNION SELECT person_id FROM vetting_record WHERE response_row_id IN (SELECT value FROM json_each(?))`,
                )
                .all(id, rowJson) as { id: string }[]
            ).map((r) => r.id),
          );
          const recordsDeleted = ctx.db
            .prepare('DELETE FROM vetting_record WHERE response_row_id IN (SELECT value FROM json_each(?))')
            .run(rowJson).changes;
          const unitRecordsDeleted = ctx.db
            .prepare('DELETE FROM unit_vetting_record WHERE response_row_id IN (SELECT value FROM json_each(?))')
            .run(rowJson).changes;
          let reviewItemsDeleted = ctx.db
            .prepare(
              'DELETE FROM review_item WHERE EXISTS (SELECT 1 FROM json_each(review_item.subject_ids_json) j WHERE j.value IN (SELECT value FROM json_each(?)))',
            )
            .run(rowJson).changes;
          if (resp.requestId) {
            const itemJson = JSON.stringify(ctx.repos.requests.listItems(resp.requestId).map((i) => i.id));
            reviewItemsDeleted += ctx.db
              .prepare(
                `DELETE FROM review_item WHERE kind = 'unanswered-request-item' AND created_at = ? AND
                 EXISTS (SELECT 1 FROM json_each(review_item.subject_ids_json) j WHERE j.value IN (SELECT value FROM json_each(?)))`,
              )
              .run(resp.importedAt, itemJson).changes;
          }
          ctx.db.prepare('DELETE FROM person_alias WHERE source_kind = ?').run(`response:${id}`);
          ctx.repos.responses.delete(id);
          const personsDeleted: Ulid[] = [];
          for (const pid of touched) {
            const k = ctx.repos.persons.keys(pid);
            const p = ctx.repos.persons.get(pid);
            // Only persons this response created ('new' decisions) are removed, and only when nothing else uses them.
            if (p && k && p.createdAt === resp.importedAt && !personReferenced(ctx, pid)) {
              ctx.repos.persons.delete(pid);
              personsDeleted.push(pid);
            }
          }
          if (!ctx.repos.files.isReferenced(resp.sourceFile.id)) ctx.repos.files.delete(resp.sourceFile.id);
          if (resp.requestId) {
            const h = ctx.repos.requests.getHeader(resp.requestId);
            if (
              h &&
              h.status !== 'closed' &&
              h.responseKind === 'dc-file' &&
              ctx.repos.responses.listByRequest(h.id).length === 0
            ) {
              ctx.repos.requests.update(h.id, { respondedAt: null, responseKind: null });
              if (h.sentToDcAt) ctx.repos.requests.setStatus(h.id, 'sent-to-dc', h.sentToDcAt);
              else ctx.repos.requests.setStatus(h.id, 'exported', ctx.nowIso());
            }
            for (const it of ctx.repos.requests.listItems(resp.requestId)) refreshItemPolicy(ctx, it.id);
            ctx.hooks.onRequestAnswered(resp.requestId);
          }
          ctx.audit('response.undo-import', 'response', id, {
            responseId: id,
            rowCount: rowIds.length,
            personsDeleted: personsDeleted.length,
          });
          return {
            responseId: id,
            rowsDeleted: rowIds.length,
            recordsDeleted,
            unitRecordsDeleted,
            reviewItemsDeleted,
            personsDeleted,
          };
        }),
      ),
  };
}
