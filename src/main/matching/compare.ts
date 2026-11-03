/** Evidence computation: names (compareNames) and whole records (compareRecords). Pure. */
import type { MatchEvidence, MatchTier, NameKey } from '../../shared/domain/types';
import { DEFAULT_NAME_CONFIG, type NameConfig } from '../../shared/names/config';
import { tokenSetJaroWinkler } from '../../shared/names/jaroWinkler';
import { doubleMetaphone } from '../../shared/names/metaphone';
import { detectScript } from '../../shared/names/normalize';
import { compareDob } from './dob';
import { assignTier, tierRank } from './tiers';
import type { IdentifierRef, MatchMode, MatchRecord, NameVariant } from './types';

export const DEFAULT_JW_THRESHOLD = 0.92;

export interface NameComparison {
  /** Name evidence only (NAME_*). */
  evidence: MatchEvidence[];
  coreEqual: boolean;
  /** core AND particle multisets equal (hyphen-joined helper tokens ignored). */
  fullEqual: boolean;
  /** Particle multiset distance; an equivalent-pair substitution (a/l <-> s/o) counts 1, any other substitution 2. */
  particleDistance: number;
  subsetOne: boolean;
  surnameEqual: boolean;
  phoneticEqual: boolean;
  /** Best-aligned token-set Jaro-Winkler over core tokens. */
  jw: number;
}

export interface CompareNamesOptions {
  jwThreshold?: number;
  config?: NameConfig;
  /** Skip the fuzzy measures (JW, phonetic); used by the matcher when DOB evidence makes them irrelevant. */
  fuzzy?: boolean;
}

type NameSide = NameKey | NameVariant;
const asVariant = (s: NameSide): NameVariant => ('key' in s ? s : { key: s, surname: null });

/** Multiset difference of two sorted arrays. */
function diffSorted(a: readonly string[], b: readonly string[]): { onlyA: string[]; onlyB: string[]; common: number } {
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  let i = 0;
  let j = 0;
  let common = 0;
  while (i < a.length || j < b.length) {
    const x = a[i];
    const y = b[j];
    if (x !== undefined && y !== undefined && x === y) {
      common++;
      i++;
      j++;
    } else if (y === undefined || (x !== undefined && x < y)) {
      onlyA.push(x as string);
      i++;
    } else {
      onlyB.push(y);
      j++;
    }
  }
  return { onlyA, onlyB, common };
}

const sorted = (xs: readonly string[]): string[] => [...xs].sort((p, q) => (p < q ? -1 : p > q ? 1 : 0));

function isSubMultiset(small: readonly string[], big: readonly string[]): boolean {
  return diffSorted(sorted(small), sorted(big)).onlyA.length === 0;
}

function particleDistance(a: readonly string[], b: readonly string[], config: NameConfig): number {
  const { onlyA, onlyB } = diffSorted(a, b);
  let subs = 0;
  const restB = [...onlyB];
  const restA: string[] = [];
  for (const x of onlyA) {
    const g = config.equivalentGroup.get(x);
    const k = g === undefined ? -1 : restB.findIndex((y) => config.equivalentGroup.get(y) === g);
    if (k >= 0) {
      restB.splice(k, 1);
      subs++;
    } else restA.push(x);
  }
  return subs + restA.length + restB.length;
}

const dmCache = new Map<string, readonly [string, string]>();
function dm(token: string): readonly [string, string] {
  let v = dmCache.get(token);
  if (!v) {
    v = doubleMetaphone(token);
    if (dmCache.size > 200_000) dmCache.clear();
    dmCache.set(token, v);
  }
  return v;
}

/** True when every core token pairs one-to-one with a token sharing a Double Metaphone code (Latin only). */
function phoneticBijection(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  if (!a.every((t) => detectScript(t) === 'Latn') || !b.every((t) => detectScript(t) === 'Latn')) return false;
  const codes = (t: string): string[] => dm(t).filter((c) => c !== '');
  const ca = a.map(codes);
  const cb = b.map(codes);
  const adj = ca.map((x) => cb.map((y) => x.some((c) => y.includes(c))));
  const matchB = new Array<number>(b.length).fill(-1);
  const tryAssign = (i: number, seen: boolean[]): boolean => {
    for (let j = 0; j < b.length; j++) {
      if (!adj[i]?.[j] || seen[j]) continue;
      seen[j] = true;
      const cur = matchB[j] ?? -1;
      if (cur < 0 || tryAssign(cur, seen)) {
        matchB[j] = i;
        return true;
      }
    }
    return false;
  };
  for (let i = 0; i < a.length; i++) if (!tryAssign(i, new Array<boolean>(b.length).fill(false))) return false;
  return true;
}

