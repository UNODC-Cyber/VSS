/**
 * `review.*` service (WP-13): the queue of flagged identity decisions. Every resolution is explicit and audited once:
 * link (confirm the proposed candidate or choose another), new-person, not-same (adds negative pairs), merge,
 * keep-dob, set-disposition, dismiss (skip).
 *
 * Lane K (docs/PLAN-ALPHA.md section 14) adds two explicit, reasoned user actions; neither changes the automatic
 * linking rules and neither ever produces an automatic link:
 *  - manualValidate: the reviewer asserts that a response row is a valid DC answer for a chosen person, request item
 *    or a new person; the row is linked as `confirmed` by the actor and exactly one vetting record is created from
 *    the row's own disposition / cert date / expiry. The reason is kept on the review item, never in the audit.
 *  - editSubject: correct a response row (DC typo) or the linked person in place. The DC original is snapshotted on
 *    the first edit (`original_json`), every edit is recorded (`response_row_edit` / `person_edit`) and an EMPTY row
 *    patch reverts the row to the DC original byte for byte. Candidates are recomputed after a row edit and shown
 *    again, always as `pending` (a human still decides).
 */
import type {
  DispClass,
  MatchCandidate,
  MatchTier,
  PersonName,
  RawDate,
  ResponseRow,
  ReviewItem,
  ReviewKind,
  RowMatch,
  Ulid,
} from '@shared/domain/types';
import type {
  IdRef,
  Page,
  ResponseRowPatch,
  ReviewCounts,
  ReviewEditSubjectRequest,
  ReviewItemContext,
  ReviewItemDetail,
  ReviewItemSummary,
  ReviewListQuery,
  ReviewManualValidateRequest,
  ReviewResolveRequest,
  ReviewSubject,
  Result,
} from '@shared/ipc/contract';
import { buildNameKey } from '@shared/names/key';
import { splitDcName } from '@shared/names/personName';
import type { ReviewItemRow } from '../db/repos/reviewItem';
import { requestIdsOfSubjects } from './hooks';
import { matchResponseRows } from '../matching/matcher';
import { observedName, parseSex } from '../matching/records';
import {
  addAliasIfNew,
  createPersonForItem,
  isIndividualSection,
  isLinkedDecision,
  linkItemToPerson,
  personInputFromObserved,
  personInputFromRow,
  recordFromRow,
  refreshItemPolicy,
} from './people-ops';
import { mergePersons, personEdits, updatePersonWithProvenance } from './people';
import { resolveRowDisposition } from './responses';
import { displayName, fail, makeCtx, run } from './vetting-common';
import type { Ctx, ServiceDeps } from './vetting-common';

export interface ReviewService {
  list(req: ReviewListQuery): Promise<Result<Page<ReviewItemSummary>>>;
  get(req: IdRef): Promise<Result<ReviewItemDetail>>;
  resolve(req: ReviewResolveRequest): Promise<Result<ReviewCounts>>;
  counts(): Promise<Result<ReviewCounts>>;
  /** Lane K: assert a response row is a valid DC answer for the target (reason >= 3 chars). */
  manualValidate(req: ReviewManualValidateRequest): Promise<Result<ReviewCounts>>;
  /** Lane K: correct a response row or person in place (empty row patch = revert to the DC original). */
  editSubject(req: ReviewEditSubjectRequest): Promise<Result<ReviewItemDetail>>;
}

/** Minimum length of a manual action's reason (trimmed). */
export const REASON_MIN_LENGTH = 3;
/** Review kinds whose response-row subject may be manually validated. */
const VALIDATE_KINDS: ReadonlySet<ReviewKind> = new Set([
  'response-row-match',
  'unmatched-response-row',
  'request-item-link',
]);

const TIER_ORDER: readonly MatchTier[] = ['T1', 'T2', 'T3', 'T4'];
function bestTierOf(item: ReviewItem): MatchTier | null {
  let best: number | null = null;
  for (const c of item.candidates) {
    const i = TIER_ORDER.indexOf(c.tier);
    if (best === null || i < best) best = i;
  }
  return best === null ? null : TIER_ORDER[best]!;
}

