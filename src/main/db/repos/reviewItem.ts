import type { IsoDateTime, MatchCandidate, ReviewItem, ReviewKind, Ulid } from '@shared/domain/types';
import type { ReviewCounts } from '@shared/ipc/contract';
import { DbError } from '../errors';
import type { Db } from '../open';
import { fromJson, newId, nowIso, qs, toJson } from './util';

interface Row {
  id: string;
  kind: string;
  created_at: string;
  subject_ids_json: string | null;
  candidates_json: string | null;
  state: string;
  resolution: string | null;
  resolved_at: string | null;
}
export type ReviewItemRow = ReviewItem & { resolvedAt: IsoDateTime | null };
const map = (r: Row): ReviewItemRow => ({
  id: r.id,
  kind: r.kind as ReviewKind,
  createdAt: r.created_at,
  subjectIds: fromJson<Ulid[]>(r.subject_ids_json, []),
  candidates: fromJson<MatchCandidate[]>(r.candidates_json, []),
  state: r.state as ReviewItem['state'],
  resolution: r.resolution,
  resolvedAt: r.resolved_at,
});

export class ReviewItemRepo {
  constructor(private readonly db: Db) {}

  insert(input: {
    kind: ReviewKind;
    subjectIds: Ulid[];
    candidates: MatchCandidate[];
    createdAt?: IsoDateTime;
    id?: Ulid;
  }): ReviewItemRow {
    const id = input.id ?? newId();
    this.db
      .prepare(
        "INSERT INTO review_item(id, kind, created_at, subject_ids_json, candidates_json, state, resolution, resolved_at) VALUES (?,?,?,?,?,'open',NULL,NULL)",
      )
      .run(id, input.kind, input.createdAt ?? nowIso(), toJson(input.subjectIds), toJson(input.candidates));
    return this.get(id)!;
  }
  get(id: Ulid): ReviewItemRow | null {
    const r = this.db.prepare('SELECT * FROM review_item WHERE id = ?').get(id) as Row | undefined;
    return r ? map(r) : null;
  }
  list(q: { offset: number; limit: number; kinds?: ReviewKind[]; state?: ReviewItem['state'] }): {
    items: ReviewItemRow[];
    total: number;
  } {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (q.kinds?.length) {
      where.push(`kind IN (${qs(q.kinds.length)})`);
      vals.push(...q.kinds);
    }
    if (q.state) {
      where.push('state = ?');
      vals.push(q.state);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT count(*) AS n FROM review_item ${w}`).get(...vals) as { n: number }).n;
    const rows = this.db
      .prepare(`SELECT * FROM review_item ${w} ORDER BY created_at, id LIMIT ? OFFSET ?`)
      .all(...vals, q.limit, q.offset) as Row[];
    return { items: rows.map(map), total };
  }
  /** Open items naming `subjectId` among their subjects. */
  openForSubject(subjectId: Ulid): ReviewItemRow[] {
    return (
      this.db
        .prepare(
          "SELECT r.* FROM review_item r WHERE r.state = 'open' AND EXISTS (SELECT 1 FROM json_each(r.subject_ids_json) j WHERE j.value = ?) ORDER BY r.id",
        )
        .all(subjectId) as Row[]
    ).map(map);
  }
  resolve(id: Ulid, state: 'resolved' | 'dismissed', resolution: string, at: IsoDateTime = nowIso()): ReviewItemRow {
    const r = this.db
      .prepare('UPDATE review_item SET state = ?, resolution = ?, resolved_at = ? WHERE id = ?')
      .run(state, resolution, at, id);
    if (r.changes === 0) throw new DbError('NOT_FOUND', 'review item not found');
    return this.get(id)!;
  }
  reopen(id: Ulid): void {
    this.db
      .prepare("UPDATE review_item SET state = 'open', resolution = NULL, resolved_at = NULL WHERE id = ?")
      .run(id);
  }
  counts(): ReviewCounts {
    const rows = this.db
      .prepare("SELECT kind, count(*) AS n FROM review_item WHERE state = 'open' GROUP BY kind")
      .all() as { kind: ReviewKind; n: number }[];
    const byKind: ReviewCounts['byKind'] = {};
    let open = 0;
    for (const r of rows) {
      byKind[r.kind] = r.n;
      open += r.n;
    }
    return { open, byKind };
  }
  delete(id: Ulid): void {
    this.db.prepare('DELETE FROM review_item WHERE id = ?').run(id);
  }
}
