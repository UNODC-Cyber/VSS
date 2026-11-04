/**
 * Request lifecycle service (docs/PLAN-ALPHA.md section 6, lane D): Finished is derived, Closed is a gated manager
 * action, Reopen needs a reason. `onRequestAnswered` is the DomainHooks entry point; it runs inside the caller's
 * write transaction. Audit details carry ids, statuses and note LENGTHS only, never note text.
 */
import {
  canClose,
  canReopen,
  isFinished,
  MIN_REASON_LENGTH,
  statusAfterRecompute,
  statusAfterReopen,
} from '@shared/domain/lifecycle';
import type { Ulid } from '@shared/domain/types';
import type { RequestCloseRequest, RequestReopenRequest, RequestSummary, Result } from '@shared/ipc/contract';
import { fail, makeCtx, run } from './vetting-common';
import type { Ctx, ServiceDeps } from './vetting-common';
import { summarize } from './requests';

export interface LifecycleService {
  close(req: RequestCloseRequest): Promise<Result<RequestSummary>>;
  reopen(req: RequestReopenRequest): Promise<Result<RequestSummary>>;
  /** DomainHooks.onRequestAnswered: runs inside the caller's write transaction. */
  onRequestAnswered(requestId: Ulid): void;
}

/** True when every item of the request has its outcome (derived from the stored items and vetting records). */
export function requestIsFinished(ctx: Ctx, requestId: Ulid): boolean {
  const items = ctx.repos.requests.listItems(requestId);
  const recorded = new Set(ctx.repos.vetting.listByRequest(requestId).map((r) => r.personId));
  return isFinished(items, recorded);
}

/** Recompute the derived Finished state (responded <-> finished). `sys` audits as actor `system`. */
export function recomputeFinished(ctx: Ctx, sys: Ctx, requestId: Ulid): void {
  const h = ctx.repos.requests.getHeader(requestId);
  if (!h || (h.status !== 'responded' && h.status !== 'finished')) return;
  const next = statusAfterRecompute(h.status, requestIsFinished(ctx, requestId));
  if (next === h.status) return;
  ctx.repos.requests.setStatus(requestId, next, ctx.nowIso());
  sys.audit(next === 'finished' ? 'request.finish' : 'request.status', 'request', requestId, {
    requestId,
    fromStatus: h.status,
    toStatus: next,
  });
}

export function createLifecycleService(deps: ServiceDeps): LifecycleService {
  const ctx = makeCtx(deps);
  const sys = makeCtx({ ...deps, actor: () => 'system' });
  const summaryOf = (id: Ulid): RequestSummary => {
    const h = ctx.repos.requests.getHeader(id) ?? fail('NOT_FOUND', 'Request not found');
    return summarize(ctx, [h])[0]!;
  };

  return {
    close: ({ id, note }) =>
      run(() => {
        ctx.tx('requests.close', () => {
          const h = ctx.repos.requests.getHeader(id) ?? fail('NOT_FOUND', 'Request not found');
          if (!canClose(h.status)) return fail('LIFECYCLE_CONFLICT', 'Only a finished request can be closed');
          const text = note.trim();
          ctx.repos.requests.close(id, text, ctx.nowIso());
          ctx.audit('request.close', 'request', id, {
            requestId: id,
            fromStatus: h.status,
            toStatus: 'closed',
            noteLength: text.length,
          });
        });
        return summaryOf(id);
      }),

    reopen: ({ id, reason }) =>
      run(() => {
        const text = reason.trim();
        if (text.length < MIN_REASON_LENGTH)
          return fail('REASON_REQUIRED', 'A reason of at least 3 characters is required');
        ctx.tx('requests.reopen', () => {
          const h = ctx.repos.requests.getHeader(id) ?? fail('NOT_FOUND', 'Request not found');
          if (!canReopen(h.status)) return fail('LIFECYCLE_CONFLICT', 'Only a closed request can be reopened');
          const to = statusAfterReopen(requestIsFinished(ctx, id));
          ctx.repos.requests.reopen(id, to, text, ctx.nowIso());
          ctx.audit('request.reopen', 'request', id, {
            requestId: id,
            fromStatus: h.status,
            toStatus: to,
            noteLength: text.length,
          });
        });
        return summaryOf(id);
      }),

    onRequestAnswered: (requestId) => recomputeFinished(ctx, sys, requestId),
  };
}
