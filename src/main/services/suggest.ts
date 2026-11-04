/**
 * `persons.suggest` (lane K, docs/PLAN-ALPHA.md section 14): who a review subject could be, for the person picker.
 * READ-ONLY by construction: no transaction, no repository write, no audit, no match decision. Three sources, in order:
 *  1. `candidate` - the review item's own candidates plus the matcher's tiered candidates (T1..T4) for the subject,
 *     including surname trigram neighbours (blocking widened, tiering unchanged);
 *  2. `recent`    - active persons of the same request, or of the same unit touched in the last 30 days;
 *  3. `search`    - a tolerant text query over the typed text, else the subject's own name: folded, split on commas
 *     and whitespace, particles dropped, tokens ANDed in any order against the trigram index (non-Latin tokens stay
 *     their own terms); when nothing matches every token, persons matching most tokens are offered instead.
 *     Typed text also narrows 1 and 2, so a refined query lists only persons that match it.
 * Merged and purged persons never appear; results are de-duplicated and bounded (limit <= 50).
 */
import type { MatchCandidate, MatchEvidence, MatchTier, Ulid } from '@shared/domain/types';
import type { PersonSuggestion, PersonSuggestRequest } from '@shared/ipc/contract';
import { DEFAULT_NAME_CONFIG } from '@shared/names/config';
import { foldToken } from '@shared/names/normalize';
import { foldForSearch, searchIds } from '../db/search';
import { generateCandidates, rankTargets } from '../matching/matcher';
import { observedName, subjectFromRequestItem, subjectFromResponseRow } from '../matching/records';
import type { MatchSubject, MatchTarget } from '../matching/types';
import { personSummaries } from './people';
import { DbNegativePairs, SqlCandidateSource } from './people-source';
import { displayName, fail } from './vetting-common';
import type { Ctx } from './vetting-common';

export const SUGGEST_DEFAULT_LIMIT = 20;
export const SUGGEST_MAX_LIMIT = 50;
const RECENT_DAYS = 30;
const SEARCH_POOL = 200;

interface Hit {
  tier: MatchTier | null;
  evidence: MatchEvidence[];
  why: PersonSuggestion['why'];
  /** Order inside the same `why` group (lower first). */
  rank: number;
}

interface Resolved {
  subject: MatchSubject | null;
  /** Display name of the subject (searched when the picker sends no text). */
  name: string;
  /** Candidates already stored on the review item. */
  stored: MatchCandidate[];
  requestId: Ulid | null;
  unitId: Ulid | null;
  /** Persons that are the subject itself (never suggested for themselves). */
  self: Set<Ulid>;
}

