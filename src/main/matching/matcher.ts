/**
 * Matcher (WP-12). Never guesses: `auto` only for a single unvetoed T1 candidate; everything else is flagged.
 *
 * Decision rules for one subject:
 *  - candidates = tiered targets (T1..T4) minus negative pairs, sorted by tier then score.
 *  - auto     : exactly one T1 and NO other candidate at T1 or T2 (tightened ambiguity veto: a T2 alternative is a
 *               plausible second identity, e.g. a duplicate person record).
 *  - pending  : any other non-empty candidate list (incl. vetoed T1s and T4-only).
 *  - none     : no candidate. A person is never created here.
 * Batch rules (matchObservations / matchResponseRows): two subjects that auto-link to the same target are both
 * demoted to pending (one-to-one check).
 */
import type { MatchCandidate, ResponseRow, RequestItem, RowMatch } from '../../shared/domain/types';
import { coreKeyOf } from '../../shared/names/key';
import { compareRecords, DEFAULT_JW_THRESHOLD } from './compare';
import { dobLookupDates } from './dob';
import { subjectFromResponseRow, targetFromRequestItem } from './records';
import { tierRank } from './tiers';
import type { MatchContext, MatchMode, MatchSubject, MatchTarget } from './types';

const sortCandidates = (cs: MatchCandidate[]): MatchCandidate[] =>
  cs.sort(
    (a, b) =>
      tierRank(a.tier) - tierRank(b.tier) ||
      b.score - a.score ||
      (a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0),
  );

/** Blocking: identifier equality, core-key equality, DOB (+swap) with >=1 shared core token, surname tokens. */
export function generateCandidates(subject: MatchSubject, ctx: MatchContext): MatchTarget[] {
  const src = ctx.source;
  if (!src) return [];
  const found = new Map<string, MatchTarget>();
  const add = (ts: readonly MatchTarget[]): void => {
    for (const t of ts) if (!found.has(t.id)) found.set(t.id, t);
  };
  add(src.byIdentifier(subject.identifiers.map((i) => i.valueFolded)));
  const coreTokens = new Set<string>();
  const surnameTokens = new Set<string>();
  for (const n of subject.names) {
    add(src.byCoreKey(coreKeyOf(n.key)));
    for (const c of n.key.coreTokens) coreTokens.add(c);
    for (const s of n.surname ?? []) surnameTokens.add(s);
  }
  const dates = dobLookupDates(subject.dob);
  if (dates.length > 0) {
    add(src.byDob(dates).filter((t) => t.names.some((n) => n.key.coreTokens.some((c) => coreTokens.has(c)))));
  }
  if (surnameTokens.size > 0) add(src.bySurname([...surnameTokens]));
  return [...found.values()];
}

function isNegative(subject: MatchSubject, target: MatchTarget, ctx: MatchContext): boolean {
  const np = ctx.negativePairs;
  if (!np) return false;
  if (np.has(subject.id, target.id)) return true;
  return subject.personId !== null && subject.personId !== undefined && np.has(subject.personId, target.id);
}

/** Score the given targets against the subject; returns sorted candidates (negative pairs removed). */
export function rankTargets(
  subject: MatchSubject,
  targets: readonly MatchTarget[],
  mode: MatchMode,
  ctx: MatchContext,
): MatchCandidate[] {
  const out: MatchCandidate[] = [];
  const jwThreshold = ctx.jwThreshold ?? DEFAULT_JW_THRESHOLD;
  for (const t of targets) {
    if (t.id === subject.id) continue;
    if (t.state !== undefined && t.state !== 'active') continue;
    if (isNegative(subject, t, ctx)) continue;
    const r = compareRecords(subject, t, mode, { jwThreshold });
    if (r.tier === null) continue;
    out.push({ targetKind: t.kind, targetId: t.id, tier: r.tier, evidence: r.evidence, score: r.score });
  }
  return sortCandidates(out);
}

/** Decision from a sorted candidate list (no batch context). */
export function decide(candidates: MatchCandidate[], ctx: MatchContext): RowMatch {
  const t1 = candidates.filter((c) => c.tier === 'T1');
  const strong = candidates.filter((c) => c.tier === 'T1' || c.tier === 'T2');
  const only = t1[0];
  if (t1.length === 1 && strong.length === 1 && only) {
    return {
      candidates,
      decision: 'auto',
      chosen: only.targetId,
      decidedBy: ctx.actor ?? 'matcher',
      decidedAt: (ctx.now ?? (() => new Date().toISOString()))(),
    };
  }
  return {
    candidates,
    decision: candidates.length > 0 ? 'pending' : 'none',
    chosen: null,
    decidedBy: null,
    decidedAt: null,
  };
}

/**
 * The candidate a review UI may pre-select: the single top T2 when there is no T1. Pre-selection is a UI hint only;
 * the decision stays `pending` until a human confirms.
 */
export function preselectedCandidate(match: RowMatch): MatchCandidate | null {
  if (match.decision !== 'pending') return null;
  if (match.candidates.some((c) => c.tier === 'T1')) return null;
  const t2 = match.candidates.filter((c) => c.tier === 'T2');
  return t2.length === 1 ? (t2[0] ?? null) : null;
}

function demote(m: RowMatch): RowMatch {
  return { ...m, decision: 'pending', chosen: null, decidedBy: null, decidedAt: null };
}

/** One-to-one check: any target auto-chosen by >1 subject demotes all of those subjects to pending. */
export function enforceOneToOne(matches: RowMatch[]): RowMatch[] {
  const counts = new Map<string, number>();
  for (const m of matches) if (m.decision === 'auto' && m.chosen) counts.set(m.chosen, (counts.get(m.chosen) ?? 0) + 1);
  return matches.map((m) => (m.decision === 'auto' && m.chosen && (counts.get(m.chosen) ?? 0) > 1 ? demote(m) : m));
}

/** Match one subject against the candidate source (default mode cross-request). */
export function matchObservation(subject: MatchSubject, ctx: MatchContext): RowMatch {
  const mode = ctx.mode ?? 'cross-request';
  return decide(rankTargets(subject, generateCandidates(subject, ctx), mode, ctx), ctx);
}

/** Match a batch of subjects (e.g. all items of one imported request) with the one-to-one check across the batch. */
export function matchObservations(subjects: readonly MatchSubject[], ctx: MatchContext): RowMatch[] {
  return enforceOneToOne(subjects.map((s) => matchObservation(s, ctx)));
}

/**
 * Within-batch mode: compare every response row with every item of ONE request (no blocking; requests are small).
 * Result is aligned with `rows`. Rows are never linked outside the request here.
 */
export function matchResponseRows(
  rows: readonly ResponseRow[],
  requestItems: readonly RequestItem[],
  ctx: MatchContext = {},
): RowMatch[] {
  const targets = requestItems.map(targetFromRequestItem);
  const matches = rows.map((row) => {
    const subject = subjectFromResponseRow(row);
    return decide(rankTargets(subject, targets, 'within-request', ctx), ctx);
  });
  return enforceOneToOne(matches);
}
