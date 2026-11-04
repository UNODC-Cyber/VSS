/**
 * `persons.*` and `units.*` services (WP-13): search, detail, edit, merge / split with merge_log snapshots and exact
 * undo, "not the same person" pairs, password-gated purge, and the duplicate-persons scan.
 */
import type { LinkState, Person, Ulid, Unit } from '@shared/domain/types';
import type {
  Ack,
  IdRef,
  Page,
  PersonDetail,
  PersonListQuery,
  PersonMergeRequest,
  PersonNotSameRequest,
  PersonPatch,
  PersonPurgeRequest,
  PersonSuggestion,
  PersonSuggestRequest,
  PersonSummary,
  PersonUnmergeRequest,
  Result,
  UnitAliasRequest,
  UnitDetail,
  UnitListQuery,
  UnitMergeRequest,
  UnitPatch,
  UnitSummary,
} from '@shared/ipc/contract';
import { newId } from '../db/repos/util';
import { reindexPerson, reindexRequest, reindexResponse, reindexUnit, removeFromSearch, searchIds } from '../db/search';
import { generateCandidates, rankTargets } from '../matching/matcher';
import { keysOf, personInputFromObserved } from './people-ops';
import { DbNegativePairs, SqlCandidateSource } from './people-source';
import { summarize as summarizeRequests } from './requests';
import { snapshotsFor } from './vetting-status';
import { displayName, fail, makeCtx, notSupported, run } from './vetting-common';
import type { Ctx, ServiceDeps } from './vetting-common';

export interface PersonSplitRequest {
  personId: Ulid;
  /** Request items that belong to a different person; they (and what hangs off them) move to a new person. */
  itemIds: Ulid[];
  reason: string;
}
export interface DuplicateScanResult {
  pairsFound: number;
  reviewItemsCreated: number;
}

export interface PersonsService {
  list(req: PersonListQuery): Promise<Result<Page<PersonSummary>>>;
  get(req: IdRef): Promise<Result<PersonDetail>>;
  update(req: PersonPatch): Promise<Result<PersonDetail>>;
  merge(req: PersonMergeRequest): Promise<Result<PersonDetail>>;
  /** Undo a merge (or a split) recorded in merge_log, restoring every moved pointer exactly. */
  unmerge(req: PersonUnmergeRequest): Promise<Result<PersonDetail>>;
  split(req: PersonSplitRequest): Promise<Result<PersonDetail>>;
  markNotSame(req: PersonNotSameRequest): Promise<Result<Ack>>;
  purge(req: PersonPurgeRequest): Promise<Result<Ack>>;
  scanDuplicates(): Promise<Result<DuplicateScanResult>>;
  /** LANE K SLOT (docs/PLAN-ALPHA.md section 14): picker suggestions; NOT_SUPPORTED until lane K lands. */
  suggest(req: PersonSuggestRequest): Promise<Result<PersonSuggestion[]>>;
}
export interface UnitsService {
  list(req: UnitListQuery): Promise<Result<Page<UnitSummary>>>;
  get(req: IdRef): Promise<Result<UnitDetail>>;
  update(req: UnitPatch): Promise<Result<UnitDetail>>;
  addAlias(req: UnitAliasRequest): Promise<Result<UnitDetail>>;
  merge(req: UnitMergeRequest): Promise<Result<UnitDetail>>;
}

/** Everything a merge/split moved, so undo restores exactly these pointers and nothing added later. */
interface MoveSnapshot {
  kind: 'merge' | 'split';
  fromId: Ulid;
  toId: Ulid;
  itemIds: Ulid[];
  rowIds: Ulid[];
  recordIds: Ulid[];
  commanderRecordIds: Ulid[];
  aliasIds: Ulid[];
  identifierIds: Ulid[];
  /** Alias added to the survivor for the merged person's canonical name (merge only). */
  addedAliasId: Ulid | null;
  /** Review items resolved by the merge (reopened on undo). */
  resolvedReviewIds: Ulid[];
  /** Link states of moved items before a split (restored on undo). */
  itemLinkStates?: Record<Ulid, LinkState>;
}

const idsOf = (rows: unknown[]): Ulid[] => (rows as { id: string }[]).map((r) => r.id);