/** Search tokens of a picker query: folded, split on commas / semicolons / whitespace, particles dropped. */
export function searchTokens(text: string): string[] {
  const all: string[] = [];
  for (const raw of foldForSearch(text).split(/[\s,;]+/)) {
    const t = raw.replace(/^[.'"()-]+|[.'"()-]+$/g, '');
    if (t !== '' && !all.includes(t)) all.push(t);
  }
  const core = all.filter((t) => !DEFAULT_NAME_CONFIG.particleLike.has(foldToken(t)));
  // A query made of particles only ("Van", "bin") is still searched as typed.
  return core.length > 0 ? core : all;
}

/** Person ids matching the query tolerantly (see file header), best first. */
export function tolerantSearch(ctx: Ctx, text: string, limit = SEARCH_POOL): Ulid[] {
  const tokens = searchTokens(text);
  if (tokens.length === 0) return [];
  const all = searchIds(ctx.db, 'person', tokens.join(' '), limit);
  if (all.length > 0 || tokens.length === 1) return all;
  // Nothing matches every token: rank persons by how many tokens they match (ties: first-seen order).
  const score = new Map<Ulid, number>();
  for (const t of tokens)
    for (const id of searchIds(ctx.db, 'person', t, limit)) score.set(id, (score.get(id) ?? 0) + 1);
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);
}

function resolveSubject(ctx: Ctx, req: PersonSuggestRequest['forSubject']): Resolved {
  const source = new SqlCandidateSource(ctx.db, ctx.repos);
  const fromEntity = (id: Ulid): Omit<Resolved, 'stored'> => {
    const item = ctx.repos.requests.getItem(id);
    if (item)
      return {
        subject: subjectFromRequestItem(item),
        name: displayName(observedName(item.observed)),
        requestId: item.requestId,
        unitId: item.unitId,
        self: new Set(),
      };
    const row = ctx.repos.responses.getRow(id);
    if (row) {
      const head = ctx.repos.responses.getHeader(row.responseId);
      return {
        subject: subjectFromResponseRow(row),
        name: displayName(row.name),
        requestId: head?.requestId ?? null,
        unitId: null,
        self: new Set(),
      };
    }
    const p = ctx.repos.persons.get(id);
    if (p)
      return {
        subject: { ...source.target(p), personId: p.id },
        name: displayName(p.canonical),
        requestId: null,
        unitId: null,
        self: new Set([p.id]),
      };
    return fail('NOT_FOUND', 'Subject not found');
  };
  if (req.kind === 'review-item') {
    const item = ctx.repos.reviews.get(req.id) ?? fail('NOT_FOUND', 'Review item not found');
    const first = item.subjectIds[0] ?? fail('CONFLICT', 'Review item has no subject');
    const r = fromEntity(first);
    // Every person named as a subject is "self" (duplicate-persons items name two).
    for (const s of item.subjectIds) if (ctx.repos.persons.get(s)) r.self.add(s);
    return { ...r, stored: item.candidates };
  }
  const id = req.id;
  if (req.kind === 'request-item' && !ctx.repos.requests.getItem(id))
    return fail('NOT_FOUND', 'Request item not found');
  if (req.kind === 'response-row' && !ctx.repos.responses.getRow(id))
    return fail('NOT_FOUND', 'Response row not found');
  return { ...fromEntity(id), stored: [] };
}

function recentPersons(ctx: Ctx, requestId: Ulid | null, unitId: Ulid | null, limit: number): Ulid[] {
  if (!requestId && !unitId) return [];
  const cutoff = new Date(ctx.now().getTime() - RECENT_DAYS * 86_400_000).toISOString();
  const rows = ctx.db
    .prepare(
      `SELECT p.id AS id FROM person p WHERE p.state = 'active' AND (
         p.id IN (SELECT person_id FROM request_item WHERE request_id = @req AND person_id IS NOT NULL)
         OR ((p.updated_at >= @cut OR p.id IN (SELECT person_id FROM vetting_record WHERE recorded_at >= @cut))
             AND p.id IN (SELECT person_id FROM request_item WHERE unit_id = @unit AND person_id IS NOT NULL
                          UNION SELECT person_id FROM vetting_record WHERE unit_id = @unit)))
       ORDER BY p.updated_at DESC, p.id LIMIT @lim`,
    )
    .all({ req: requestId, unit: unitId, cut: cutoff, lim: limit }) as { id: string }[];
  return rows.map((r) => r.id);
}

export function suggestPersons(ctx: Ctx, req: PersonSuggestRequest): PersonSuggestion[] {
  const limit = Math.min(Math.max(req.limit ?? SUGGEST_DEFAULT_LIMIT, 1), SUGGEST_MAX_LIMIT);
  const r = resolveSubject(ctx, req.forSubject);
  const hits = new Map<Ulid, Hit>();
  const add = (id: Ulid | null | undefined, h: Hit): void => {
    if (!id || r.self.has(id)) return;
    const prev = hits.get(id);
    if (!prev) {
      hits.set(id, h);
      return;
    }
    // Keep the strongest evidence: candidate beats recent beats search; a tier beats none.
    const order = { candidate: 0, recent: 1, search: 2 } as const;
    if (order[h.why] < order[prev.why] || (h.why === prev.why && h.tier && !prev.tier)) hits.set(id, h);
  };

  // 1. candidates: those stored on the review item, then the matcher's view of the subject today.
  r.stored.forEach((c, i) => {
    const personId =
      c.targetKind === 'person' ? c.targetId : (ctx.repos.requests.getItem(c.targetId)?.personId ?? null);
    add(personId, { tier: c.tier, evidence: c.evidence, why: 'candidate', rank: i });
  });
  if (r.subject) {
    const source = new SqlCandidateSource(ctx.db, ctx.repos);
    const targets = new Map<Ulid, MatchTarget>();
    for (const t of generateCandidates(r.subject, { source })) targets.set(t.id, t);
    // Surname trigram neighbours widen blocking for typos; tiering stays the matcher's.
    const surnames = new Set(r.subject.names.flatMap((n) => n.surname ?? []).filter((s) => [...s].length >= 3));
    for (const s of surnames)
      for (const p of ctx.repos.persons.getMany(searchIds(ctx.db, 'person', s, 50)))
        if (p.state === 'active' && !targets.has(p.id)) targets.set(p.id, source.target(p));
    const ranked = rankTargets(r.subject, [...targets.values()], 'cross-request', {
      source,
      negativePairs: new DbNegativePairs(ctx.repos),
    });
    ranked.forEach((c, i) => {
      if (c.targetKind === 'person')
        add(c.targetId, { tier: c.tier, evidence: c.evidence, why: 'candidate', rank: r.stored.length + i });
    });
  }

  // 2. recent persons of the same request / unit.
  recentPersons(ctx, r.requestId, r.unitId, SUGGEST_MAX_LIMIT).forEach((id, i) =>
    add(id, { tier: null, evidence: [], why: 'recent', rank: i }),
  );

  // 3. tolerant text search: the typed text, else the subject's own name. Typed text also narrows 1 and 2, so a
  //    refined query shows only persons matching it.
  const typed = req.text && req.text.trim() !== '' ? req.text : null;
  const found = tolerantSearch(ctx, typed ?? r.name);
  if (typed) {
    const keep = new Set(found);
    for (const id of [...hits.keys()]) if (!keep.has(id)) hits.delete(id);
  }
  found.forEach((id, i) => add(id, { tier: null, evidence: [], why: 'search', rank: i }));

  const order = { candidate: 0, recent: 1, search: 2 } as const;
  const ids = [...hits.entries()]
    .sort((a, b) => order[a[1].why] - order[b[1].why] || a[1].rank - b[1].rank)
    .map(([id]) => id);
  const persons = ctx.repos.persons.getMany(ids).filter((p) => p.state === 'active');
  const byId = new Map(persons.map((p) => [p.id, p]));
  const kept = ids.filter((id) => byId.has(id)).slice(0, limit);
  const summaries = personSummaries(
    ctx,
    kept.map((id) => byId.get(id)!),
  );
  return summaries.map((person) => {
    const h = hits.get(person.id)!;
    return { person, tier: h.tier, evidence: h.evidence, why: h.why };
  });
}
