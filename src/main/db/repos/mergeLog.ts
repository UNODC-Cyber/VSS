import type { IsoDateTime, Ulid } from '@shared/domain/types';
import type { MergeLogEntry } from '@shared/ipc/contract';
import type { Db } from '../open';
import { fromJson, newId, nowIso, toJson } from './util';

interface Row {
  id: string;
  at: string;
  actor: string;
  survivor_id: string;
  merged_id: string;
  reason: string | null;
  snapshot_json: string | null;
}
const map = (r: Row): MergeLogEntry => ({
  id: r.id,
  at: r.at,
  actor: r.actor,
  survivorId: r.survivor_id,
  mergedId: r.merged_id,
  reason: r.reason ?? '',
});

export class MergeLogRepo {
  constructor(private readonly db: Db) {}

  /** `snapshot` is whatever the merge service needs to undo the merge (stored as JSON). */
  insert(input: {
    actor: string;
    survivorId: Ulid;
    mergedId: Ulid;
    reason: string;
    snapshot: unknown;
    at?: IsoDateTime;
    id?: Ulid;
  }): MergeLogEntry {
    const id = input.id ?? newId();
    const at = input.at ?? nowIso();
    this.db
      .prepare(
        'INSERT INTO merge_log(id, at, actor, survivor_id, merged_id, reason, snapshot_json) VALUES (?,?,?,?,?,?,?)',
      )
      .run(id, at, input.actor, input.survivorId, input.mergedId, input.reason, toJson(input.snapshot));
    return { id, at, actor: input.actor, survivorId: input.survivorId, mergedId: input.mergedId, reason: input.reason };
  }
  get(id: Ulid): MergeLogEntry | null {
    const r = this.db.prepare('SELECT * FROM merge_log WHERE id = ?').get(id) as Row | undefined;
    return r ? map(r) : null;
  }
  snapshot<T>(id: Ulid): T | null {
    const r = this.db.prepare('SELECT snapshot_json FROM merge_log WHERE id = ?').get(id) as
      { snapshot_json: string | null } | undefined;
    return r ? fromJson<T | null>(r.snapshot_json, null) : null;
  }
  /** Append a note (e.g. why the entry was undone) to the entry's reason. */
  appendNote(id: Ulid, note: string): void {
    this.db
      .prepare(
        "UPDATE merge_log SET reason = CASE WHEN coalesce(reason, '') = '' THEN ? ELSE reason || ' | ' || ? END WHERE id = ?",
      )
      .run(note, note, id);
  }
  listForPerson(personId: Ulid): MergeLogEntry[] {
    return (
      this.db
        .prepare('SELECT * FROM merge_log WHERE survivor_id = @id OR merged_id = @id ORDER BY at, id')
        .all({ id: personId }) as Row[]
    ).map(map);
  }
}