// ---------------------------------------------------------------------------------------------------------------
// person helpers
// ---------------------------------------------------------------------------------------------------------------

export function personSummaries(ctx: Ctx, persons: Person[]): PersonSummary[] {
  const snaps = snapshotsFor(
    ctx,
    persons.map((p) => p.id),
  );
  return persons.map((p) => {
    const s = snaps.get(p.id)!;
    const items = ctx.repos.requests.itemsByPerson(p.id);
    const unitId = s.unitId ?? items[items.length - 1]?.unitId ?? null;
    return {
      id: p.id,
      displayName: displayName(p.canonical),
      dob: p.dob,
      dobPrecision: p.dobPrecision,
      sex: p.sex,
      nationality: p.nationality,
      status: s.status,
      certDate: s.certDate,
      expiresAt: s.expiresAt,
      currentUnitName: unitId ? (ctx.repos.units.get(unitId)?.name ?? null) : null,
      requestCount: new Set(items.map((i) => i.requestId)).size,
      hasOpenReview:
        ctx.repos.reviews.openForSubject(p.id).length > 0 ||
        items.some((i) => ctx.repos.reviews.openForSubject(i.id).length > 0),
    };
  });
}

function personDetail(ctx: Ctx, id: Ulid): PersonDetail {
  const person = ctx.repos.persons.get(id);
  if (!person) return fail('NOT_FOUND', 'Person not found');
  const snap = snapshotsFor(ctx, [id]).get(id)!;
  const records = ctx.repos.vetting.listByPerson(id);
  const items = ctx.repos.requests.itemsByPerson(id);
  const unitIds = [
    ...new Set([...items.map((i) => i.unitId), ...records.map((r) => r.unitId)].filter((u): u is Ulid => !!u)),
  ];
  const reqIds = [...new Set(items.map((i) => i.requestId))];
  const headers = reqIds.map((r) => ctx.repos.requests.getHeader(r)).filter((h) => h !== null);
  return {
    person,
    status: snap.status,
    statusAsOf: snap.asOf,
    records,
    units: ctx.repos.units.getMany(unitIds),
    requests: summarizeRequests(ctx, headers),
    mergeHistory: ctx.repos.mergeLog.listForPerson(id),
    openReviewItemIds: [
      ...new Set([
        ...ctx.repos.reviews.openForSubject(id).map((r) => r.id),
        ...items.flatMap((i) => ctx.repos.reviews.openForSubject(i.id).map((r) => r.id)),
      ]),
    ],
  };
}

function requireActive(ctx: Ctx, id: Ulid): Person {
  const p = ctx.repos.persons.get(id);
  if (!p) return fail('NOT_FOUND', 'Person not found');
  if (p.state !== 'active') return fail('CONFLICT', 'Person is not active');
  return p;
}

function resolveDuplicateReviews(ctx: Ctx, a: Ulid, b: Ulid, resolution: string): Ulid[] {
  const out: Ulid[] = [];
  for (const r of ctx.repos.reviews.openForSubject(a))
    if (r.kind === 'duplicate-persons' && r.subjectIds.includes(b)) {
      ctx.repos.reviews.resolve(r.id, 'resolved', resolution, ctx.nowIso());
      out.push(r.id);
    }
  return out;
}

