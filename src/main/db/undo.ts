/**
 * Undo cascade: delete a request and every record its import created, keeping anything still referenced elsewhere.
 * Runs in ONE transaction; any failure rolls everything back. Audit rows are never touched (append-only); the caller
 * appends an audit event for the removal.
 */
import type { Ulid } from '@shared/domain/types';
import { DbError } from './errors';
import type { Db } from './open';
import { reindexPerson, removeFromSearch } from './search';
import { StoredFileRepo } from './repos/storedFile';
import { qs, toJson } from './repos/util';

export interface UndoRequestOptions {
  /** Also delete DC responses linked to the request (their rows and the records created from them). Default false => IN_USE. */
  includeResponses?: boolean;
  /** Test hook: runs inside the transaction just before commit; a throw rolls back. */
  beforeCommit?: () => void;
}
export interface UndoRequestResult {
  requestId: Ulid;
  itemsDeleted: number;
  vettingRecordsDeleted: number;
  unitVettingRecordsDeleted: number;
  exportsDeleted: number;
  responsesDeleted: number;
  reviewItemsDeleted: number;
  personsDeleted: Ulid[];
  personsKept: Ulid[];
  unitsDeleted: Ulid[];
  unitsKept: Ulid[];
  filesDeleted: number;
}

const ids = (rows: unknown[]): string[] => (rows as { id: string }[]).map((r) => r.id);

function personReferenced(db: Db, id: Ulid): boolean {
  return !!db
    .prepare(
      `SELECT 1 AS x FROM request_item WHERE person_id = @id
       UNION ALL SELECT 1 FROM response_row WHERE person_id = @id
       UNION ALL SELECT 1 FROM vetting_record WHERE person_id = @id
       UNION ALL SELECT 1 FROM unit_vetting_record WHERE commander_person_id = @id
       UNION ALL SELECT 1 FROM person WHERE merged_into = @id
       UNION ALL SELECT 1 FROM merge_log WHERE survivor_id = @id OR merged_id = @id
       UNION ALL SELECT 1 FROM negative_pair WHERE a = @id OR b = @id
       LIMIT 1`,
    )
    .get({ id });
}

function unitReferenced(db: Db, id: Ulid): boolean {
  return !!db
    .prepare(
      `SELECT 1 AS x FROM request_item WHERE unit_id = @id
       UNION ALL SELECT 1 FROM vetting_record WHERE unit_id = @id
       UNION ALL SELECT 1 FROM unit_vetting_record WHERE unit_id = @id
       LIMIT 1`,
    )
    .get({ id });
}