const tokenLength = (t: string): number => Array.from(t).length;

export function compareNames(aIn: NameSide, bIn: NameSide, opts: CompareNamesOptions = {}): NameComparison {
  const config = opts.config ?? DEFAULT_NAME_CONFIG;
  const threshold = opts.jwThreshold ?? DEFAULT_JW_THRESHOLD;
  const a = asVariant(aIn);
  const b = asVariant(bIn);
  const coreDiff = diffSorted(a.key.coreTokens, b.key.coreTokens);
  const coreEqual = coreDiff.onlyA.length === 0 && coreDiff.onlyB.length === 0 && a.key.coreTokens.length > 0;
  const pDist = particleDistance(a.key.particles, b.key.particles, config);
  const fullEqual = coreEqual && pDist === 0;

  let subsetOne = false;
  if (coreEqual && pDist === 1) subsetOne = true;
  else if (pDist === 0 && coreDiff.common >= 2) {
    const extra =
      coreDiff.onlyA.length === 1 && coreDiff.onlyB.length === 0
        ? coreDiff.onlyA[0]
        : coreDiff.onlyB.length === 1 && coreDiff.onlyA.length === 0
          ? coreDiff.onlyB[0]
          : undefined;
    if (extra !== undefined && tokenLength(extra) <= 2) subsetOne = true;
  }

  let surnameEqual = false;
  const sa = a.surname;
  const sb = b.surname;
  if (sa && sb && sa.length > 0 && sb.length > 0) {
    const d = diffSorted(sorted(sa), sorted(sb));
    surnameEqual =
      (d.onlyA.length === 0 && d.onlyB.length === 0) ||
      (isSubMultiset(sa, b.key.coreTokens) && isSubMultiset(sb, a.key.coreTokens));
  }

  const fuzzy = opts.fuzzy ?? true;
  const jw = coreEqual ? 1 : fuzzy ? tokenSetJaroWinkler(a.key.coreTokens, b.key.coreTokens) : 0;
  const phoneticEqual = !coreEqual && fuzzy && phoneticBijection(a.key.coreTokens, b.key.coreTokens);

  const evidence: MatchEvidence[] = [];
  if (fullEqual) evidence.push('NAME_FULL_EQUAL');
  if (coreEqual) evidence.push('NAME_CORE_EQUAL');
  if (subsetOne) evidence.push('NAME_SUBSET_1');
  if (surnameEqual) evidence.push('NAME_SURNAME_EQUAL');
  if (!coreEqual && jw >= threshold) evidence.push('NAME_JW_HIGH');
  if (phoneticEqual) evidence.push('NAME_PHONETIC_EQUAL');
  return { evidence, coreEqual, fullEqual, particleDistance: pDist, subsetOne, surnameEqual, phoneticEqual, jw };
}

function idCompatible(x: IdentifierRef, y: IdentifierRef): boolean {
  return x.issuingCountry === null || y.issuingCountry === null || x.issuingCountry === y.issuingCountry;
}

/** ID_EQUAL / ID_CONFLICT / nothing. */
export function compareIdentifiers(a: readonly IdentifierRef[], b: readonly IdentifierRef[]): MatchEvidence | null {
  const A = a.filter((x) => x.valueFolded !== '');
  const B = b.filter((x) => x.valueFolded !== '');
  let conflict = false;
  for (const x of A) {
    for (const y of B) {
      if (!idCompatible(x, y)) continue;
      if (x.valueFolded === y.valueFolded) {
        // Same value under a different type counts only when both issuing countries are known and equal.
        if (x.type === y.type || (x.issuingCountry !== null && x.issuingCountry === y.issuingCountry))
          return 'ID_EQUAL';
      } else if (x.type === y.type) conflict = true;
    }
  }
  return conflict ? 'ID_CONFLICT' : null;
}

/**
 * POB below country level (F-06): POB_PLACE_CONFLICT when a city or a state is known on both sides and differs;
 * POB_PLACE_EQUAL when the countries are equal and at least one of city / state is known on both sides and equal.
 */
export function comparePlace(a: MatchRecord, b: MatchRecord): MatchEvidence | null {
  const ca = a.pobCity ?? '';
  const cb = b.pobCity ?? '';
  const sa = a.pobState ?? '';
  const sb = b.pobState ?? '';
  const cityKnown = ca !== '' && cb !== '';
  const stateKnown = sa !== '' && sb !== '';
  if ((cityKnown && ca !== cb) || (stateKnown && sa !== sb)) return 'POB_PLACE_CONFLICT';
  const countryEqual = a.pobCountry !== '' && a.pobCountry === b.pobCountry;
  return countryEqual && (cityKnown || stateKnown) ? 'POB_PLACE_EQUAL' : null;
}

