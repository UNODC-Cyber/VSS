/**
 * Lane B (docs/PLAN-ALPHA.md section 4): persistent, de-duplicated requestors and the type-ahead search.
 * Dedupe rule: same folded e-mail = same requestor; no e-mail: same folded name + organisation.
 * Audit events (requestor.create | requestor.update | requestor.merge) carry only ids, field NAMES and counts.
 */
import type { Requestor, RequestorRecord, Ulid } from '@shared/domain/types';
import type {
  IdRef,
  Page,
  RequestorListQuery,
  RequestorMergeRequest,
  RequestorSearchQuery,
  RequestorUpsertRequest,
  Result,
} from '@shared/ipc/contract';
import type { RequestorFields } from '../db/repos/requestor';
import { blankToNull, fail, makeCtx, run } from './vetting-common';
import type { Ctx, ServiceDeps } from './vetting-common';

export interface RequestorsService {
  search(req: RequestorSearchQuery): Promise<Result<RequestorRecord[]>>;
  get(req: IdRef): Promise<Result<RequestorRecord>>;
  upsert(req: RequestorUpsertRequest): Promise<Result<RequestorRecord>>;
  merge(req: RequestorMergeRequest): Promise<Result<RequestorRecord>>;
  list(req: RequestorListQuery): Promise<Result<Page<RequestorRecord>>>;
  /** DomainHooks.touchRequestor: runs inside the request's write transaction. */
  touch(requestor: Requestor): Ulid | null;
}

const DEFAULT_LIMIT = 8;

const sameText = (a: string | null, b: string | null): boolean => (a ?? '') === (b ?? '');

/** Names of the editable fields that differ (names only, never values: audit stays PII-free). */
function changedFields(before: RequestorFields, after: RequestorFields): string[] {
  const out: string[] = [];
  if (before.name !== after.name) out.push('name');
  if (!sameText(before.email, after.email)) out.push('email');
  if (!sameText(before.organisation, after.organisation)) out.push('organisation');
  if (!sameText(before.phone, after.phone)) out.push('phone');
  if (before.notes !== after.notes) out.push('notes');
  return out;
}

export function createRequestorsService(deps: ServiceDeps): RequestorsService {
  const ctx: Ctx = makeCtx(deps);
  const repo = () => ctx.repos.requestors;
  try {
    // Rows backfilled by migration 005 carry SQL-lower() keys; bring them to the app's search folding once.
    repo().refoldStale();
  } catch {
    /* the table may be absent in a hand-built test database; the service then fails per call, not at construction */
  }

  const normalise = (r: Requestor): RequestorFields => ({
    name: r.name.trim(),
    email: blankToNull(r.email),
    organisation: blankToNull(r.organisation),
    phone: blankToNull(r.phone),
    notes: r.notes ?? '',
  });

  /** Create, update or link; inside the caller's transaction. Returns the record, or null when nothing is storable. */
  function apply(r: Requestor, source: 'request' | 'upsert'): RequestorRecord | null {
    const f = normalise(r);
    if (f.name === '' && f.email === null) return null;
    const at = ctx.nowIso();
    const byId = r.id ? repo().get(r.id) : null;
    if (byId) {
      // An explicit id means "edit this saved record": the given fields replace it (phone/notes only when sent).
      const next: RequestorFields = {
        ...f,
        phone: r.phone === undefined ? byId.phone : f.phone,
        notes: r.notes === undefined ? byId.notes : f.notes,
      };
      const fields = changedFields(byId, next);
      if (fields.length === 0) return byId;
      const { record, followed } = repo().update(byId.id, next, at);
      ctx.audit('requestor.update', 'requestor', byId.id, { fields: fields.join(','), count: followed });
      return record;
    }
    const match = repo().findMatch(f);
    if (match) {
      // No id: link to the matching record and only fill what it lacks; never overwrite saved values.
      const fill: RequestorFields = {
        name: match.name,
        email: match.email ?? f.email,
        organisation: match.organisation ?? f.organisation,
        phone: match.phone ?? f.phone,
        notes: match.notes !== '' ? match.notes : f.notes,
      };
      const fields = changedFields(match, fill);
      if (fields.length === 0) return match;
      const { record, followed } = repo().update(match.id, fill, at);
      ctx.audit('requestor.update', 'requestor', match.id, { fields: fields.join(','), count: followed, source });
      return record;
    }
    const created = repo().insert({ ...f, at, lastUsedAt: source === 'request' ? at : null });
    ctx.audit('requestor.create', 'requestor', created.id, { source });
    return created;
  }

  return {
    search: ({ text, limit }) => run(() => repo().search(text, limit ?? DEFAULT_LIMIT)),

    get: ({ id }) => run(() => repo().get(id) ?? fail('NOT_FOUND', 'Requestor not found')),

    upsert: ({ requestor }) =>
      run(() =>
        ctx.tx('requestors.upsert', () => {
          if (requestor.name.trim() === '') return fail('BAD_REQUEST', 'A requestor needs a name');
          if (requestor.id && !repo().get(requestor.id)) return fail('NOT_FOUND', 'Requestor not found');
          return apply(requestor, 'upsert') ?? fail('BAD_REQUEST', 'A requestor needs a name');
        }),
      ),

    merge: ({ survivorId, mergedId }) =>
      run(() => {
        if (survivorId === mergedId) return fail('BAD_REQUEST', 'A requestor cannot be merged into itself');
        return ctx.tx('requestors.merge', () => {
          const { record, moved } = repo().merge(survivorId, mergedId, ctx.nowIso());
          ctx.audit('requestor.merge', 'requestor', survivorId, { survivorId, mergedId, count: moved });
          return record;
        });
      }),

    list: (q) => run(() => repo().list(q)),

    touch(requestor) {
      const rec = apply(requestor, 'request');
      if (!rec) return null;
      repo().touchUsed(rec.id, ctx.nowIso());
      return rec.id;
    },
  };
}
