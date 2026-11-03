/** Reference in-memory CandidateSource (tests, small datasets). The DB lane provides the SQL-backed one. */
import type { IsoDate, Ulid } from '../../shared/domain/types';
import { coreKeyOf } from '../../shared/names/key';
import type { CandidateSource, MatchTarget, NegativePairs } from './types';

function push<K>(map: Map<K, MatchTarget[]>, key: K, t: MatchTarget): void {
  const list = map.get(key);
  if (list) {
    if (!list.includes(t)) list.push(t);
  } else map.set(key, [t]);
}

function collect<K>(map: Map<K, MatchTarget[]>, keys: readonly K[]): MatchTarget[] {
  const out = new Set<MatchTarget>();
  for (const k of keys) for (const t of map.get(k) ?? []) out.add(t);
  return [...out];
}

export class InMemoryCandidateSource implements CandidateSource {
  private readonly ids = new Map<string, MatchTarget[]>();
  private readonly cores = new Map<string, MatchTarget[]>();
  private readonly dobs = new Map<IsoDate, MatchTarget[]>();
  private readonly surnames = new Map<string, MatchTarget[]>();

  constructor(targets: Iterable<MatchTarget> = []) {
    for (const t of targets) this.add(t);
  }

  add(t: MatchTarget): void {
    for (const id of t.identifiers) if (id.valueFolded !== '') push(this.ids, id.valueFolded, t);
    for (const n of t.names) {
      push(this.cores, coreKeyOf(n.key), t);
      for (const s of n.surname ?? []) push(this.surnames, s, t);
    }
    if (t.dob.date !== null && t.dob.precision !== 'unknown' && t.dob.precision !== 'year-only') {
      push(this.dobs, t.dob.date, t);
    }
  }

  byIdentifier(valuesFolded: readonly string[]): readonly MatchTarget[] {
    return collect(
      this.ids,
      valuesFolded.filter((v) => v !== ''),
    );
  }
  byCoreKey(coreKey: string): readonly MatchTarget[] {
    return coreKey === '' ? [] : (this.cores.get(coreKey) ?? []);
  }
  byDob(dates: readonly IsoDate[]): readonly MatchTarget[] {
    return collect(this.dobs, dates);
  }
  bySurname(tokens: readonly string[]): readonly MatchTarget[] {
    return collect(this.surnames, tokens);
  }
}

/** Symmetric in-memory negative-pair set. */
export class NegativePairSet implements NegativePairs {
  private readonly pairs = new Set<string>();
  constructor(pairs: Iterable<readonly [Ulid, Ulid]> = []) {
    for (const [a, b] of pairs) this.add(a, b);
  }
  private static k(a: Ulid, b: Ulid): string {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }
  add(a: Ulid, b: Ulid): void {
    this.pairs.add(NegativePairSet.k(a, b));
  }
  has(a: Ulid, b: Ulid): boolean {
    return this.pairs.has(NegativePairSet.k(a, b));
  }
}