/** Where the item's first subject comes from: the request (items) or the DC response (rows). */
function contextOf(ctx: Ctx, id: Ulid | undefined): ReviewItemContext | null {
  if (!id) return null;
  const it = ctx.repos.requests.getItem(id);
  if (it) {
    const h = ctx.repos.requests.getHeader(it.requestId);
    return h ? { requestId: h.id, eventName: h.eventName } : null;
  }
  const row = ctx.repos.responses.getRow(id);
  if (row) {
    const h = ctx.repos.responses.getHeader(row.responseId);
    return h ? { responseId: h.id, batchId: h.batchId } : null;
  }
  return null;
}

/** List row: the item plus who it is about (first subject) and where it comes from. */
function summaryOf(ctx: Ctx, item: ReviewItem): ReviewItemSummary {
  const first = item.subjectIds[0];
  const s = first ? subjectOf(ctx, first) : null;
  return {
    ...item,
    subjectName: s?.displayName ?? '',
    subjectDob: s?.dob ?? null,
    unitName: s?.unitName ?? null,
    context: contextOf(ctx, first),
    bestTier: bestTierOf(item),
  };
}

const rowSubject = (r: ResponseRow): Omit<ReviewSubject, 'id' | 'edited' | 'original'> => ({
  kind: 'response-row',
  displayName: displayName(r.name),
  dob: r.dob.parsed,
  dobRaw: r.dob.value,
  sex: null,
  pobCountry: r.pob.country,
  unitName: r.unitName || null,
  identifiers: [],
  source: `response ${r.rowRef}`,
});

function subjectOf(ctx: Ctx, id: Ulid): ReviewSubject | null {
  const p = ctx.repos.persons.get(id);
  if (p) {
    const items = ctx.repos.requests.itemsByPerson(id);
    const unitId = items[items.length - 1]?.unitId ?? null;
    const edits = personEdits(ctx, id);
    const subject: ReviewSubject = {
      id,
      kind: 'person',
      displayName: displayName(p.canonical),
      dob: p.dob,
      dobRaw: p.dob ?? '',
      sex: p.sex,
      pobCountry: p.pob.country,
      unitName: unitId ? (ctx.repos.units.get(unitId)?.name ?? null) : null,
      identifiers: p.identifiers.map((i) => i.value),
      source: 'person',
      edited: edits.length > 0,
    };
    if (edits.length > 0) {
      // The first recorded value of each corrected field is what the person record said before any correction.
      const first = (k: string): unknown => edits.find((e) => k in e.diff)?.diff[k]?.from;
      const original: ReviewSubject['original'] = {};
      const canonical = first('canonical') as PersonName | undefined;
      if (canonical) original.displayName = displayName(canonical);
      if (edits.some((e) => 'dob' in e.diff)) {
        const dob = (first('dob') as string | null | undefined) ?? null;
        original.dob = dob;
        original.dobRaw = dob ?? '';
      }
      const pob = first('pob') as { country: string | null } | undefined;
      if (pob) original.pobCountry = pob.country;
      if (edits.some((e) => 'sex' in e.diff)) original.sex = (first('sex') as ReviewSubject['sex']) ?? null;
      subject.original = original;
    }
    return subject;
  }
  const it = ctx.repos.requests.getItem(id);
  if (it) {
    const o = it.observed;
    return {
      id,
      kind: 'request-item',
      displayName: displayName(observedName(o)),
      dob: o.dob.parsed,
      dobRaw: o.dob.value,
      sex: parseSex(o.sex),
      pobCountry: o.pobCountry || null,
      unitName: o.unitName || null,
      identifiers: [o.passport, o.nationalId].map((s) => s.trim()).filter(Boolean),
      source: `request ${o.rowRef}`,
      edited: false,
    };
  }
  const r = ctx.repos.responses.getRow(id);
  if (r) {
    const orig = ctx.repos.responses.originalRow(id);
    if (!orig) return { id, ...rowSubject(r), edited: false };
    const o = rowSubject(orig);
    return {
      id,
      ...rowSubject(r),
      edited: true,
      original: {
        displayName: o.displayName,
        dob: o.dob,
        dobRaw: o.dobRaw,
        pobCountry: o.pobCountry,
        unitName: o.unitName,
      },
    };
  }
  return null;
}

