/**
 * LANE D mock (docs/PLAN-ALPHA.md section 6): request lifecycle. Same rules as services/lifecycle.ts: Finished is
 * derived (here lazily, re-derived before every read of requests and the dashboard), Close needs Finished, Reopen
 * needs Closed and a reason of at least 3 characters, Finished/Closed are never set by hand.
 */
import {
  canClose,
  canReopen,
  isFinished,
  isManualTarget,
  MIN_REASON_LENGTH,
  statusAfterRecompute,
  statusAfterReopen,
} from '@shared/domain/lifecycle';
import type { RequestSummary } from '@shared/ipc/contract';
import { appendAudit } from '../db';
import type { MockDb } from '../db';
import { mockFail, mockOk } from './types';
import type { MockBaseApi, MockExtension } from './types';

/** Re-derive responded <-> finished for every request (idempotent). */
export function recomputeLifecycle(db: MockDb): void {
  for (const r of db.requests) {
    if (r.status !== 'responded' && r.status !== 'finished') continue;
    const recorded = new Set(db.records.filter((x) => x.requestId === r.id).map((x) => x.personId));
    const next = statusAfterRecompute(r.status, isFinished(r.items, recorded));
    if (next === r.status) continue;
    r.status = next;
    r.finishedAt = next === 'finished' ? new Date().toISOString() : null;
  }
}

async function summaryOf(api: MockBaseApi, id: string): Promise<RequestSummary | null> {
  for (let offset = 0; ; offset += 500) {
    const page = await api.requests.list({ offset, limit: 500 });
    if (!page.ok) return null;
    const hit = page.value.items.find((x) => x.id === id);
    if (hit) return hit;
    if (offset + 500 >= page.value.total) return null;
  }
}

export const lifecycleMock: MockExtension = ({ db, api }) => {
  const locked = () => (db.vault.locked ? mockFail('VAULT_LOCKED', 'The vault is locked.') : null);
  const wrapped =
    <A extends unknown[], T>(fn: (...a: A) => T) =>
    (...a: A): T => {
      recomputeLifecycle(db);
      return fn(...a);
    };
  return {
    requests: {
      list: wrapped(api.requests.list),
      get: wrapped(api.requests.get),
      setStatus: async (req) => {
        if (!isManualTarget(req.status))
          return mockFail('LIFECYCLE_CONFLICT', 'This status is set automatically or by closing.');
        const r = db.requests.find((x) => x.id === req.id);
        if (r?.status === 'closed') return mockFail('LIFECYCLE_CONFLICT', 'Reopen the request first.');
        const out = await api.requests.setStatus(req);
        recomputeLifecycle(db);
        return out;
      },
      close: async (req) => {
        const l = locked();
        if (l) return l;
        recomputeLifecycle(db);
        const r = db.requests.find((x) => x.id === req.id);
        if (!r) return mockFail('NOT_FOUND', 'Request not found.');
        if (!canClose(r.status)) return mockFail('LIFECYCLE_CONFLICT', 'Only a finished request can be closed.');
        r.status = 'closed';
        r.closedAt = new Date().toISOString();
        r.closeNote = req.note.trim();
        appendAudit(db, 'request.close', 'request', r.id);
        const s = await summaryOf(api, r.id);
        return s ? mockOk(s) : mockFail('NOT_FOUND', 'Request not found.');
      },
      reopen: async (req) => {
        const l = locked();
        if (l) return l;
        const reason = req.reason.trim();
        if (reason.length < MIN_REASON_LENGTH)
          return mockFail('REASON_REQUIRED', 'A reason of at least 3 characters is required.');
        const r = db.requests.find((x) => x.id === req.id);
        if (!r) return mockFail('NOT_FOUND', 'Request not found.');
        if (!canReopen(r.status)) return mockFail('LIFECYCLE_CONFLICT', 'Only a closed request can be reopened.');
        const recorded = new Set(db.records.filter((x) => x.requestId === r.id).map((x) => x.personId));
        r.status = statusAfterReopen(isFinished(r.items, recorded));
        r.finishedAt = r.status === 'finished' ? (r.finishedAt ?? new Date().toISOString()) : null;
        r.closedAt = null;
        r.closeNote = '';
        r.reopenCount += 1;
        appendAudit(db, 'request.reopen', 'request', r.id);
        const s = await summaryOf(api, r.id);
        return s ? mockOk(s) : mockFail('NOT_FOUND', 'Request not found.');
      },
    },
    stats: {
      dashboard: wrapped(api.stats.dashboard),
    },
  };
};
