import type {
  DobPrecision,
  Identifier,
  IsoDate,
  IsoDateTime,
  Person,
  PersonName,
  PlaceOfBirth,
  Script,
  Sex,
  Ulid,
} from '@shared/domain/types';
import { DbError } from '../errors';
import type { Db } from '../open';
import { reindexPerson, removeFromSearch } from '../search';
import { chunked, fromJson, newId, nowIso, qs, toJson } from './util';

export interface AliasInput extends PersonName {
  coreKey?: string | null;
  sourceKind?: string | null;
  sourceId?: Ulid | null;
  seenAt?: IsoDateTime | null;
}
export interface IdentifierInput extends Identifier {
  sourceKind?: string | null;
  sourceId?: Ulid | null;
}
export interface PersonInput {
  canonical: PersonName;
  dob: IsoDate | null;
  dobPrecision: DobPrecision;
  sex: Sex | null;
  pob: PlaceOfBirth;
  nationality: string | null;
  notes?: string;
  coreKey?: string | null;
  fullKey?: string | null;
  /** Request whose import created this person (undo-import provenance). */
  createdByRequestId?: Ulid | null;
  aliases?: AliasInput[];
  identifiers?: IdentifierInput[];
  /** Explicit id (tests, restore); default a new ULID. */
  id?: Ulid;
  at?: IsoDateTime;
}
export interface PersonPatchFields {
  canonical?: PersonName;
  dob?: IsoDate | null;
  dobPrecision?: DobPrecision;
  sex?: Sex | null;
  pob?: PlaceOfBirth;
  nationality?: string | null;
  notes?: string;
  state?: Person['state'];
  mergedInto?: Ulid | null;
  coreKey?: string | null;
  fullKey?: string | null;
}
export interface PersonAliasRow extends PersonName {
  id: Ulid;
  personId: Ulid;
  coreKey: string | null;
  sourceKind: string | null;
  sourceId: Ulid | null;
  seenAt: IsoDateTime | null;
}
export interface PersonKeys {
  coreKey: string | null;
  fullKey: string | null;
  createdByRequestId: Ulid | null;
}

interface PersonDbRow {
  id: string;
  created_at: string;
  updated_at: string;
  surname: string | null;
  given_json: string | null;
  raw_name: string | null;
  script: string | null;
  dob: string | null;
  dob_precision: string | null;
  sex: string | null;
  pob_city: string | null;
  pob_state: string | null;
  pob_country: string | null;
  nationality: string | null;
  state: string;
  merged_into: string | null;
  notes: string;
  core_key: string | null;
  full_key: string | null;
  created_by_request_id: string | null;
}
interface AliasDbRow {
  id: string;
  person_id: string;
  surname: string | null;
  given_json: string | null;
  raw: string | null;
  script: string | null;
  core_key: string | null;
  source_kind: string | null;
  source_id: string | null;
  seen_at: string | null;
}
interface IdDbRow {
  person_id: string;
  type: string;
  value: string;
  value_folded: string;
  issuing_country: string | null;
}

const toName = (
  surname: string | null,
  given: string | null,
  raw: string | null,
  script: string | null,
): PersonName => ({
  surname: surname ?? '',
  given: fromJson<string[]>(given, []),
  raw: raw ?? '',
  script: (script ?? 'Other') as Script,
});

export class PersonRepo {
  constructor(private readonly db: Db) {}

