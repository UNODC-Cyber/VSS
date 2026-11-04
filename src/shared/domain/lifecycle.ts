/**
 * Request lifecycle (docs/PLAN-ALPHA.md section 6, lane D). Pure and deterministic.
 *
 * received -> validated -> exported -> sent-to-dc -> responded -> finished -> closed, plus withdrawn.
 * `finished` is DERIVED (every item has an outcome) and never set by hand; `closed` is a manager's gated action
 * that is only possible from `finished`, and `reopen` leaves `closed` for `finished` or `responded` (recomputed).
 */
import type { ExportDecision, RequestStatus, Ulid } from './types';

export const REQUEST_STATUSES: readonly RequestStatus[] = [
  'received',
  'validated',
  'exported',
  'sent-to-dc',
  'responded',
  'finished',
  'closed',
  'withdrawn',
];

/** The subset of a request item the lifecycle needs. */
export interface LifecycleItem {
  exportDecision: ExportDecision;
  personId: Ulid | null;
}

/** Excluded items count as answered: nobody is waiting for an outcome on them. */
export function isExcluded(d: ExportDecision): boolean {
  return d === 'exclude' || d === 'manual-exclude';
}

/**
 * An item has its outcome when it is excluded, or it is linked to a person who has a vetting record recorded for
 * THIS request (`recordedPersonIds` = person ids of the request's vetting records).
 */
export function isItemAnswered(item: LifecycleItem, recordedPersonIds: ReadonlySet<Ulid>): boolean {
  if (isExcluded(item.exportDecision)) return true;
  return item.personId !== null && recordedPersonIds.has(item.personId);
}

/** True when the request has items and every one of them is answered. */
export function isFinished(items: readonly LifecycleItem[], recordedPersonIds: ReadonlySet<Ulid>): boolean {
  return items.length > 0 && items.every((i) => isItemAnswered(i, recordedPersonIds));
}

const OPEN_MANUAL: readonly RequestStatus[] = ['received', 'validated', 'exported', 'sent-to-dc', 'responded'];

/** Allowed status changes. Anything not listed here is rejected by `canTransition`. */
export const LIFECYCLE_TRANSITIONS: Readonly<Record<RequestStatus, readonly RequestStatus[]>> = {
  received: OPEN_MANUAL.filter((s) => s !== 'received').concat('withdrawn'),
  validated: OPEN_MANUAL.filter((s) => s !== 'validated').concat('withdrawn'),
  exported: OPEN_MANUAL.filter((s) => s !== 'exported').concat('withdrawn'),
  'sent-to-dc': OPEN_MANUAL.filter((s) => s !== 'sent-to-dc').concat('withdrawn'),
  // responded -> finished is automatic (all items answered)
  responded: OPEN_MANUAL.filter((s) => s !== 'responded').concat('finished', 'withdrawn'),
  // finished -> responded is the automatic fall-back; finished -> closed is the manager's close; undoing the only
  // response may also send the request back to exported / sent-to-dc
  finished: ['responded', 'closed', 'exported', 'sent-to-dc', 'withdrawn'],
  // reopen only
  closed: ['finished', 'responded'],
  withdrawn: ['received', 'validated', 'exported', 'sent-to-dc'],
};

export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return LIFECYCLE_TRANSITIONS[from].includes(to);
}

/** Statuses a user may set by hand through `requests.setStatus` (finished and closed are never set by hand). */
export function isManualTarget(to: RequestStatus): boolean {
  return to !== 'finished' && to !== 'closed';
}

/** Status after a recompute: only responded <-> finished ever changes. */
export function statusAfterRecompute(status: RequestStatus, finished: boolean): RequestStatus {
  if (status === 'responded' && finished) return 'finished';
  if (status === 'finished' && !finished) return 'responded';
  return status;
}

/** Status a reopened request returns to. */
export function statusAfterReopen(finished: boolean): 'finished' | 'responded' {
  return finished ? 'finished' : 'responded';
}

/** Statuses that count as an answered, completed request for display ("final" e-mails, no reminders). */
export function isFinal(status: RequestStatus): boolean {
  return status === 'finished' || status === 'closed';
}

/** Close is only possible from Finished; Reopen only from Closed. */
export const canClose = (status: RequestStatus): boolean => status === 'finished';
export const canReopen = (status: RequestStatus): boolean => status === 'closed';

/** Minimum reason length for reopening (REASON_REQUIRED). */
export const MIN_REASON_LENGTH = 3;
