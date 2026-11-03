import type { ExportPolicy, IsoDateTime, Ulid } from '@shared/domain/types';
import type { ExportMode } from '@shared/ipc/contract';
import type { Db } from '../open';
import { fromJson, newId, nowIso, toJson } from './util';

/** One produced export workbook (the file itself is a stored_file). */
export interface ExportRecord {
  id: Ulid;
  requestId: Ulid;
  createdAt: IsoDateTime;
  mode: ExportMode;
  fileId: Ulid | null;
  policy: ExportPolicy | null;
  includedItemIds: Ulid[];
  sha256: string | null;
}
interface Row {
  id: string;
  request_id: string;
  created_at: string;
  mode: string;
  file_id: string | null;
  policy_json: string | null;
  included_item_ids_json: string | null;
  sha256: string | null;
}
const map = (r: Row): ExportRecord => ({
  id: r.id,
  requestId: r.request_id,
  createdAt: r.created_at,
  mode: r.mode as ExportMode,
  fileId: r.file_id,
  policy: fromJson<ExportPolicy | null>(r.policy_json, null),
  includedItemIds: fromJson<Ulid[]>(r.included_item_ids_json, []),
  sha256: r.sha256,
});

export class ExportRepo {
  constructor(private readonly db: Db) {}

  insert(input: Omit<ExportRecord, 'id' | 'createdAt'> & { createdAt?: IsoDateTime; id?: Ulid }): ExportRecord {
    const rec: ExportRecord = { ...input, id: input.id ?? newId(), createdAt: input.createdAt ?? nowIso() };
    this.db
      .prepare(
        'INSERT INTO export(id, request_id, created_at, mode, file_id, policy_json, included_item_ids_json, sha256) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        rec.id,
        rec.requestId,
        rec.createdAt,
        rec.mode,
        rec.fileId,
        rec.policy ? toJson(rec.policy) : null,
        toJson(rec.includedItemIds),
        rec.sha256,
      );
    return rec;
  }
  get(id: Ulid): ExportRecord | null {
    const r = this.db.prepare('SELECT * FROM export WHERE id = ?').get(id) as Row | undefined;
    return r ? map(r) : null;
  }
  listByRequest(requestId: Ulid): ExportRecord[] {
    return (
      this.db.prepare('SELECT * FROM export WHERE request_id = ? ORDER BY created_at, id').all(requestId) as Row[]
    ).map(map);
  }
  latestForRequest(requestId: Ulid): ExportRecord | null {
    const r = this.db
      .prepare('SELECT * FROM export WHERE request_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
      .get(requestId) as Row | undefined;
    return r ? map(r) : null;
  }
  delete(id: Ulid): void {
    this.db.prepare('DELETE FROM export WHERE id = ?').run(id);
  }
}