/** Merge `mergedId` into `survivorId` (inside a transaction, no audit). Returns the merge_log id. */
export function mergePersons(ctx: Ctx, survivorId: Ulid, mergedId: Ulid, reason: string): Ulid {
  if (survivorId === mergedId) return fail('BAD_REQUEST', 'Cannot merge a person with itself');
  requireActive(ctx, survivorId);
  const merged = requireActive(ctx, mergedId);
  if (ctx.repos.negativePairs.has(survivorId, mergedId))
    return fail('CONFLICT', 'These persons are recorded as not the same person');
  const db = ctx.db;
  const q = (sql: string): Ulid[] => idsOf(db.prepare(sql).all(mergedId));
  const snap: MoveSnapshot = {
    kind: 'merge',
    fromId: mergedId,
    toId: survivorId,
    itemIds: q('SELECT id FROM request_item WHERE person_id = ? ORDER BY id'),
    rowIds: q('SELECT id FROM response_row WHERE person_id = ? ORDER BY id'),
    recordIds: q('SELECT id FROM vetting_record WHERE person_id = ? ORDER BY id'),
    commanderRecordIds: q('SELECT id FROM unit_vetting_record WHERE commander_person_id = ? ORDER BY id'),
    aliasIds: q('SELECT id FROM person_alias WHERE person_id = ? ORDER BY id'),
    identifierIds: q('SELECT id FROM identifier WHERE person_id = ? ORDER BY id'),
    addedAliasId: null,
    resolvedReviewIds: [],
  };
  movePointers(ctx, snap, survivorId);
  const logId = newId();
  snap.addedAliasId = ctx.repos.persons.addAlias(survivorId, {
    ...merged.canonical,
    coreKey: keysOf(merged.canonical).coreKey,
    sourceKind: 'merge',
    sourceId: logId,
    seenAt: ctx.nowIso(),
  });
  ctx.repos.persons.update(mergedId, { state: 'merged', mergedInto: survivorId }, ctx.nowIso());
  snap.resolvedReviewIds = resolveDuplicateReviews(ctx, survivorId, mergedId, 'merged');
  ctx.repos.mergeLog.insert({
    id: logId,
    actor: ctx.actor(),
    survivorId,
    mergedId,
    reason,
    snapshot: snap,
    at: ctx.nowIso(),
  });
  reindexPerson(db, survivorId);
  reindexPerson(db, mergedId);
  return logId;
}

function movePointers(ctx: Ctx, s: MoveSnapshot, to: Ulid): void {
  const db = ctx.db;
  const upd = (table: string, col: string, ids: Ulid[]): void => {
    if (ids.length > 0)
      db.prepare(`UPDATE ${table} SET ${col} = ? WHERE id IN (SELECT value FROM json_each(?))`).run(
        to,
        JSON.stringify(ids),
      );
  };
  upd('request_item', 'person_id', s.itemIds);
  upd('response_row', 'person_id', s.rowIds);
  upd('vetting_record', 'person_id', s.recordIds);
  upd('unit_vetting_record', 'commander_person_id', s.commanderRecordIds);
  upd('person_alias', 'person_id', s.aliasIds);
  upd('identifier', 'person_id', s.identifierIds);
  reindexPerson(db, s.fromId);
  reindexPerson(db, s.toId);
}