/** FATHER_CONFLICT when both sides know a father's name and no spelling shares a token with any of the other's. */
export function compareFather(a: MatchRecord, b: MatchRecord): MatchEvidence | null {
  const fa = (a.fatherNames ?? []).filter((t) => t.length > 0);
  const fb = (b.fatherNames ?? []).filter((t) => t.length > 0);
  if (fa.length === 0 || fb.length === 0) return null;
  const share = fa.some((x) => fb.some((y) => x.some((tok) => y.includes(tok))));
  return share ? null : 'FATHER_CONFLICT';
}

/** Non-name evidence between two records. */
export function compareAttributes(a: MatchRecord, b: MatchRecord): MatchEvidence[] {
  const ev: MatchEvidence[] = [compareDob(a.dob, b.dob)];
  if (a.dob.placeholder || b.dob.placeholder) ev.push('DOB_PLACEHOLDER');
  if (a.sex !== null && b.sex !== null && a.sex !== b.sex) ev.push('SEX_CONFLICT');
  const id = compareIdentifiers(a.identifiers, b.identifiers);
  if (id) ev.push(id);
  if (a.pobCountry !== '' && b.pobCountry !== '')
    ev.push(a.pobCountry === b.pobCountry ? 'POB_COUNTRY_EQUAL' : 'POB_CONFLICT');
  const place = comparePlace(a, b);
  if (place) ev.push(place);
  const father = compareFather(a, b);
  if (father) ev.push(father);
  const idsKnown = a.unitIds.length > 0 && b.unitIds.length > 0;
  const namesKnown = a.unitNames.length > 0 && b.unitNames.length > 0;
  const unitEqual =
    (idsKnown && a.unitIds.some((u) => b.unitIds.includes(u))) ||
    (namesKnown && a.unitNames.some((u) => b.unitNames.includes(u)));
  if (unitEqual) ev.push('UNIT_EQUAL');
  else if (idsKnown || namesKnown) ev.push('UNIT_CONFLICT');
  return ev;
}

export interface RecordComparison {
  tier: MatchTier | null;
  evidence: MatchEvidence[];
  score: number;
}

const POSITIVE: ReadonlySet<MatchEvidence> = new Set([
  'NAME_FULL_EQUAL',
  'NAME_CORE_EQUAL',
  'DOB_EQUAL',
  'POB_COUNTRY_EQUAL',
  'POB_PLACE_EQUAL',
  'UNIT_EQUAL',
  'ID_EQUAL',
]);
const NEGATIVE: ReadonlySet<MatchEvidence> = new Set([
  'DOB_CONFLICT',
  'SEX_CONFLICT',
  'ID_CONFLICT',
  'POB_CONFLICT',
  'UNIT_CONFLICT',
  'POB_PLACE_CONFLICT',
  'FATHER_CONFLICT',
]);
const TIER_BASE: Record<MatchTier, number> = { T1: 400, T2: 300, T3: 200, T4: 100 };

export function scoreOf(tier: MatchTier, evidence: readonly MatchEvidence[], jw: number): number {
  let s = TIER_BASE[tier] + jw * 20;
  for (const e of evidence) {
    if (POSITIVE.has(e)) s += 5;
    if (NEGATIVE.has(e)) s -= 10;
  }
  return Math.round(s * 1000) / 1000;
}

/**
 * Compare a subject with a target over every (name variant x name variant) pair; return the best tier
 * (then score). tier null = no candidate.
 */
export function compareRecords(
  subject: MatchRecord,
  target: MatchRecord,
  mode: MatchMode,
  opts: CompareNamesOptions = {},
): RecordComparison {
  const attrs = compareAttributes(subject, target);
  const dobEv = attrs[0];
  const fuzzyUseful = dobEv === 'DOB_EQUAL' || dobEv === 'DOB_SWAPPED' || dobEv === 'DOB_YEAR_EQUAL';
  let best: RecordComparison = { tier: null, evidence: [], score: -Infinity };
  for (const sn of subject.names) {
    for (const tn of target.names) {
      const nc = compareNames(sn, tn, { ...opts, fuzzy: (opts.fuzzy ?? true) && fuzzyUseful });
      const evidence = [...nc.evidence, ...attrs];
      const tier = assignTier(evidence, mode);
      if (tier === null) continue;
      const score = scoreOf(tier, evidence, nc.jw);
      if (best.tier === null || tierRank(tier) < tierRank(best.tier) || (tier === best.tier && score > best.score)) {
        best = { tier, evidence, score };
      }
    }
  }
  return best.tier === null ? { tier: null, evidence: attrs, score: 0 } : best;
}
