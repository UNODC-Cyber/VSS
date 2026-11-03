/**
 * Per-person vetting status from stored records via the shared deriveSnapshot (status.ts), and the export policy
 * that turns a status into an export decision.
 */
import { deriveSnapshot } from '@shared/domain/status';
import type {
  ExportDecision,
  ExportPolicy,
  IsoDate,
  LinkState,
  Ulid,
  VettingStatusSnapshot,
} from '@shared/domain/types';
import type { Ctx } from './vetting-common';

/** Snapshot per person (persons with no record get status 'unknown' or 'pending'). */
export function snapshotsFor(
  ctx: Ctx,
  personIds: readonly Ulid[],
  asOf: IsoDate = ctx.today(),
  pending: Set<Ulid> = ctx.repos.requests.pendingPersonIds(),
): Map<Ulid, VettingStatusSnapshot> {
  const ids = [...new Set(personIds)];
  const recs = ctx.repos.vetting.listByPersons(ids);
  const days = ctx.settings().exportPolicy.expiringWithinDays;
  const out = new Map<Ulid, VettingStatusSnapshot>();
  for (const id of ids)
    out.set(
      id,
      deriveSnapshot({ records: recs.get(id) ?? [], pending: pending.has(id), asOf, expiringWithinDays: days }),
    );
  return out;
}

export function snapshotFor(ctx: Ctx, personId: Ulid, asOf?: IsoDate): VettingStatusSnapshot {
  return snapshotsFor(ctx, [personId], asOf).get(personId)!;
}

export interface PolicySubject {
  linkState: LinkState;
  prior: VettingStatusSnapshot | null;
  unitId: Ulid | null;
}
export interface PolicyOutcome {
  decision: ExportDecision;
  /** Machine-readable reason code (shown translated by the UI). */
  reason: string;
  /** True when the item blocks export under includeFlaggedUnresolved='block'. */
  blocking: boolean;
}

/**
 * Export policy (FILE-FORMATS X-07 selection). Flagged (pending-review / unlinked) items follow
 * includeFlaggedUnresolved; otherwise the prior status decides.
 */
export function applyExportPolicy(s: PolicySubject, policy: ExportPolicy): PolicyOutcome {
  if (s.linkState === 'pending-review' || s.linkState === 'unlinked') {
    if (policy.includeFlaggedUnresolved === 'exclude')
      return { decision: 'exclude', reason: 'flagged-unresolved', blocking: false };
    return {
      decision: 'include',
      reason: 'flagged-unresolved',
      blocking: policy.includeFlaggedUnresolved === 'block',
    };
  }
  const p = s.prior;
  if (!p || p.status === 'unknown') return { decision: 'include', reason: 'unknown', blocking: false };
  switch (p.status) {
    case 'pending':
      return { decision: policy.includePending ? 'include' : 'exclude', reason: 'pending', blocking: false };
    case 'expired':
      return { decision: 'include', reason: 'expired', blocking: false };
    case 'expiring':
      return { decision: 'include', reason: 'expiring', blocking: false };
    case 'non-approved':
      return { decision: policy.includeNonApproved ? 'include' : 'exclude', reason: 'non-approved', blocking: false };
    case 'approved':
      if (policy.includeUnitChanged && p.unitId !== null && s.unitId !== null && p.unitId !== s.unitId)
        return { decision: 'include', reason: 'unit-changed', blocking: false };
      return { decision: 'exclude', reason: 'approved-valid', blocking: false };
  }
}

export const isIncluded = (d: ExportDecision): boolean => d === 'include' || d === 'manual-include';
export const isManual = (d: ExportDecision): boolean => d === 'manual-include' || d === 'manual-exclude';
