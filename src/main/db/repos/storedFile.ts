import { createHash } from 'node:crypto';
import type { IsoDateTime, StoredFile, Ulid } from '@shared/domain/types';
import type { Db } from '../open';
import { newId, nowIso } from './util';

interface Row {
  id: string;
  original_name: string | null;
  sha256: string | null;
  bytes: number | null;
  stored_at: string | null;
}
const map = (r: Row): StoredFile => ({
  id: r.id,
  originalName: r.original_name ?? '',
  sha256: r.sha256 ?? '',
  bytes: r.bytes ?? 0,
  storedAt: r.stored_at ?? '',
});

export const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** Original files (request/response workbooks, exports) kept as blobs inside the encrypted DB. */
export class StoredFileRepo {
  constructor(private readonly db: Db) {}

  put(input: { originalName: string; content: Uint8Array; storedAt?: IsoDateTime; id?: Ulid }): StoredFile {
    const id = input.id ?? newId();
    const sha = sha256Hex(input.content);
    const at = input.storedAt ?? nowIso();
    this.db
      .prepare('INSERT INTO stored_file(id, original_name, sha256, bytes, stored_at, content) VALUES (?,?,?,?,?,?)')
      .run(
        id,
        input.originalName,
        sha,
        input.content.byteLength,
        at,
        Buffer.from(input.content.buffer, input.content.byteOffset, input.content.byteLength),
      );
    return { id, originalName: input.originalName, sha256: sha, bytes: input.content.byteLength, storedAt: at };
  }

  get(id: Ulid): StoredFile | null {
    const r = this.db
      .prepare('SELECT id, original_name, sha256, bytes, stored_at FROM stored_file WHERE id = ?')
      .get(id) as Row | undefined;
    return r ? map(r) : null;
  }

  /** File bytes; null when unknown or scrubbed by a purge (see `scrub`). */
  content(id: Ulid): Buffer | null {
    const r = this.db.prepare('SELECT content, purged_at FROM stored_file WHERE id = ?').get(id) as
      { content: Buffer; purged_at: string | null } | undefined;
    return r && r.purged_at === null ? r.content : null;
  }

  /** True when the file was scrubbed by a person purge (row and sha256 kept, bytes gone). */
  isPurged(id: Ulid): boolean {
    const r = this.db.prepare('SELECT purged_at FROM stored_file WHERE id = ?').get(id) as
      { purged_at: string | null } | undefined;
    return !!r && r.purged_at !== null;
  }

  /**
   * Purge support (F-01): drop the bytes and the original file name of these files, keep id / sha256 / size so
   * references stay valid and a re-import of the same file is still detected. Pages are zeroed by secure_delete.
   */
  scrub(ids: readonly Ulid[], at: IsoDateTime): void {
    if (ids.length === 0) return;
    this.db
      .prepare(
        `UPDATE stored_file SET content = X'', original_name = 'removed-by-purge', purged_at = ?
         WHERE id IN (SELECT value FROM json_each(?))`,
      )
      .run(at, JSON.stringify([...new Set(ids)]));
  }

  /** Content re-hashed and compared with the stored sha256. */
  verify(id: Ulid): boolean {
    const r = this.db.prepare('SELECT sha256, content, purged_at FROM stored_file WHERE id = ?').get(id) as
      { sha256: string; content: Buffer; purged_at: string | null } | undefined;
    return !!r && r.purged_at === null && sha256Hex(r.content) === r.sha256;
  }

  findBySha256(sha: string): StoredFile[] {
    return (
      this.db
        .prepare('SELECT id, original_name, sha256, bytes, stored_at FROM stored_file WHERE sha256 = ? ORDER BY id')
        .all(sha) as Row[]
    ).map(map);
  }

  /** True when a request, export or response points at the file. */
  isReferenced(id: Ulid): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 AS x FROM request WHERE source_file_id = @id
         UNION ALL SELECT 1 FROM export WHERE file_id = @id
         UNION ALL SELECT 1 FROM response WHERE source_file_id = @id LIMIT 1`,
      )
      .get({ id });
  }

  delete(id: Ulid): void {
    this.db.prepare('DELETE FROM stored_file WHERE id = ?').run(id);
  }
}
