/**
 * Tier assignment from evidence (docs/PLAN.md "Identity integrity"), with these tightenings:
 * - Cross-request T1 needs a STRONG anchor (security review F-06): ID_EQUAL, or UNIT_EQUAL together with
 *   POB_PLACE_EQUAL (same city or state of birth, same country). Birth country alone is no anchor: nearly everyone
 *   in one country programme shares it.
 * - T1 is blocked in every mode by DOB_PLACEHOLDER (01-01, 07-01, 12-31, year <= 1900) and FATHER_CONFLICT, and in
 *   cross-request mode by POB_PLACE_CONFLICT.
 * - ID_CONFLICT (same identifier type, different number) is a hard conflict, see below.
 * - T1 needs NAME_FULL_EQUAL (core AND particles equal), not just core equal: a particle difference is a T2 case by
 *   the plan's own T2 rule, and particles such as Vietnamese "Van"/"Le"/"Do" are real name parts.
 * - T1 is also blocked by POB_CONFLICT (any mode) and by UNIT_CONFLICT within one request.
 * - SEX_CONFLICT or ID_CONFLICT caps a candidate at T3 (review, never pre-selected).
 * - DOB_SWAPPED / ambiguous dates never reach T1 (see compareDob).
 * - NAME_SCRIPT_CONFLICT (Alpha 1, lane C: the Latin parts are equal but the non-Latin given names differ) caps a
 *   candidate at T2, so it is never auto-linked. NAME_SCRIPT_IGNORED (non-Latin part on one side only) is information.
 */
import type { MatchEvidence, MatchTier } from '../../shared/domain/types';
import type { MatchMode } from './types';

export const CONFLICT_EVIDENCE: readonly MatchEvidence[] = [
  'DOB_CONFLICT',
  'SEX_CONFLICT',
  'ID_CONFLICT',
  'FATHER_CONFLICT',
];
/** Evidence that never allows T1 although it is not a conflict (the link may still be right; a human decides). */
export const T1_BLOCKERS: readonly MatchEvidence[] = [
  'DOB_PLACEHOLDER',
  'FATHER_CONFLICT',
  'POB_CONFLICT',
  'NAME_SCRIPT_CONFLICT',
];

export function tierRank(t: MatchTier): number {
  return t === 'T1' ? 1 : t === 'T2' ? 2 : t === 'T3' ? 3 : 4;
}

export function assignTier(evidence: readonly MatchEvidence[], mode: MatchMode): MatchTier | null {
  const has = (e: MatchEvidence): boolean => evidence.includes(e);
  const hardConflict = has('SEX_CONFLICT') || has('ID_CONFLICT');
  const nameFull = has('NAME_FULL_EQUAL');
  const nameCore = has('NAME_CORE_EQUAL');
  // Defensive: contradictory DOB evidence (never produced by compareDob) is treated as not equal.
  const dobEqual =
    has('DOB_EQUAL') && !has('DOB_MISSING') && !has('DOB_CONFLICT') && !has('DOB_SWAPPED') && !has('DOB_YEAR_EQUAL');
  const dobSwapped = has('DOB_SWAPPED');

  if (nameFull && dobEqual && !hardConflict && !has('DOB_CONFLICT') && !T1_BLOCKERS.some(has)) {
    const anchored =
      mode === 'within-request'
        ? !has('UNIT_CONFLICT')
        : !has('POB_PLACE_CONFLICT') && (has('ID_EQUAL') || (has('UNIT_EQUAL') && has('POB_PLACE_EQUAL')));
    if (anchored) return 'T1';
  }

  const t2 =
    (nameCore && dobSwapped) ||
    (nameCore && has('DOB_CONFLICT') && has('UNIT_EQUAL')) ||
    (has('NAME_SUBSET_1') && dobEqual) ||
    (has('ID_EQUAL') && dobEqual && !nameCore) ||
    // full name + DOB equal but T1 withheld (no cross-request anchor, POB/unit conflict)
    (nameFull && dobEqual);
  if (t2) return hardConflict ? 'T3' : 'T2';

  const dobUsable = dobEqual || dobSwapped;
  const t3 =
    (has('NAME_SURNAME_EQUAL') && dobUsable) ||
    (has('NAME_JW_HIGH') && (dobUsable || has('DOB_YEAR_EQUAL'))) ||
    (has('NAME_PHONETIC_EQUAL') && dobUsable) ||
    has('ID_EQUAL') ||
    (nameCore && dobEqual);
  if (t3) return 'T3';

  if (nameCore && has('DOB_MISSING')) return 'T4';
  return null;
}