/** Link a response row to a request item or a person (explicit decision) and record what the row states. */
function linkRow(ctx: Ctx, rowId: Ulid, targetId: Ulid): void {
  const row = ctx.repos.responses.getRow(rowId) ?? fail('NOT_FOUND', 'Response row not found');
  const resp = ctx.repos.responses.getHeader(row.responseId)!;
  const item = ctx.repos.requests.getItem(targetId);
  let personId: Ulid | null = null;
  if (item) {
    if (resp.requestId && item.requestId !== resp.requestId)
      return fail('BAD_REQUEST', 'Item belongs to another request');
    const clash = ctx.repos.responses
      .rowsByRequestItem(item.id)
      .some(
        (x) =>
          x.id !== rowId &&
          x.responseId === resp.id &&
          isIndividualSection(x.section) === isIndividualSection(row.section),
      );
    if (clash) return fail('CONFLICT', 'Another row of this response is linked to that item');
    personId = item.personId;
  } else {
    const p = ctx.repos.persons.get(targetId);
    if (!p || p.state !== 'active') return fail('NOT_FOUND', 'Target not found');
    personId = p.id;
  }
  const at = ctx.nowIso();
  const out = ctx.repos.responses.setRowMatch(
    rowId,
    { ...row.match, decision: 'confirmed', chosen: targetId, decidedBy: ctx.actor(), decidedAt: at },
    { requestItemId: item?.id ?? null, personId },
  );
  if (
    personId &&
    isIndividualSection(row.section) &&
    row.dispClass !== 'unknown' && // lane C: no record until the disposition is set
    ctx.repos.vetting.listByResponseRow(rowId).length === 0
  ) {
    ctx.repos.vetting.insert(recordFromRow(ctx, out, personId, item?.unitId ?? null, resp.requestId));
    addAliasIfNew(ctx, personId, row.name, `response:${resp.id}`, item?.id ?? rowId);
  }
  if (item)
    for (const r of ctx.repos.reviews.openForSubject(item.id))
      if (r.kind === 'unanswered-request-item') ctx.repos.reviews.resolve(r.id, 'resolved', 'answered', at);
}

