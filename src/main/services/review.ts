/**
 * `review.*` service (WP-13): the queue of flagged identity decisions. Every resolution is explicit and audited once:
 * link (confirm the proposed candidate or choose another), new-person, not-same (adds negative pairs), merge,
 * keep-dob, dismiss (skip).
 */
import type { MatchTier, ReviewItem, Ulid } from '@shared/domain/types';
import type {
  IdRef,
  Page,
  ReviewCounts,
  ReviewEditSubjectRequest,
  ReviewItemDetail,
  ReviewItemSummary,
  ReviewListQuery,
  ReviewManualValidateRequest,
  ReviewResolveRequest,
  ReviewSubject,
  Result,
} from '@shared/ipc/contract';
import { requestIdsOfSubjects } from './hooks';
import { observedName, parseSex } from '../matching/records';
import {
  addAliasIfNew,
  createPersonForItem,
  isIndividualSection,
  linkItemToPerson,
  personInputFromRow,
  recordFromRow,
} from './people-ops';
import { mergePersons } from './people';
import { resolveRowDisposition } from './responses';
import { displayName, fail, makeCtx, notSupported, run } from './vetting-common';
import type { Ctx, ServiceDeps } from './vetting-common';

export interface ReviewService {
  list(req: ReviewListQuery): Promise<Result<Page<ReviewItemSummary>>>;
  get(req: IdRef): Promise<Result<ReviewItemDetail>>;
  resolve(req: ReviewResolveRequest): Promise<Result<ReviewCounts>>;
  counts(): Promise<Result<ReviewCounts>>;
  /** LANE K SLOT (docs/PLAN-ALPHA.md section 14); NOT_SUPPORTED until lane K lands. */
  manualValidate(req: ReviewManualValidateRequest): Promise<Result<ReviewCounts>>;
  /** LANE K SLOT; NOT_SUPPORTED until lane K lands. */
  editSubject(req: ReviewEditSubjectRequest): Promise<Result<ReviewItemDetail>>;
}

const TIER_ORDER: readonly MatchTier[] = ['T1', 'T2', 'T3', 'T4'];
function bestTierOf(item: ReviewItem): MatchTier | null {
  let best: number | null = null;
  for (const c of item.candidates) {
    const i = TIER_ORDER.indexOf(c.tier);
    if (best === null || i < best) best = i;
  }
  return best === null ? null : TIER_ORDER[best]!;
}

/** List row: the item plus its first subject (lane K refines name order and adds the request/response context). */
function summaryOf(ctx: Ctx, item: ReviewItem): ReviewItemSummary {
  const first = item.subjectIds[0];
  const s = first ? subjectOf(ctx, first) : null;
  return {
    ...item,
    subjectName: s?.displayName ?? '',
    subjectDob: s?.dob ?? null,
    unitName: s?.unitName ?? null,
    context: null,
    bestTier: bestTierOf(item),
  };
}

function subjectOf(ctx: Ctx, id: Ulid): ReviewSubject | null {
  const p = ctx.repos.persons.get(id);
  if (p) {
    const items = ctx.repos.requests.itemsByPerson(id);
    const unitId = items[items.length - 1]?.unitId ?? null;
    return {
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
      edited: false,
    };
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
  if (r)
    return {
      id,
      kind: 'response-row',
      displayName: displayName(r.name),
      dob: r.dob.parsed,
      dobRaw: r.dob.value,
      sex: null,
      pobCountry: r.pob.country,
      unitName: r.unitName || null,
      identifiers: [],
      source: `response ${r.rowRef}`,
      edited: false,
    };
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
      // Lane C: disposition-unclear items (created at import) resolve through responses.resolveRowDisposition.
      if (item.kind !== 'disposition-unclear')
        return fail('BAD_REQUEST', 'set-disposition applies to unclear dispositions');
      resolveRowDisposition(ctx, subject, res.disposition);
      return close(`disposition:${res.disposition}`);
  }
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
    get: ({ id }) =>
      run((): ReviewItemDetail => {
        const row = ctx.repos.reviews.get(id) ?? fail('NOT_FOUND', 'Review item not found');
        const { resolvedAt: _x, ...item } = row;
        void _x;
        const ids = [...new Set([...item.subjectIds, ...item.candidates.map((c) => c.targetId)])];
        return { item, subjects: ids.map((s) => subjectOf(ctx, s)).filter((s): s is ReviewSubject => s !== null) };
      }),
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
    manualValidate: () => notSupported('Manual validation'),
    editSubject: () => notSupported('Editing a review subject'),
  };
}