  insert(input: PersonInput): Person {
    const id = input.id ?? newId();
    const at = input.at ?? nowIso();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO person(id, created_at, updated_at, surname, given_json, raw_name, script, dob, dob_precision, sex,
             pob_city, pob_state, pob_country, nationality, state, merged_into, notes, core_key, full_key, created_by_request_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',NULL,?,?,?,?)`,
        )
        .run(
          id,
          at,
          at,
          input.canonical.surname,
          toJson(input.canonical.given),
          input.canonical.raw,
          input.canonical.script,
          input.dob,
          input.dobPrecision,
          input.sex,
          input.pob.city,
          input.pob.state,
          input.pob.country,
          input.nationality,
          input.notes ?? '',
          input.coreKey ?? null,
          input.fullKey ?? null,
          input.createdByRequestId ?? null,
        );
      for (const a of input.aliases ?? []) this.insertAlias(id, a);
      for (const i of input.identifiers ?? []) this.insertIdentifier(id, i);
      reindexPerson(this.db, id);
    });
    return this.get(id)!;
  }

  private insertAlias(personId: Ulid, a: AliasInput): Ulid {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO person_alias(id, person_id, surname, given_json, raw, script, core_key, source_kind, source_id, seen_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        personId,
        a.surname,
        toJson(a.given),
        a.raw,
        a.script,
        a.coreKey ?? null,
        a.sourceKind ?? null,
        a.sourceId ?? null,
        a.seenAt ?? null,
      );
    return id;
  }

  private insertIdentifier(personId: Ulid, i: IdentifierInput): Ulid {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO identifier(id, person_id, type, value, value_folded, issuing_country, source_kind, source_id)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(id, personId, i.type, i.value, i.valueFolded, i.issuingCountry, i.sourceKind ?? null, i.sourceId ?? null);
    return id;
  }

  addAlias(personId: Ulid, a: AliasInput): Ulid {
    return this.db.transaction(() => {
      this.requireRow(personId);
      const id = this.insertAlias(personId, a);
      this.touch(personId);
      reindexPerson(this.db, personId);
      return id;
    });
  }

  removeAlias(aliasId: Ulid): void {
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT person_id FROM person_alias WHERE id = ?').get(aliasId) as
        { person_id: string } | undefined;
      if (!row) return;
      this.db.prepare('DELETE FROM person_alias WHERE id = ?').run(aliasId);
      reindexPerson(this.db, row.person_id);
    });
  }

  addIdentifier(personId: Ulid, i: IdentifierInput): Ulid {
    return this.db.transaction(() => {
      this.requireRow(personId);
      const id = this.insertIdentifier(personId, i);
      this.touch(personId);
      reindexPerson(this.db, personId);
      return id;
    });
  }

  listAliases(personId: Ulid): PersonAliasRow[] {
    return (
      this.db.prepare('SELECT * FROM person_alias WHERE person_id = ? ORDER BY id').all(personId) as AliasDbRow[]
    ).map((r) => ({
      id: r.id,
      personId: r.person_id,
      ...toName(r.surname, r.given_json, r.raw, r.script),
      coreKey: r.core_key,
      sourceKind: r.source_kind,
      sourceId: r.source_id,
      seenAt: r.seen_at,
    }));
  }

  update(id: Ulid, patch: PersonPatchFields, at: IsoDateTime = nowIso()): Person {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const set = (col: string, v: unknown) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    if (patch.canonical) {
      set('surname', patch.canonical.surname);
      set('given_json', toJson(patch.canonical.given));
      set('raw_name', patch.canonical.raw);
      set('script', patch.canonical.script);
    }
    if (patch.dob !== undefined) set('dob', patch.dob);
    if (patch.dobPrecision !== undefined) set('dob_precision', patch.dobPrecision);
    if (patch.sex !== undefined) set('sex', patch.sex);
    if (patch.pob) {
      set('pob_city', patch.pob.city);
      set('pob_state', patch.pob.state);
      set('pob_country', patch.pob.country);
    }
    if (patch.nationality !== undefined) set('nationality', patch.nationality);
    if (patch.notes !== undefined) set('notes', patch.notes);
    if (patch.state !== undefined) set('state', patch.state);
    if (patch.mergedInto !== undefined) set('merged_into', patch.mergedInto);
    if (patch.coreKey !== undefined) set('core_key', patch.coreKey);
    if (patch.fullKey !== undefined) set('full_key', patch.fullKey);
    set('updated_at', at);
    this.db.transaction(() => {
      const r = this.db.prepare(`UPDATE person SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
      if (r.changes === 0) throw new DbError('NOT_FOUND', 'person not found');
      reindexPerson(this.db, id);
    });
    return this.get(id)!;
  }

  /** Hard delete (purge / undo): aliases, identifiers, search blob. Caller ensures nothing else references it. */
  delete(id: Ulid): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM person_alias WHERE person_id = ?').run(id);
      this.db.prepare('DELETE FROM identifier WHERE person_id = ?').run(id);
      this.db.prepare('DELETE FROM person WHERE id = ?').run(id);
      removeFromSearch(this.db, 'person', id);
    });
  }

  get(id: Ulid): Person | null {
    return this.hydrate([id])[0] ?? null;
  }
  getMany(ids: readonly Ulid[]): Person[] {
    return this.hydrate(ids);
  }
  keys(id: Ulid): PersonKeys | null {
    const r = this.db.prepare('SELECT core_key, full_key, created_by_request_id FROM person WHERE id = ?').get(id) as
      { core_key: string | null; full_key: string | null; created_by_request_id: string | null } | undefined;
    return r ? { coreKey: r.core_key, fullKey: r.full_key, createdByRequestId: r.created_by_request_id } : null;
  }

  /** Persons whose canonical or alias core key equals `coreKey`. Active only unless includeMerged. */
  findByCoreKey(coreKey: string, opts: { includeMerged?: boolean } = {}): Person[] {
    const ids = this.db
      .prepare(`SELECT id FROM person WHERE core_key = ? UNION SELECT person_id FROM person_alias WHERE core_key = ?`)
      .all(coreKey, coreKey) as { id: string }[];
    return this.filterState(this.hydrate(ids.map((r) => r.id)), opts.includeMerged);
  }

  /** Persons born on `dob`; with `includeSwapped`, also on the day/month-swapped date. */
  findByDob(dob: IsoDate, opts: { includeSwapped?: boolean; includeMerged?: boolean } = {}): Person[] {
    const dates = [dob];
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
    if (opts.includeSwapped && m && m[2] !== m[3] && Number(m[3]) <= 12) dates.push(`${m[1]}-${m[3]}-${m[2]}`);
    const ids = this.db.prepare(`SELECT id FROM person WHERE dob IN (${qs(dates.length)})`).all(...dates) as {
      id: string;
    }[];
    return this.filterState(this.hydrate(ids.map((r) => r.id)), opts.includeMerged);
  }

  /** Persons holding an identifier with this folded value (optionally of one type). */
  findByIdentifier(valueFolded: string, type?: Identifier['type'], opts: { includeMerged?: boolean } = {}): Person[] {
    const rows = (
      type
        ? this.db
            .prepare('SELECT DISTINCT person_id FROM identifier WHERE type = ? AND value_folded = ?')
            .all(type, valueFolded)
        : this.db.prepare('SELECT DISTINCT person_id FROM identifier WHERE value_folded = ?').all(valueFolded)
    ) as { person_id: string }[];
    return this.filterState(this.hydrate(rows.map((r) => r.person_id)), opts.includeMerged);
  }

  /** Active persons, by surname then id. */
  list(q: { offset: number; limit: number; includeMerged?: boolean }): { items: Person[]; total: number } {
    const where = q.includeMerged ? "state != 'purged'" : "state = 'active'";
    const total = (this.db.prepare(`SELECT count(*) AS n FROM person WHERE ${where}`).get() as { n: number }).n;
    const ids = this.db
      .prepare(`SELECT id FROM person WHERE ${where} ORDER BY surname, id LIMIT ? OFFSET ?`)
      .all(q.limit, q.offset) as { id: string }[];
    return { items: this.hydrate(ids.map((r) => r.id)), total };
  }

  count(state: Person['state'] = 'active'): number {
    return (this.db.prepare('SELECT count(*) AS n FROM person WHERE state = ?').get(state) as { n: number }).n;
  }

  private filterState(ps: Person[], includeMerged?: boolean): Person[] {
    return ps.filter((p) => p.state === 'active' || (includeMerged && p.state === 'merged'));
  }

  private requireRow(id: Ulid): void {
    if (!this.db.prepare('SELECT 1 AS x FROM person WHERE id = ?').get(id))
      throw new DbError('NOT_FOUND', 'person not found');
  }
  private touch(id: Ulid): void {
    this.db.prepare('UPDATE person SET updated_at = ? WHERE id = ?').run(nowIso(), id);
  }

  private hydrate(ids: readonly Ulid[]): Person[] {
    if (ids.length === 0) return [];
    const uniq = [...new Set(ids)];
    const rows = chunked(
      uniq,
      (c) => this.db.prepare(`SELECT * FROM person WHERE id IN (${qs(c.length)})`).all(...c) as PersonDbRow[],
    );
    const aliases = chunked(
      uniq,
      (c) =>
        this.db
          .prepare(`SELECT * FROM person_alias WHERE person_id IN (${qs(c.length)}) ORDER BY id`)
          .all(...c) as AliasDbRow[],
    );
    const idents = chunked(
      uniq,
      (c) =>
        this.db
          .prepare(
            `SELECT person_id, type, value, value_folded, issuing_country FROM identifier WHERE person_id IN (${qs(c.length)}) ORDER BY id`,
          )
          .all(...c) as IdDbRow[],
    );
    const aBy = new Map<string, PersonName[]>();
    for (const a of aliases) {
      const l = aBy.get(a.person_id) ?? [];
      l.push(toName(a.surname, a.given_json, a.raw, a.script));
      aBy.set(a.person_id, l);
    }
    const iBy = new Map<string, Identifier[]>();
    for (const i of idents) {
      const l = iBy.get(i.person_id) ?? [];
      l.push({
        type: i.type as Identifier['type'],
        value: i.value,
        valueFolded: i.value_folded,
        issuingCountry: i.issuing_country,
      });
      iBy.set(i.person_id, l);
    }
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out: Person[] = [];
    for (const id of uniq) {
      const r = byId.get(id);
      if (!r) continue;
      out.push({
        id: r.id,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        canonical: toName(r.surname, r.given_json, r.raw_name, r.script),
        aliases: aBy.get(id) ?? [],
        dob: r.dob,
        dobPrecision: (r.dob_precision ?? 'unknown') as DobPrecision,
        sex: r.sex as Sex | null,
        pob: { city: r.pob_city, state: r.pob_state, country: r.pob_country },
        nationality: r.nationality,
        identifiers: iBy.get(id) ?? [],
        state: r.state as Person['state'],
        mergedInto: r.merged_into,
        notes: r.notes,
      });
    }
    return out;
  }
}