function resolveOne(ctx: Ctx, req: ReviewResolveRequest): ReviewItem {
  const item = ctx.repos.reviews.get(req.id) ?? fail('NOT_FOUND', 'Review item not found');
  if (item.state !== 'open') return fail('CONFLICT', 'Review item is already closed');
  const res = req.resolution;
  const subject = item.subjectIds[0] ?? fail('CONFLICT', 'Review item has no subject');
  const at = ctx.nowIso();
  const close = (resolution: string, state: 'resolved' | 'dismissed' = 'resolved'): ReviewItem => {
    // linkItemToPerson may already have closed it.
    const now = ctx.repos.reviews.get(item.id)!;
    return now.state === 'open' ? ctx.repos.reviews.resolve(item.id, state, resolution, at) : now;
  };
  const personCandidates = item.candidates.filter((c) => c.targetKind === 'person').map((c) => c.targetId);

  switch (res.action) {
    case 'dismiss':
      return close('dismissed', 'dismissed');

    case 'link': {
      if (item.kind === 'request-item-link' || item.kind === 'dob-conflict') {
        let personId = res.targetId;
        const other = ctx.repos.requests.getItem(res.targetId);
        if (other) {
          // In-batch duplicate: link to the person the other row is linked to.
          if (!other.personId) return fail('UNRESOLVED_REVIEW', 'Resolve the other row first');
          personId = other.personId;
        }
        linkItemToPerson(ctx, subject, personId, 'confirmed');
        return close(`linked:${personId === res.targetId ? 'target' : 'via-item'}`);
      }
      if (item.kind === 'response-row-match' || item.kind === 'unmatched-response-row') {
        linkRow(ctx, subject, res.targetId);
        return close('linked');
      }
      if (item.kind === 'unanswered-request-item') {
        // target = the response row that answers this item
        linkRow(ctx, res.targetId, subject);
        return close('linked');
      }
      return fail('BAD_REQUEST', 'Use merge or not-same for duplicate persons');
    }

    case 'new-person': {
      if (item.kind === 'request-item-link') {
        const linked = createPersonForItem(ctx, subject);
        for (const c of personCandidates) ctx.repos.negativePairs.add(linked.personId!, c, at);
        return close('new-person');
      }
      if (item.kind === 'response-row-match' || item.kind === 'unmatched-response-row') {
        const row = ctx.repos.responses.getRow(subject) ?? fail('NOT_FOUND', 'Response row not found');
        const resp = ctx.repos.responses.getHeader(row.responseId)!;
        const p = ctx.repos.persons.insert({ ...personInputFromRow(row, resp.requestId), at });
        const out = ctx.repos.responses.setRowMatch(
          row.id,
          { ...row.match, decision: 'confirmed', chosen: null, decidedBy: ctx.actor(), decidedAt: at },
          { requestItemId: null, personId: p.id },
        );
        if (isIndividualSection(row.section) && row.dispClass !== 'unknown')
          ctx.repos.vetting.insert(recordFromRow(ctx, out, p.id, null, resp.requestId));
        return close('new-person');
      }
      return fail('BAD_REQUEST', 'new-person does not apply to this review kind');
    }

    case 'not-same': {
      if (item.kind === 'duplicate-persons') {
        const [a, b] = item.subjectIds;
        if (!a || !b) return fail('CONFLICT', 'Review item needs two subjects');
        ctx.repos.negativePairs.add(a, b, at);
        return close('not-same');
      }
      // The subject is none of the candidates.
      for (const c of item.candidates) ctx.repos.negativePairs.add(subject, c.targetId, at);
      if (item.kind === 'request-item-link') {
        const linked = createPersonForItem(ctx, subject);
        for (const c of personCandidates) ctx.repos.negativePairs.add(linked.personId!, c, at);
        return close('not-same');
      }
      if (item.kind === 'response-row-match') {
        const row = ctx.repos.responses.getRow(subject) ?? fail('NOT_FOUND', 'Response row not found');
        ctx.repos.responses.setRowMatch(row.id, {
          ...row.match,
          decision: 'rejected',
          chosen: null,
          decidedBy: ctx.actor(),
          decidedAt: at,
        });
        ctx.repos.reviews.insert({
          kind: 'unmatched-response-row',
          subjectIds: [row.id],
          candidates: [],
          createdAt: at,
        });
        return close('not-same');
      }
      return close('not-same');
    }

    case 'merge': {
      if (item.kind !== 'duplicate-persons') return fail('BAD_REQUEST', 'merge applies to duplicate persons only');
      if (!item.subjectIds.includes(res.survivorId) || !item.subjectIds.includes(res.mergedId))
        return fail('BAD_REQUEST', 'Merge must name the two subjects of the review item');
      mergePersons(ctx, res.survivorId, res.mergedId, 'review');
      return close('merged');
    }

    case 'keep-dob': {
      const src = ctx.repos.requests.getItem(res.subjectId);
      const target = item.subjectIds.map((s) => ctx.repos.persons.get(s)).find((p) => p !== null) ?? null;
      if (src && target) {
        ctx.repos.persons.update(target.id, {
          dob: src.observed.dob.parsed,
          dobPrecision: src.observed.dob.ambiguousDayMonth ? 'ambiguous-dm' : 'exact',
        });
        return close('keep-dob:item');
      }
      if (!ctx.repos.persons.get(res.subjectId)) return fail('NOT_FOUND', 'Subject not found');
      return close('keep-dob:person');
    }

    case 'set-disposition':
      // disposition-unclear items are created at import (lane C). One path: responses.resolveRowDisposition sets the
      // stated disposition as a recorded correction (DC original kept, lane K) and writes the record(s) it now allows.
      if (item.kind !== 'disposition-unclear')
        return fail('BAD_REQUEST', 'set-disposition applies to disposition-unclear items only');
      resolveRowDisposition(ctx, subject, res.disposition);
      return close(`set-disposition:${res.disposition}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Lane K: manual validation and edit in place
// ---------------------------------------------------------------------------------------------------------------

const requireReason = (reason: string): string => {
  const r = reason.trim();
  if (r.length < REASON_MIN_LENGTH) return fail('REASON_REQUIRED', 'A reason of at least 3 characters is required');
  return r;
};

const rawDateOf = (d: string | null): RawDate =>
  d
    ? { kind: 'text', value: d, parsed: d, ambiguousDayMonth: false }
    : { kind: 'empty', value: '', parsed: null, ambiguousDayMonth: false };

/** The correctable fields of a row, in the shape of the patch (diff and revert detection). */
function projection(r: ResponseRow): Required<ResponseRowPatch> {
  return {
    nameRaw: r.nameRaw,
    dob: r.dob.parsed,
    pob: { city: r.pob.city, state: r.pob.state, country: r.pob.country },
    unitName: r.unitName,
    certDate: r.certDate.parsed,
    expires: r.expires.parsed,
    dispClass: r.dispClass,
  };
}

/** A new row value with the patch applied; the name key is rebuilt exactly as at import (splitDcName). */
function applyRowPatch(row: ResponseRow, patch: ResponseRowPatch): ResponseRow {
  const next: ResponseRow = { ...row };
  if (patch.nameRaw !== undefined) {
    next.nameRaw = patch.nameRaw;
    next.name = splitDcName(patch.nameRaw);
    next.nameKey = buildNameKey(next.name);
  }
  if (patch.dob !== undefined) next.dob = rawDateOf(patch.dob);
  if (patch.pob !== undefined) next.pob = { ...patch.pob };
  if (patch.unitName !== undefined) next.unitName = patch.unitName;
  if (patch.certDate !== undefined) next.certDate = rawDateOf(patch.certDate);
  if (patch.expires !== undefined) next.expires = rawDateOf(patch.expires);
  if (patch.dispClass !== undefined) next.dispClass = patch.dispClass as DispClass;
  return next;
}

function diffOf(a: ResponseRow, b: ResponseRow): Record<string, { from: unknown; to: unknown }> {
  const pa = projection(a);
  const pb = projection(b);
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(pa) as (keyof typeof pa)[])
    if (JSON.stringify(pa[k]) !== JSON.stringify(pb[k])) out[k] = { from: pa[k], to: pb[k] };
  return out;
}

/** Write a correction (DC original kept on the first one) and its provenance row. Returns the corrected row. */
function correctRowRecorded(ctx: Ctx, row: ResponseRow, next: ResponseRow, reason: string): ResponseRow {
  const diff = diffOf(row, next);
  const out = ctx.repos.responses.correctRow(row.id, next);
  ctx.repos.responses.addEdit({ rowId: row.id, at: ctx.nowIso(), actor: ctx.actor(), reason, diff });
  return out;
}

/**
 * Recompute the candidates of a corrected row against the items of its request (within-request, like at import) and
 * show them again: the decision is always 'pending' (or 'none'), never 'auto'; links are cleared.
 */
function rematchRow(ctx: Ctx, rowId: Ulid, item: ReviewItemRow): MatchCandidate[] {
  const row = ctx.repos.responses.getRow(rowId)!;
  const resp = ctx.repos.responses.getHeader(row.responseId)!;
  const items = resp.requestId ? (ctx.repos.requests.get(resp.requestId)?.items ?? []) : [];
  const candidates = items.length > 0 ? (matchResponseRows([row], items)[0]?.candidates ?? []) : [];
  const match: RowMatch = {
    candidates,
    decision: candidates.length > 0 ? 'pending' : 'none',
    chosen: null,
    decidedBy: null,
    decidedAt: null,
  };
  ctx.repos.responses.setRowMatch(rowId, match, { requestItemId: null, personId: null });
  if (item.state === 'open' && (item.kind === 'unmatched-response-row' || item.kind === 'response-row-match'))
    ctx.repos.reviews.setCandidates(item.id, candidates);
  return candidates;
}

function openItem(ctx: Ctx, id: Ulid): ReviewItemRow {
  const item = ctx.repos.reviews.get(id) ?? fail('NOT_FOUND', 'Review item not found');
  if (item.state !== 'open') return fail('CONFLICT', 'Review item is already closed');
  return item;
}

/** A row that already produced a link or a record cannot be validated or corrected (unlink first). */
function requireUnlinked(ctx: Ctx, row: ResponseRow): void {
  if (isLinkedDecision(row.match) || ctx.repos.vetting.listByResponseRow(row.id).length > 0)
    fail('CONFLICT', 'The row is already linked; unlink it first');
}

interface ValidateOutcome {
  item: ReviewItemRow;
  rowId: Ulid;
  personId: Ulid;
  itemId: Ulid | null;
  disposition: 'approved' | 'non-approved';
}

function manualValidateOne(ctx: Ctx, req: ReviewManualValidateRequest): ValidateOutcome {
  const reason = requireReason(req.reason);
  const item = openItem(ctx, req.id);
  if (!VALIDATE_KINDS.has(item.kind))
    return fail('BAD_REQUEST', 'Manual validation does not apply to this review kind');
  const rowId =
    item.subjectIds.find((s) => ctx.repos.responses.getRow(s) !== null) ??
    fail('BAD_REQUEST', 'Manual validation needs a response row');
  const row = ctx.repos.responses.getRow(rowId)!;
  if (!isIndividualSection(row.section))
    return fail('BAD_REQUEST', 'Manual validation applies to rows about individuals');
  if (row.dispClass !== 'approved' && row.dispClass !== 'non-approved')
    return fail('BAD_REQUEST', 'Set the disposition first');
  requireUnlinked(ctx, row);
  const resp = ctx.repos.responses.getHeader(row.responseId)!;
  const at = ctx.nowIso();

  let personId: Ulid;
  let itemId: Ulid | null = null;
  let unitId: Ulid | null = null;
  const t = req.target;
  if (t.kind === 'person') {
    const p = ctx.repos.persons.get(t.personId);
    if (!p || p.state !== 'active') return fail('NOT_FOUND', 'Person not found');
    personId = p.id;
  } else if (t.kind === 'request-item') {
    const it = ctx.repos.requests.getItem(t.itemId) ?? fail('NOT_FOUND', 'Request item not found');
    if (resp.requestId && it.requestId !== resp.requestId)
      return fail('BAD_REQUEST', 'Item belongs to another request');
    const clash = ctx.repos.responses
      .rowsByRequestItem(it.id)
      .some((x) => x.id !== row.id && x.responseId === resp.id && isIndividualSection(x.section));
    if (clash) return fail('CONFLICT', 'Another row of this response is linked to that item');
    if (!it.personId) {
      // Explicit decision: the item's own observation becomes a new person (as "create new" does for items).
      const p = ctx.repos.persons.insert({ ...personInputFromObserved(it.observed, it.id, it.requestId), at });
      linkItemToPerson(ctx, it.id, p.id, 'new-person');
    }
    personId = ctx.repos.requests.getItem(it.id)!.personId!;
    itemId = it.id;
    unitId = it.unitId;
  } else {
    personId = ctx.repos.persons.insert({ ...personInputFromRow(row, resp.requestId), at }).id;
  }

  const out = ctx.repos.responses.setRowMatch(
    row.id,
    { ...row.match, decision: 'confirmed', chosen: itemId ?? personId, decidedBy: ctx.actor(), decidedAt: at },
    { requestItemId: itemId, personId },
  );
  ctx.repos.vetting.insert(recordFromRow(ctx, out, personId, unitId, resp.requestId));
  addAliasIfNew(ctx, personId, row.name, `response:${resp.id}`, itemId ?? row.id);
  if (itemId) {
    refreshItemPolicy(ctx, itemId);
    for (const r of ctx.repos.reviews.openForSubject(itemId))
      if (r.kind === 'unanswered-request-item') ctx.repos.reviews.resolve(r.id, 'resolved', 'answered', at);
  }
  const done = ctx.repos.reviews.resolve(item.id, 'resolved', 'manual-validate', at, reason);
  return { item: done, rowId: row.id, personId, itemId, disposition: row.dispClass };
}

/** Persons a review item is about (subjects, candidates, and the persons linked to subject / candidate items). */
function personsOfItem(ctx: Ctx, item: ReviewItem): Set<Ulid> {
  const out = new Set<Ulid>();
  for (const id of [...item.subjectIds, ...item.candidates.map((c) => c.targetId)]) {
    if (ctx.repos.persons.get(id)) out.add(id);
    const it = ctx.repos.requests.getItem(id);
    if (it?.personId) out.add(it.personId);
    const links = ctx.repos.responses.rowLinks(id);
    if (links?.personId) out.add(links.personId);
  }
  return out;
}

interface EditOutcome {
  subjectKind: 'response-row' | 'person';
  subjectId: Ulid;
  fields: string[];
  action: 'edit' | 'revert';
}

function editSubjectOne(ctx: Ctx, req: ReviewEditSubjectRequest): EditOutcome {
  const reason = requireReason(req.reason);
  const item = ctx.repos.reviews.get(req.id) ?? fail('NOT_FOUND', 'Review item not found');
  const s = req.subject;
  if (s.kind === 'person') {
    if (!personsOfItem(ctx, item).has(s.personId))
      return fail('BAD_REQUEST', 'The person is not part of this review item');
    if (Object.keys(s.patch).length === 0) return fail('BAD_REQUEST', 'Nothing to change');
    const fields = updatePersonWithProvenance(ctx, s.personId, s.patch, reason);
    return { subjectKind: 'person', subjectId: s.personId, fields, action: 'edit' };
  }
  if (!item.subjectIds.includes(s.rowId)) return fail('BAD_REQUEST', 'The row is not part of this review item');
  const row = ctx.repos.responses.getRow(s.rowId) ?? fail('NOT_FOUND', 'Response row not found');
  requireUnlinked(ctx, row);
  let fields: string[];
  let action: EditOutcome['action'] = 'edit';
  if (Object.keys(s.patch).length === 0) {
    // Revert: the DC original comes back byte for byte; the revert itself is recorded.
    const original = ctx.repos.responses.originalRow(row.id) ?? fail('BAD_REQUEST', 'The row has not been corrected');
    const diff = diffOf(row, original);
    ctx.repos.responses.restoreOriginal(row.id);
    ctx.repos.responses.addEdit({ rowId: row.id, at: ctx.nowIso(), actor: ctx.actor(), reason, diff });
    fields = Object.keys(diff);
    action = 'revert';
  } else {
    const next = applyRowPatch(row, s.patch);
    fields = Object.keys(diffOf(row, next));
    if (fields.length === 0) return fail('BAD_REQUEST', 'Nothing to change');
    correctRowRecorded(ctx, row, next, reason);
  }
  rematchRow(ctx, row.id, item);
  return { subjectKind: 'response-row', subjectId: row.id, fields, action };
}

function detailOf(ctx: Ctx, id: Ulid): ReviewItemDetail {
  const row = ctx.repos.reviews.get(id) ?? fail('NOT_FOUND', 'Review item not found');
  const { resolvedAt: _x, ...item } = row;
  void _x;
  const ids = [...new Set([...item.subjectIds, ...item.candidates.map((c) => c.targetId)])];
  return {
    item,
    subjects: ids.map((s) => subjectOf(ctx, s)).filter((s): s is ReviewSubject => s !== null),
    context: contextOf(ctx, item.subjectIds[0]),
  };
}

export function createReviewService(deps: ServiceDeps): ReviewService {
  const ctx = makeCtx(deps);
  return {
    list: (q) =>
      run(() => {
        const r = ctx.repos.reviews.list({
          offset: q.offset,
          limit: q.limit,
          ...(q.kinds ? { kinds: q.kinds } : {}),
          ...(q.state ? { state: q.state } : {}),
        });
        return {
          items: r.items.map(({ resolvedAt: _x, ...it }) => {
            void _x;
            return summaryOf(ctx, it);
          }),
          total: r.total,
          offset: q.offset,
          limit: q.limit,
        };
      }),
    get: ({ id }) => run(() => detailOf(ctx, id)),
    resolve: (req) =>
      run(() => {
        ctx.tx('review.resolve', () => {
          const subjects = ctx.repos.reviews.get(req.id)?.subjectIds ?? [];
          const done = resolveOne(ctx, req);
          for (const requestId of requestIdsOfSubjects(ctx.repos, subjects)) ctx.hooks.onRequestAnswered(requestId);
          ctx.audit('review.resolve', 'review', req.id, {
            reviewItemId: req.id,
            kind: done.kind,
            action: req.resolution.action,
            result: done.state,
          });
        });
        return ctx.repos.reviews.counts();
      }),
    counts: () => run(() => ctx.repos.reviews.counts()),
    manualValidate: (req) =>
      run(() => {
        ctx.tx('review.manualValidate', () => {
          const subjects = ctx.repos.reviews.get(req.id)?.subjectIds ?? [];
          const o = manualValidateOne(ctx, req);
          for (const requestId of requestIdsOfSubjects(ctx.repos, [...subjects, ...(o.itemId ? [o.itemId] : [])]))
            ctx.hooks.onRequestAnswered(requestId);
          ctx.audit('review.manual-validate', 'review', req.id, {
            reviewItemId: req.id,
            kind: o.item.kind,
            rowId: o.rowId,
            targetKind: req.target.kind,
            personId: o.personId,
            ...(o.itemId ? { itemId: o.itemId } : {}),
            disposition: o.disposition,
            reasonLength: req.reason.trim().length,
          });
        });
        return ctx.repos.reviews.counts();
      }),
    editSubject: (req) =>
      run(() => {
        ctx.tx('review.editSubject', () => {
          const o = editSubjectOne(ctx, req);
          ctx.audit('review.edit-subject', 'review', req.id, {
            reviewItemId: req.id,
            subjectKind: o.subjectKind,
            ...(o.subjectKind === 'person' ? { personId: o.subjectId } : { rowId: o.subjectId }),
            fields: o.fields.sort().join(','),
            action: o.action,
            reasonLength: req.reason.trim().length,
          });
        });
        return detailOf(ctx, req.id);
      }),
  };
}
