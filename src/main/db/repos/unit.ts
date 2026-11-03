import type { Ulid, Unit, UnitType } from '@shared/domain/types';
import { DbError } from '../errors';
import type { Db } from '../open';
import { foldForSearch, reindexPerson, reindexUnit, removeFromSearch } from '../search';
import { chunked, newId, qs } from './util';

export type UnitInput = Omit<Unit, 'id' | 'aliases'> & {
  aliases?: string[];
  /** Folded name used for exact lookups; default foldForSearch(name). */
  nameFolded?: string;
  createdByRequestId?: Ulid | null;
  id?: Ulid;
};
export type UnitPatchFields = Partial<Omit<Unit, 'id' | 'aliases'>> & { nameFolded?: string };

interface UnitDbRow {
  id: string;
  name: string;
  name_folded: string | null;
  type: string | null;
  country: string | null;
  unit_id_no: string | null;
  alias: string | null;
  location: string | null;
  description: string | null;
  english_description: string | null;
  branch_name: string | null;
  branch_description: string | null;
  parent_org: string | null;
  subordinate_org: string | null;
  org_level: string | null;
}

const COLS: [keyof Omit<Unit, 'id' | 'aliases'>, string][] = [
  ['name', 'name'],
  ['type', 'type'],
  ['country', 'country'],
  ['unitIdNo', 'unit_id_no'],
  ['alias', 'alias'],
  ['location', 'location'],
  ['description', 'description'],
  ['englishDescription', 'english_description'],
  ['branchName', 'branch_name'],
  ['branchDescription', 'branch_description'],
  ['parentOrg', 'parent_org'],
  ['subordinateOrg', 'subordinate_org'],
  ['orgLevel', 'org_level'],
];

export class UnitRepo {
  constructor(private readonly db: Db) {}

  insert(input: UnitInput): Unit {
    const id = input.id ?? newId();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO unit(id, name_folded, created_by_request_id, ${COLS.map((c) => c[1]).join(', ')})
           VALUES (?, ?, ?, ${qs(COLS.length)})`,
        )
        .run(
          id,
          input.nameFolded ?? foldForSearch(input.name),
          input.createdByRequestId ?? null,
          ...COLS.map(([k]) => input[k] ?? null),
        );
      for (const a of input.aliases ?? []) this.insertAlias(id, a);
      reindexUnit(this.db, id);
    });
    return this.get(id)!;
  }

  private insertAlias(unitId: Ulid, alias: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO unit_alias(unit_id, name_folded) VALUES (?, ?)')
      .run(unitId, foldForSearch(alias));
  }

  addAlias(unitId: Ulid, alias: string): void {
    this.db.transaction(() => {
      if (!this.db.prepare('SELECT 1 AS x FROM unit WHERE id = ?').get(unitId))
        throw new DbError('NOT_FOUND', 'unit not found');
      this.insertAlias(unitId, alias);
      reindexUnit(this.db, unitId);
    });
  }

  update(id: Ulid, patch: UnitPatchFields): Unit {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, col] of COLS) {
      if (patch[k] !== undefined) {
        sets.push(`${col} = ?`);
        vals.push(patch[k]);
      }
    }
    if (patch.nameFolded !== undefined || patch.name !== undefined) {
      sets.push('name_folded = ?');
      vals.push(patch.nameFolded ?? foldForSearch(patch.name!));
    }
    this.db.transaction(() => {
      if (sets.length > 0) {
        const r = this.db.prepare(`UPDATE unit SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
        if (r.changes === 0) throw new DbError('NOT_FOUND', 'unit not found');
      }
      reindexUnit(this.db, id);
      // Person blobs carry unit names.
      if (patch.name !== undefined) for (const pid of this.personIds(id)) reindexPerson(this.db, pid);
    });
    return this.get(id)!;
  }

  /** Hard delete (undo). Caller ensures nothing references it. */
  delete(id: Ulid): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM unit_alias WHERE unit_id = ?').run(id);
      this.db.prepare('DELETE FROM unit WHERE id = ?').run(id);
      removeFromSearch(this.db, 'unit', id);
    });
  }

  get(id: Ulid): Unit | null {
    return this.hydrate([id])[0] ?? null;
  }
  getMany(ids: readonly Ulid[]): Unit[] {
    return this.hydrate(ids);
  }

  /** Units whose folded name or folded alias equals foldForSearch(name), optionally within a country. */
  findByName(name: string, country?: string): Unit[] {
    const f = foldForSearch(name);
    const ids = this.db
      .prepare('SELECT id FROM unit WHERE name_folded = ? UNION SELECT unit_id FROM unit_alias WHERE name_folded = ?')
      .all(f, f) as { id: string }[];
    return this.hydrate(ids.map((r) => r.id)).filter((u) => country === undefined || u.country === country);
  }

  list(q: { offset: number; limit: number; country?: string; type?: UnitType }): { items: Unit[]; total: number } {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (q.country) {
      where.push('country = ?');
      vals.push(q.country);
    }
    if (q.type) {
      where.push('type = ?');
      vals.push(q.type);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT count(*) AS n FROM unit ${w}`).get(...vals) as { n: number }).n;
    const ids = this.db
      .prepare(`SELECT id FROM unit ${w} ORDER BY name, id LIMIT ? OFFSET ?`)
      .all(...vals, q.limit, q.offset) as {
      id: string;
    }[];
    return { items: this.hydrate(ids.map((r) => r.id)), total };
  }

  /** Persons linked to the unit via request items or vetting records. */
  personIds(unitId: Ulid): Ulid[] {
    return (
      this.db
        .prepare(
          `SELECT person_id AS id FROM request_item WHERE unit_id = ? AND person_id IS NOT NULL
           UNION SELECT person_id FROM vetting_record WHERE unit_id = ?`,
        )
        .all(unitId, unitId) as { id: string }[]
    ).map((r) => r.id);
  }

  private hydrate(ids: readonly Ulid[]): Unit[] {
    if (ids.length === 0) return [];
    const uniq = [...new Set(ids)];
    const rows = chunked(
      uniq,
      (c) => this.db.prepare(`SELECT * FROM unit WHERE id IN (${qs(c.length)})`).all(...c) as UnitDbRow[],
    );
    const al = chunked(
      uniq,
      (c) =>
        this.db
          .prepare(
            `SELECT unit_id, name_folded FROM unit_alias WHERE unit_id IN (${qs(c.length)}) ORDER BY name_folded`,
          )
          .all(...c) as {
          unit_id: string;
          name_folded: string;
        }[],
    );
    const aBy = new Map<string, string[]>();
    for (const a of al) aBy.set(a.unit_id, [...(aBy.get(a.unit_id) ?? []), a.name_folded]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return uniq.flatMap((id) => {
      const r = byId.get(id);
      if (!r) return [];
      const u: Unit = {
        id: r.id,
        name: r.name,
        type: (r.type ?? 'Other') as UnitType,
        country: r.country ?? '',
        unitIdNo: r.unit_id_no,
        alias: r.alias,
        location: r.location,
        description: r.description,
        englishDescription: r.english_description,
        branchName: r.branch_name,
        branchDescription: r.branch_description,
        parentOrg: r.parent_org,
        subordinateOrg: r.subordinate_org,
        orgLevel: r.org_level,
        aliases: aBy.get(id) ?? [],
      };
      return [u];
    });
  }
}