export function undoRequest(db: Db, requestId: Ulid, opts: UndoRequestOptions = {}): UndoRequestResult {
  const files = new StoredFileRepo(db);
  return db.transaction(() => {
    const req = db.prepare('SELECT source_file_id FROM request WHERE id = ?').get(requestId) as
      { source_file_id: string | null } | undefined;
    if (!req) throw new DbError('NOT_FOUND', 'request not found');

    const itemIds = ids(db.prepare('SELECT id FROM request_item WHERE request_id = ?').all(requestId));
    const itemJson = toJson(itemIds);
    const linkedPersons = new Set(
      (
        db
          .prepare('SELECT DISTINCT person_id AS id FROM request_item WHERE request_id = ? AND person_id IS NOT NULL')
          .all(requestId) as { id: string }[]
      ).map((r) => r.id),
    );
    const fileIds = new Set<string>();
    if (req.source_file_id) fileIds.add(req.source_file_id);

    // Responses linked to the request.
    const responses = db.prepare('SELECT id, source_file_id FROM response WHERE request_id = ?').all(requestId) as {
      id: string;
      source_file_id: string | null;
    }[];
    if (responses.length > 0 && !opts.includeResponses) throw new DbError('IN_USE', 'request has linked responses');
    // Rows of OTHER responses pointing at our items block the undo.
    const foreignRows = db
      .prepare(
        `SELECT count(*) AS n FROM response_row WHERE request_item_id IN (SELECT value FROM json_each(?))
         AND response_id NOT IN (SELECT id FROM response WHERE request_id = ?)`,
      )
      .get(itemJson, requestId) as { n: number };
    if (foreignRows.n > 0) throw new DbError('IN_USE', 'request items are referenced by another response');

    let vettingRecordsDeleted = 0;
    let reviewItemsDeleted = 0;
    const respIds = responses.map((r) => r.id);
    if (respIds.length > 0) {
      const rowIds = ids(
        db.prepare(`SELECT id FROM response_row WHERE response_id IN (${qs(respIds.length)})`).all(...respIds),
      );
      const rowJson = toJson(rowIds);
      for (const r of db
        .prepare(
          'SELECT DISTINCT person_id AS id FROM response_row WHERE id IN (SELECT value FROM json_each(?)) AND person_id IS NOT NULL',
        )
        .all(rowJson) as { id: string }[])
        linkedPersons.add(r.id);
      for (const r of db
        .prepare(
          'SELECT DISTINCT person_id AS id FROM vetting_record WHERE response_row_id IN (SELECT value FROM json_each(?))',
        )
        .all(rowJson) as { id: string }[])
        linkedPersons.add(r.id);
      vettingRecordsDeleted += db
        .prepare('DELETE FROM vetting_record WHERE response_row_id IN (SELECT value FROM json_each(?))')
        .run(rowJson).changes;
      db.prepare('DELETE FROM unit_vetting_record WHERE response_row_id IN (SELECT value FROM json_each(?))').run(
        rowJson,
      );
      reviewItemsDeleted += db
        .prepare(
          'DELETE FROM review_item WHERE EXISTS (SELECT 1 FROM json_each(review_item.subject_ids_json) j WHERE j.value IN (SELECT value FROM json_each(?)))',
        )
        .run(rowJson).changes;
      // Lane K (migration 008): corrections of these rows go with them.
      db.prepare('DELETE FROM response_row_edit WHERE row_id IN (SELECT value FROM json_each(?))').run(rowJson);
      db.prepare(`DELETE FROM response_row WHERE response_id IN (${qs(respIds.length)})`).run(...respIds);
      db.prepare(`DELETE FROM response WHERE id IN (${qs(respIds.length)})`).run(...respIds);
      for (const r of responses) {
        removeFromSearch(db, 'response', r.id);
        if (r.source_file_id) fileIds.add(r.source_file_id);
      }
    }

    for (const r of db
      .prepare('SELECT DISTINCT person_id AS id FROM vetting_record WHERE request_id = ?')
      .all(requestId) as { id: string }[])
      linkedPersons.add(r.id);
    vettingRecordsDeleted += db.prepare('DELETE FROM vetting_record WHERE request_id = ?').run(requestId).changes;
    const unitVettingRecordsDeleted = db
      .prepare('DELETE FROM unit_vetting_record WHERE request_id = ?')
      .run(requestId).changes;
    reviewItemsDeleted += db
      .prepare(
        `DELETE FROM review_item WHERE EXISTS (SELECT 1 FROM json_each(review_item.subject_ids_json) j
           WHERE j.value = ? OR j.value IN (SELECT value FROM json_each(?)))`,
      )
      .run(requestId, itemJson).changes;

    for (const r of db
      .prepare('SELECT file_id FROM export WHERE request_id = ? AND file_id IS NOT NULL')
      .all(requestId) as { file_id: string }[])
      fileIds.add(r.file_id);
    const exportsDeleted = db.prepare('DELETE FROM export WHERE request_id = ?').run(requestId).changes;

    // Aliases / identifiers that this import contributed to pre-existing persons.
    const sources = toJson([requestId, ...itemIds]);
    for (const r of db
      .prepare('SELECT DISTINCT person_id AS id FROM person_alias WHERE source_id IN (SELECT value FROM json_each(?))')
      .all(sources) as { id: string }[])
      linkedPersons.add(r.id);
    for (const r of db
      .prepare('SELECT DISTINCT person_id AS id FROM identifier WHERE source_id IN (SELECT value FROM json_each(?))')
      .all(sources) as { id: string }[])
      linkedPersons.add(r.id);
    db.prepare('DELETE FROM person_alias WHERE source_id IN (SELECT value FROM json_each(?))').run(sources);
    db.prepare('DELETE FROM identifier WHERE source_id IN (SELECT value FROM json_each(?))').run(sources);

    const itemsDeleted = db.prepare('DELETE FROM request_item WHERE request_id = ?').run(requestId).changes;
    db.prepare('DELETE FROM request WHERE id = ?').run(requestId);
    removeFromSearch(db, 'request', requestId);

    // Persons / units created by this import, deleted only when nothing else references them.
    const personsDeleted: Ulid[] = [];
    const personsKept: Ulid[] = [];
    for (const pid of ids(
      db.prepare('SELECT id FROM person WHERE created_by_request_id = ? ORDER BY id').all(requestId),
    )) {
      if (personReferenced(db, pid)) {
        db.prepare('UPDATE person SET created_by_request_id = NULL WHERE id = ?').run(pid);
        personsKept.push(pid);
      } else {
        db.prepare('DELETE FROM person_alias WHERE person_id = ?').run(pid);
        db.prepare('DELETE FROM identifier WHERE person_id = ?').run(pid);
        db.prepare('DELETE FROM person_edit WHERE person_id = ?').run(pid);
        db.prepare('DELETE FROM person WHERE id = ?').run(pid);
        removeFromSearch(db, 'person', pid);
        personsDeleted.push(pid);
        linkedPersons.delete(pid);
      }
    }
    const unitsDeleted: Ulid[] = [];
    const unitsKept: Ulid[] = [];
    for (const uid of ids(
      db.prepare('SELECT id FROM unit WHERE created_by_request_id = ? ORDER BY id').all(requestId),
    )) {
      if (unitReferenced(db, uid)) {
        db.prepare('UPDATE unit SET created_by_request_id = NULL WHERE id = ?').run(uid);
        unitsKept.push(uid);
      } else {
        db.prepare('DELETE FROM unit_alias WHERE unit_id = ?').run(uid);
        db.prepare('DELETE FROM unit WHERE id = ?').run(uid);
        removeFromSearch(db, 'unit', uid);
        unitsDeleted.push(uid);
      }
    }

    let filesDeleted = 0;
    for (const fid of fileIds) {
      if (!files.isReferenced(fid)) {
        files.delete(fid);
        filesDeleted++;
      }
    }

    for (const pid of linkedPersons) reindexPerson(db, pid);

    opts.beforeCommit?.();
    return {
      requestId,
      itemsDeleted,
      vettingRecordsDeleted,
      unitVettingRecordsDeleted,
      exportsDeleted,
      responsesDeleted: respIds.length,
      reviewItemsDeleted,
      personsDeleted,
      personsKept,
      unitsDeleted,
      unitsKept,
      filesDeleted,
    };
  });
}