function splitPerson(ctx: Ctx, req: PersonSplitRequest): { logId: Ulid; newId: Ulid } {
  const original = requireActive(ctx, req.personId);
  const items = ctx.repos.requests.getItems(req.itemIds);
  if (items.length === 0 || items.length !== new Set(req.itemIds).size)
    return fail('BAD_REQUEST', 'Select at least one request item of the person');
  if (items.some((i) => i.personId !== original.id)) return fail('BAD_REQUEST', 'Item is not linked to this person');
  if (ctx.repos.requests.itemsByPerson(original.id).length === items.length)
    return fail('BAD_REQUEST', 'A split must leave at least one item with the original person');
  const first = items[0]!;
  const input = personInputFromObserved(first.observed, first.id, null);
  const created = ctx.repos.persons.insert({ ...input, identifiers: [], at: ctx.nowIso() });
  const itemJson = JSON.stringify(items.map((i) => i.id));
  const db = ctx.db;
  const rowIds = idsOf(
    db
      .prepare(
        'SELECT id FROM response_row WHERE person_id = ? AND request_item_id IN (SELECT value FROM json_each(?)) ORDER BY id',
      )
      .all(original.id, itemJson),
  );
  const reqIds = [...new Set(items.map((i) => i.requestId))];
  const recordIds = idsOf(
    db
      .prepare(
        `SELECT id FROM vetting_record WHERE person_id = ? AND (response_row_id IN (SELECT value FROM json_each(?))
           OR (response_row_id IS NULL AND source = 'email' AND request_id IN (SELECT value FROM json_each(?)))) ORDER BY id`,
      )
      .all(original.id, JSON.stringify(rowIds), JSON.stringify(reqIds)),
  );
  const commanderRecordIds = idsOf(
    db
      .prepare(
        'SELECT id FROM unit_vetting_record WHERE commander_person_id = ? AND response_row_id IN (SELECT value FROM json_each(?)) ORDER BY id',
      )
      .all(original.id, JSON.stringify(rowIds)),
  );
  const srcJson = JSON.stringify([...items.map((i) => i.id), ...rowIds]);
  const aliasIds = idsOf(
    db
      .prepare(
        'SELECT id FROM person_alias WHERE person_id = ? AND source_id IN (SELECT value FROM json_each(?)) ORDER BY id',
      )
      .all(original.id, srcJson),
  );
  const identifierIds = idsOf(
    db
      .prepare(
        'SELECT id FROM identifier WHERE person_id = ? AND source_id IN (SELECT value FROM json_each(?)) ORDER BY id',
      )
      .all(original.id, srcJson),
  );
  const snap: MoveSnapshot = {
    kind: 'split',
    fromId: original.id,
    toId: created.id,
    itemIds: items.map((i) => i.id),
    rowIds,
    recordIds,
    commanderRecordIds,
    aliasIds,
    identifierIds,
    addedAliasId: null,
    resolvedReviewIds: [],
    itemLinkStates: Object.fromEntries(items.map((i) => [i.id, i.linkState])),
  };
  movePointers(ctx, snap, created.id);
  ctx.repos.requests
    .getItems(snap.itemIds)
    .forEach((i) => ctx.repos.requests.updateItem(i.id, { linkState: 'confirmed' }));
  // The two are, by this decision, not the same person.
  ctx.repos.negativePairs.add(original.id, created.id, ctx.nowIso());
  const log = ctx.repos.mergeLog.insert({
    actor: ctx.actor(),
    survivorId: original.id,
    mergedId: created.id,
    reason: req.reason,
    snapshot: snap,
    at: ctx.nowIso(),
  });
  return { logId: log.id, newId: created.id };
}

