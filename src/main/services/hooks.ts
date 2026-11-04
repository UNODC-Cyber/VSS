/**
 * Cross-lane hooks of the domain services (docs/PLAN-ALPHA.md section 3). They let one lane react to another lane's
 * writes without editing that lane's file. Every hook runs INSIDE the caller's write transaction (a throw rolls the
 * whole change back) and must never log or audit personal data. The defaults are no-ops, so behaviour is unchanged
 * until the owning lane supplies an implementation in `createDomainServices` (services/vetting-api.ts).
 */
import type { Requestor, Ulid } from '@shared/domain/types';
import type { Repos } from '../db/repos';

export interface DomainHooks {
  /**
   * Lane B (`services/requestors.ts`): upsert the requestor of a request being created or edited and return the
   * record id to store on the request, or null when nothing is stored. Called by `requests.importCommit`,
   * `requests.createManual` and `requests.update` (lane B adds the one call in each).
   */
  touchRequestor(requestor: Requestor): Ulid | null;
  /**
   * Lane D (`services/lifecycle.ts`): an item of this request may have received its outcome, so the derived
   * Finished state must be recomputed. Called after response commit, row match, review resolve (wired by A0) and,
   * in `services/requests.ts`, after email clearance, item decision and item link (lane D adds those).
   */
  onRequestAnswered(requestId: Ulid): void;
}

export const NO_HOOKS: DomainHooks = {
  touchRequestor: () => null,
  onRequestAnswered: () => undefined,
};

export function withDefaults(h: Partial<DomainHooks> | undefined): DomainHooks {
  return { ...NO_HOOKS, ...(h ?? {}) };
}

/** Requests a set of review subjects (request items, response rows) belongs to. Persons map to nothing. */
export function requestIdsOfSubjects(repos: Repos, subjectIds: readonly Ulid[]): Ulid[] {
  const out = new Set<Ulid>();
  for (const id of subjectIds) {
    const item = repos.requests.getItem(id);
    if (item) {
      out.add(item.requestId);
      continue;
    }
    const row = repos.responses.getRow(id);
    const reqId = row ? repos.responses.getHeader(row.responseId)?.requestId : null;
    if (reqId) out.add(reqId);
  }
  return [...out];
}
