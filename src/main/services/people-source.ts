/**
 * SQL-backed CandidateSource and NegativePairs for the matcher (lane C contracts), reading the encrypted DB through
 * lane D's repositories. Targets are only active persons, each with the units it was requested/vetted with.
 */
import type { IsoDate, Person, Ulid } from '@shared/domain/types';
import type { Db } from '../db/open';
import type { Repos } from '../db/repos';
import { targetFromPerson } from '../matching/records';
import type { CandidateSource, MatchTarget, NegativePairs } from '../matching/types';

export class SqlCandidateSource implements CandidateSource {
  private readonly cache = new Map<Ulid, MatchTarget>();
  constructor(
    private readonly db: Db,
    private readonly repos: Repos,
  ) {}

  /** Units a person is known with (request items and vetting records). */
  unitsOf(personId: Ulid): { unitIds: Ulid[]; unitNames: string[] } {
    const unitIds = (
      this.db
        .prepare(
          `SELECT unit_id AS id FROM request_item WHERE person_id = @p AND unit_id IS NOT NULL
           UNION SELECT unit_id FROM vetting_record WHERE person_id = @p AND unit_id IS NOT NULL`,
        )
        .all({ p: personId }) as { id: string }[]
    ).map((r) => r.id);
    const units = this.repos.units.getMany(unitIds);
    return { unitIds, unitNames: units.flatMap((u) => [u.name, ...u.aliases]) };
  }

  /** Father's names the person was requested with (request item observations; F-06 conflict evidence). */
  fatherNamesOf(personId: Ulid): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT json_extract(observed_json, '$.fatherName') AS f FROM request_item WHERE person_id = ?")
      .all(personId) as { f: unknown }[];
    return rows.flatMap((r) => (typeof r.f === 'string' && r.f.trim() !== '' ? [r.f] : []));
  }

  target(p: Person): MatchTarget {
    let t = this.cache.get(p.id);
    if (!t) {
      t = targetFromPerson(p, { ...this.unitsOf(p.id), fatherNames: this.fatherNamesOf(p.id) });
      this.cache.set(p.id, t);
    }
    return t;
  }
  private targets(ps: readonly Person[]): MatchTarget[] {
    return ps.filter((p) => p.state === 'active').map((p) => this.target(p));
  }

  byIdentifier(valuesFolded: readonly string[]): readonly MatchTarget[] {
    const vals = [...new Set(valuesFolded.filter((v) => v !== ''))];
    return this.targets(vals.flatMap((v) => this.repos.persons.findByIdentifier(v)));
  }
  byCoreKey(coreKey: string): readonly MatchTarget[] {
    return coreKey === '' ? [] : this.targets(this.repos.persons.findByCoreKey(coreKey));
  }
  byDob(dates: readonly IsoDate[]): readonly MatchTarget[] {
    return this.targets([...new Set(dates)].flatMap((d) => this.repos.persons.findByDob(d)));
  }
  bySurname(tokens: readonly string[]): readonly MatchTarget[] {
    const want = new Set(tokens.filter((t) => t !== ''));
    if (want.size === 0) return [];
    const ids = new Set<string>();
    const esc = (t: string): string => `% ${t.replace(/[\\%_]/g, (c) => `\\${c}`)} %`;
    for (const t of want) {
      const rows = this.db
        .prepare(
          `SELECT id FROM person WHERE state = 'active' AND (' ' || core_key || ' ') LIKE @t ESCAPE '\\'
           UNION SELECT person_id FROM person_alias WHERE (' ' || core_key || ' ') LIKE @t ESCAPE '\\'`,
        )
        .all({ t: esc(t) }) as { id: string }[];
      for (const r of rows) ids.add(r.id);
    }
    // Keep persons whose surname field (canonical or alias) holds one of the tokens, like the reference source.
    return this.targets(this.repos.persons.getMany([...ids])).filter((t) =>
      t.names.some((n) => (n.surname ?? []).some((s) => want.has(s))),
    );
  }
}

export class DbNegativePairs implements NegativePairs {
  constructor(private readonly repos: Repos) {}
  has(a: Ulid, b: Ulid): boolean {
    return this.repos.negativePairs.has(a, b);
  }
}