/** Undo a merge or split. Returns the id of the person to show. */
function undoMove(ctx: Ctx, logId: Ulid): Ulid {
  const entry = ctx.repos.mergeLog.get(logId) ?? fail('NOT_FOUND', 'Merge log entry not found');
  const s = ctx.repos.mergeLog.snapshot<MoveSnapshot>(logId) ?? fail('CONFLICT', 'Merge log entry has no snapshot');
  const db = ctx.db;
  const back = (table: string, col: string, ids: Ulid[], from: Ulid, to: Ulid): void => {
    if (ids.length > 0)
      db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ? AND id IN (SELECT value FROM json_each(?))`).run(
        to,
        from,
        JSON.stringify(ids),
      );
  };
  const restore = (from: Ulid, to: Ulid): void => {
    back('request_item', 'person_id', s.itemIds, from, to);
    back('response_row', 'person_id', s.rowIds, from, to);
    back('vetting_record', 'person_id', s.recordIds, from, to);
    back('unit_vetting_record', 'commander_person_id', s.commanderRecordIds, from, to);
    back('person_alias', 'person_id', s.aliasIds, from, to);
    back('identifier', 'person_id', s.identifierIds, from, to);
  };
  if (s.kind === 'merge') {
    const merged = ctx.repos.persons.get(s.fromId);
    if (!merged || merged.state !== 'merged' || merged.mergedInto !== s.toId)
      return fail('CONFLICT', 'This merge has already been undone or superseded');
    requireActive(ctx, s.toId);
    restore(s.toId, s.fromId);
    if (s.addedAliasId) ctx.repos.persons.removeAlias(s.addedAliasId);
    ctx.repos.persons.update(s.fromId, { state: 'active', mergedInto: null }, ctx.nowIso());
    for (const r of s.resolvedReviewIds) ctx.repos.reviews.reopen(r);
    reindexPerson(db, s.fromId);
    reindexPerson(db, s.toId);
    void entry;
    return s.fromId;
  }
  // split: move back to the original and remove the person the split created when nothing else uses it.
  const created = ctx.repos.persons.get(s.toId);
  if (!created || created.state !== 'active') return fail('CONFLICT', 'This split has already been undone');
  requireActive(ctx, s.fromId);
  restore(s.toId, s.fromId);
  for (const [itemId, linkState] of Object.entries(s.itemLinkStates ?? {}))
    ctx.repos.requests.updateItem(itemId, { linkState });
  ctx.repos.negativePairs.remove(s.fromId, s.toId);
  const used = db
    .prepare(
      `SELECT 1 AS x FROM request_item WHERE person_id = @id UNION ALL SELECT 1 FROM response_row WHERE person_id = @id
       UNION ALL SELECT 1 FROM vetting_record WHERE person_id = @id LIMIT 1`,
    )
    .get({ id: s.toId });
  // The created person stays as a merged shell (merge_log names it) and holds nothing after the restore.
  if (used) return fail('CONFLICT', 'The split-off person has been used since; merge it instead');
  ctx.repos.persons.update(s.toId, { state: 'merged', mergedInto: s.fromId }, ctx.nowIso());
  reindexPerson(db, s.fromId);
  reindexPerson(db, s.toId);
  return s.fromId;
}

const SEARCH_TABLES = ['person_search', 'unit_search', 'request_search', 'response_search'] as const;

/**
 * Remove personal data of a person and of everything that holds a copy of it (security review F-01). Records keep
 * dates and dispositions. In one transaction:
 * - persons merged into this one (the same human) are purged with it;
 * - person row, aliases, identifiers, linked request items and response rows are blanked; vetting-record notes and
 *   the free-text reasons of merge-log entries naming the person are cleared;
 * - the alias a merge added to a survivor for this person's name is removed (survivor re-indexed);
 * - "not the same person" pairs naming the person are deleted;
 * - every stored workbook that held the data (original request workbooks, exports of those requests, response
 *   files) is scrubbed: bytes and file name dropped, sha256 kept for re-import detection;
 * - the request / response search blobs are rebuilt so the purged name is no longer searchable.
 * FTS5 secure-delete (migration 003) plus `PRAGMA secure_delete` erase the old index entries and pages; the caller
 * checkpoints the WAL afterwards. Backups and files written outside VSS are not reached (docs/SECURITY.md).
 */
function purgePerson(ctx: Ctx, id: Ulid): void {
  const p = ctx.repos.persons.get(id) ?? fail('NOT_FOUND', 'Person not found');
  if (p.state === 'purged') return;
  const db = ctx.db;
  const shells = idsOf(db.prepare("SELECT id FROM person WHERE merged_into = ? AND state <> 'purged'").all(id));
  for (const s of shells) purgePerson(ctx, s);
  const requestIds = (
    db.prepare('SELECT DISTINCT request_id AS id FROM request_item WHERE person_id = ?').all(id) as { id: string }[]
  ).map((r) => r.id);
  const responseIds = (
    db.prepare('SELECT DISTINCT response_id AS id FROM response_row WHERE person_id = ?').all(id) as { id: string }[]
  ).map((r) => r.id);
  // Survivors that carry this person's name as a merge alias.
  const survivors = (
    db
      .prepare(
        `SELECT DISTINCT a.person_id AS id FROM person_alias a JOIN merge_log m ON a.source_kind = 'merge' AND a.source_id = m.id
         WHERE m.merged_id = ? AND a.person_id <> ?`,
      )
      .all(id, id) as { id: string }[]
  ).map((r) => r.id);
  db.prepare(
    `DELETE FROM person_alias WHERE source_kind = 'merge' AND source_id IN (SELECT id FROM merge_log WHERE merged_id = ?)`,
  ).run(id);
  db.prepare("UPDATE merge_log SET reason = '' WHERE survivor_id = ? OR merged_id = ?").run(id, id);
  db.prepare('DELETE FROM negative_pair WHERE a = ? OR b = ?').run(id, id);
  db.prepare("UPDATE vetting_record SET note = '' WHERE person_id = ?").run(id);
  const fileIds = (
    db
      .prepare(
        `SELECT source_file_id AS id FROM request WHERE id IN (SELECT value FROM json_each(@r)) AND source_file_id IS NOT NULL
         UNION SELECT file_id FROM export WHERE request_id IN (SELECT value FROM json_each(@r)) AND file_id IS NOT NULL
         UNION SELECT source_file_id FROM response WHERE id IN (SELECT value FROM json_each(@s)) AND source_file_id IS NOT NULL`,
      )
      .all({ r: JSON.stringify(requestIds), s: JSON.stringify(responseIds) }) as { id: string }[]
  ).map((r) => r.id);
  ctx.repos.files.scrub(fileIds, ctx.nowIso());
  db.prepare('DELETE FROM person_alias WHERE person_id = ?').run(id);
  db.prepare('DELETE FROM identifier WHERE person_id = ?').run(id);
  db.prepare(
    `UPDATE person SET surname = '', given_json = '[]', raw_name = '', dob = NULL, dob_precision = 'unknown', sex = NULL,
       pob_city = NULL, pob_state = NULL, pob_country = NULL, nationality = NULL, notes = '', core_key = NULL,
       full_key = NULL, state = 'purged', merged_into = NULL, updated_at = ? WHERE id = ?`,
  ).run(ctx.nowIso(), id);
  for (const it of ctx.repos.requests.itemsByPerson(id)) {
    const o = it.observed;
    const blank = {
      ...o,
      surname: '',
      name1: '',
      name2: '',
      name3: '',
      name4: '',
      passport: '',
      nationalId: '',
      titleRank: '',
      fatherName: '',
      motherName: '',
      dob: { kind: 'empty' as const, value: '', parsed: null, ambiguousDayMonth: false },
      pobCity: '',
      pobState: '',
      pobCountry: '',
      nationality: '',
      sex: '',
    };
    db.prepare(
      `UPDATE request_item SET observed_json = ?, core_key = NULL, name_key_json = NULL, issues_json = '[]',
         prior_json = NULL, export_reason = NULL WHERE id = ?`,
    ).run(JSON.stringify(blank), it.id);
  }
  db.prepare(
    `UPDATE response_row SET name_raw = '', surname = '', given_json = '[]', core_key = NULL, dob = NULL, dob_raw = '',
       pob_city = NULL, pob_state = NULL, pob_country = NULL, detail_json = NULL WHERE person_id = ?`,
  ).run(id);
  removeFromSearch(db, 'person', id);
  for (const r of requestIds) reindexRequest(db, r);
  for (const r of responseIds) reindexResponse(db, r);
  for (const s of survivors) reindexPerson(db, s);
}

/** Merge the FTS5 segments of every search table (drops any leftover deleted entries). */
function optimizeSearch(ctx: Ctx): void {
  for (const t of SEARCH_TABLES) ctx.db.prepare(`INSERT INTO ${t}(${t}) VALUES('optimize')`).run();
}

// ---------------------------------------------------------------------------------------------------------------
// factories
// ---------------------------------------------------------------------------------------------------------------

export function createPersonsService(deps: ServiceDeps): PersonsService {
  const ctx = makeCtx(deps);
  return {
    list: (q) =>
      run(() => {
        let ids: Ulid[] =
          q.text && q.text.trim() !== ''
            ? searchIds(ctx.db, 'person', q.text, 5000)
            : idsOf(ctx.db.prepare("SELECT id FROM person WHERE state = 'active' ORDER BY surname, id").all());
        if (q.unitId) {
          const inUnit = new Set(ctx.repos.units.personIds(q.unitId));
          ids = ids.filter((i) => inUnit.has(i));
        }
        let rows = personSummaries(
          ctx,
          ctx.repos.persons.getMany(ids).filter((p) => p.state === 'active'),
        );
        if (q.statuses?.length) rows = rows.filter((r) => q.statuses!.includes(r.status));
        if (q.expiringBefore) rows = rows.filter((r) => r.expiresAt !== null && r.expiresAt < q.expiringBefore!);
        const dir = q.direction === 'desc' ? -1 : 1;
        const key = (r: PersonSummary): string =>
          q.sort === 'expiresAt' ? (r.expiresAt ?? '9999') : q.sort === 'status' ? r.status : r.displayName;
        if (q.sort && q.sort !== 'updatedAt')
          rows.sort((a, b) => dir * (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.id < b.id ? -1 : 1));
        return {
          items: rows.slice(q.offset, q.offset + q.limit),
          total: rows.length,
          offset: q.offset,
          limit: q.limit,
        };
      }),

    get: ({ id }) => run(() => personDetail(ctx, id)),

    update: ({ id, patch }) =>
      run(() => {
        ctx.tx('persons.update', () => {
          requireActive(ctx, id);
          ctx.repos.persons.update(id, { ...patch, ...(patch.canonical ? keysOf(patch.canonical) : {}) }, ctx.nowIso());
          ctx.audit('person.update', 'person', id, { personId: id, fields: Object.keys(patch).sort().join(',') });
        });
        return personDetail(ctx, id);
      }),

    merge: ({ survivorId, mergedId, reason }) =>
      run(() => {
        ctx.tx('persons.merge', () => {
          const logId = mergePersons(ctx, survivorId, mergedId, reason);
          ctx.audit('person.merge', 'person', survivorId, { survivorId, mergedId, mergeLogId: logId });
        });
        return personDetail(ctx, survivorId);
      }),

    unmerge: ({ mergeLogId, reason }) =>
      run(() => {
        const shown = ctx.tx('persons.unmerge', () => {
          const entry = ctx.repos.mergeLog.get(mergeLogId);
          const id = undoMove(ctx, mergeLogId);
          const why = reason?.trim() ?? '';
          if (why !== '') ctx.repos.mergeLog.appendNote(mergeLogId, `undone ${ctx.nowIso().slice(0, 10)}: ${why}`);
          ctx.audit('person.unmerge', 'person', id, {
            mergeLogId,
            survivorId: entry?.survivorId ?? '',
            mergedId: entry?.mergedId ?? '',
          });
          return id;
        });
        return personDetail(ctx, shown);
      }),

    split: (req) =>
      run(() => {
        const r = ctx.tx('persons.split', () => {
          const out = splitPerson(ctx, req);
          ctx.audit('person.split', 'person', req.personId, {
            survivorId: req.personId,
            personId: out.newId,
            mergeLogId: out.logId,
            itemCount: req.itemIds.length,
          });
          return out;
        });
        return personDetail(ctx, r.newId);
      }),

    markNotSame: ({ a, b }) =>
      run((): Ack => {
        if (a === b) return fail('BAD_REQUEST', 'A person is always the same as itself');
        ctx.tx('persons.markNotSame', () => {
          if (!ctx.repos.persons.get(a) || !ctx.repos.persons.get(b)) return fail('NOT_FOUND', 'Person not found');
          ctx.repos.negativePairs.add(a, b, ctx.nowIso());
          resolveDuplicateReviews(ctx, a, b, 'not-same');
          ctx.audit('person.not-same', 'person', a, { personId: a, mergedId: b, action: 'not-same' });
        });
        return { ok: true };
      }),

    purge: ({ id, password }) =>
      run(async (): Promise<Ack> => {
        if (!(await ctx.verifyPassword(password))) return fail('BAD_CREDENTIALS', 'Password check failed');
        ctx.tx('persons.purge', () => {
          purgePerson(ctx, id);
          optimizeSearch(ctx);
          ctx.audit('person.purge', 'person', id, { personId: id });
        });
        // Old page images of the purged rows live on in the WAL until a checkpoint copies the new pages back.
        try {
          ctx.db.checkpoint();
        } catch {
          // a concurrent reader may block the truncate; the next checkpoint (lock/close) completes it
        }
        return { ok: true };
      }),

    scanDuplicates: () =>
      run((): DuplicateScanResult =>
        ctx.tx('persons.scanDuplicates', () => {
          const source = new SqlCandidateSource(ctx.db, ctx.repos);
          const negativePairs = new DbNegativePairs(ctx.repos);
          let pairsFound = 0;
          let created = 0;
          const persons = ctx.repos.persons.getMany(
            idsOf(ctx.db.prepare("SELECT id FROM person WHERE state = 'active' ORDER BY id").all()),
          );
          for (const p of persons) {
            const subject = { ...source.target(p), personId: p.id };
            const cands = rankTargets(subject, generateCandidates(subject, { source }), 'cross-request', {
              negativePairs,
            }).filter((c) => (c.tier === 'T1' || c.tier === 'T2') && c.targetId > p.id);
            for (const c of cands) {
              pairsFound++;
              const open = ctx.repos.reviews
                .openForSubject(p.id)
                .some((r) => r.kind === 'duplicate-persons' && r.subjectIds.includes(c.targetId));
              if (open) continue;
              ctx.repos.reviews.insert({
                kind: 'duplicate-persons',
                subjectIds: [p.id, c.targetId],
                candidates: [c],
                createdAt: ctx.nowIso(),
              });
              created++;
            }
          }
          ctx.audit('review.duplicate-scan', 'review', null, { count: pairsFound, reviewItemsCreated: created });
          return { pairsFound, reviewItemsCreated: created };
        }),
      ),

    suggest: () => notSupported('Person suggestions'),
  };
}

function unitDetail(ctx: Ctx, id: Ulid): UnitDetail {
  const unit = ctx.repos.units.get(id) ?? fail('NOT_FOUND', 'Unit not found');
  return { unit, vettingRecords: ctx.repos.unitVetting.listByUnit(id), personIds: ctx.repos.units.personIds(id) };
}
function unitSummary(ctx: Ctx, u: Unit): UnitSummary {
  return {
    id: u.id,
    name: u.name,
    type: u.type,
    country: u.country,
    personCount: ctx.repos.units.personIds(u.id).length,
    lastVetting: ctx.repos.unitVetting.latestByUnit(u.id),
  };
}

export function createUnitsService(deps: ServiceDeps): UnitsService {
  const ctx = makeCtx(deps);
  return {
    list: (q) =>
      run(() => {
        if (q.text && q.text.trim() !== '') {
          const all = ctx.repos.units
            .getMany(searchIds(ctx.db, 'unit', q.text, 5000))
            .filter((u) => (!q.country || u.country === q.country) && (!q.type || u.type === q.type));
          return {
            items: all.slice(q.offset, q.offset + q.limit).map((u) => unitSummary(ctx, u)),
            total: all.length,
            offset: q.offset,
            limit: q.limit,
          };
        }
        const r = ctx.repos.units.list({
          offset: q.offset,
          limit: q.limit,
          ...(q.country ? { country: q.country } : {}),
          ...(q.type ? { type: q.type } : {}),
        });
        return { items: r.items.map((u) => unitSummary(ctx, u)), total: r.total, offset: q.offset, limit: q.limit };
      }),
    get: ({ id }) => run(() => unitDetail(ctx, id)),
    update: ({ id, patch }) =>
      run(() => {
        ctx.tx('units.update', () => {
          const { aliases: _a, ...fields } = patch;
          void _a;
          ctx.repos.units.update(id, fields);
          ctx.audit('unit.update', 'unit', id, { unitId: id, fields: Object.keys(patch).sort().join(',') });
        });
        return unitDetail(ctx, id);
      }),
    addAlias: ({ id, alias }) =>
      run(() => {
        ctx.tx('units.addAlias', () => {
          ctx.repos.units.addAlias(id, alias);
          ctx.audit('unit.alias', 'unit', id, { unitId: id });
        });
        return unitDetail(ctx, id);
      }),
    merge: ({ survivorId, mergedId }) =>
      run(() => {
        if (survivorId === mergedId) return fail('BAD_REQUEST', 'Cannot merge a unit with itself');
        ctx.tx('units.merge', () => {
          const merged = ctx.repos.units.get(mergedId) ?? fail('NOT_FOUND', 'Unit not found');
          if (!ctx.repos.units.get(survivorId)) return fail('NOT_FOUND', 'Unit not found');
          const persons = ctx.repos.units.personIds(mergedId);
          for (const t of ['request_item', 'vetting_record', 'unit_vetting_record'])
            ctx.db.prepare(`UPDATE ${t} SET unit_id = ? WHERE unit_id = ?`).run(survivorId, mergedId);
          for (const a of [merged.name, ...merged.aliases]) ctx.repos.units.addAlias(survivorId, a);
          ctx.repos.units.delete(mergedId);
          reindexUnit(ctx.db, survivorId);
          for (const p of persons) reindexPerson(ctx.db, p);
          ctx.audit('unit.merge', 'unit', survivorId, { survivorId, mergedId });
        });
        return unitDetail(ctx, survivorId);
      }),
  };
}
