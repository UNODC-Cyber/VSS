import type {
  ExportDecision,
  IsoDate,
  IsoDateTime,
  LinkState,
  NameKey,
  ObservedPerson,
  ObservedUnit,
  RequestItem,
  RequestStatus,
  Requestor,
  StoredFile,
  Ulid,
  ValidationIssue,
  VettingRequest,
  VettingStatusSnapshot,
} from '@shared/domain/types';
import type { SortDirection } from '@shared/ipc/contract';
import { DbError } from '../errors';
import type { Db } from '../open';
import { reindexPerson, reindexRequest } from '../search';
import { StoredFileRepo } from './storedFile';
import { chunked, fromJson, newId, qs, toJson } from './util';

export type RequestHeader = Omit<VettingRequest, 'items'>;
/** Lifecycle fields (lane D, migration 006); until then they are not stored and read as their defaults. */
export type RequestLifecycleField = 'finishedAt' | 'closedAt' | 'closeNote' | 'reopenCount';
export type RequestInput = Omit<VettingRequest, 'id' | 'items' | 'sourceFile' | RequestLifecycleField> &
  Partial<Pick<VettingRequest, RequestLifecycleField>> & {
    sourceFileId?: Ulid | null;
    id?: Ulid;
  };
export interface RequestPatchFields {
  requestor?: Requestor;
  eventName?: string;
  eventStart?: IsoDate | null;
  eventEnd?: IsoDate | null;
  eventLocation?: string | null;
  batchId?: string | null;
  notes?: string;
  units?: ObservedUnit[];
  templateVersion?: string | null;
  respondedAt?: IsoDateTime | null;
  responseKind?: VettingRequest['responseKind'];
  sentToDcAt?: IsoDateTime | null;
}
export interface RequestListFilter {
  offset: number;
  limit: number;
  statuses?: RequestStatus[];
  /** receivedAt date range, inclusive (YYYY-MM-DD). */
  from?: IsoDate;
  to?: IsoDate;
  /** Awaiting a response: status exported|sent-to-dc and respondedAt null. */
  outstandingOnly?: boolean;
  /** Restrict to these ids (e.g. from searchIds). */
  ids?: Ulid[];
  sort?: 'receivedAt' | 'sentToDcAt' | 'eventStart' | 'agingDays';
  direction?: SortDirection;
}
export interface RequestItemStats {
  itemCount: number;
  errorCount: number;
  /** Items with at least one error or warning issue. */
  openIssueCount: number;
  unresolvedLinkCount: number;
  /** Items referenced by at least one response row. */
  answeredCount: number;
}
export interface ResponseTiming {
  requestId: Ulid;
  sentToDcAt: IsoDateTime;
  respondedAt: IsoDateTime;
}
export type RequestItemInput = Omit<RequestItem, 'id' | 'requestId'> & { coreKey?: string | null; id?: Ulid };
export interface RequestItemPatch {
  personId?: Ulid | null;
  linkState?: LinkState;
  unitId?: Ulid | null;
  issues?: ValidationIssue[];
  prior?: VettingStatusSnapshot | null;
  exportDecision?: ExportDecision;
  exportReason?: string;
  nameKey?: NameKey;
  coreKey?: string | null;
}

interface ReqRow {
  id: string;
  kind: string;
  received_at: string;
  requestor_name: string | null;
  requestor_email: string | null;
  requestor_org: string | null;
  event_name: string | null;
  event_start: string | null;
  event_end: string | null;
  event_location: string | null;
  source_file_id: string | null;
  template_version: string | null;
  units_json: string | null;
  status: string;
  sent_to_dc_at: string | null;
  responded_at: string | null;
  response_kind: string | null;
  batch_id: string | null;
  notes: string | null;
}
interface ItemRow {
  id: string;
  request_id: string;
  row_ref: string | null;
  observed_json: string;
  core_key: string | null;
  person_id: string | null;
  link_state: string | null;
  unit_id: string | null;
  issues_json: string | null;
  prior_json: string | null;
  export_decision: string | null;
  export_reason: string | null;
  name_key_json: string | null;
}

const EMPTY_KEY: NameKey = { fullTokens: [], coreTokens: [], particles: [], phonetic: [], folded: '' };
const OUTSTANDING = "status IN ('exported','sent-to-dc') AND responded_at IS NULL";

function mapItem(r: ItemRow): RequestItem {
  return {
    id: r.id,
    requestId: r.request_id,
    observed: JSON.parse(r.observed_json) as ObservedPerson,
    nameKey: fromJson<NameKey>(r.name_key_json, EMPTY_KEY),
    personId: r.person_id,
    linkState: (r.link_state ?? 'unlinked') as LinkState,
    unitId: r.unit_id,
    issues: fromJson<ValidationIssue[]>(r.issues_json, []),
    prior: fromJson<VettingStatusSnapshot | null>(r.prior_json, null),
    exportDecision: (r.export_decision ?? 'include') as ExportDecision,
    exportReason: r.export_reason ?? '',
  };
}

export class RequestRepo {
  private readonly files: StoredFileRepo;
  constructor(private readonly db: Db) {
    this.files = new StoredFileRepo(db);
  }

  insert(input: RequestInput, items: RequestItemInput[] = []): VettingRequest {
    const id = input.id ?? newId();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO request(id, kind, received_at, requestor_name, requestor_email, requestor_org, event_name, event_start, event_end,
             event_location, source_file_id, template_version, units_json, status, sent_to_dc_at, responded_at, response_kind, batch_id, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.kind,
          input.receivedAt,
          input.requestor.name,
          input.requestor.email,
          input.requestor.organisation,
          input.eventName,
          input.eventStart,
          input.eventEnd,
          input.eventLocation,
          input.sourceFileId ?? null,
          input.templateVersion,
          toJson(input.units),
          input.status,
          input.sentToDcAt,
          input.respondedAt,
          input.responseKind,
          input.batchId,
          input.notes,
        );
      for (const it of items) this.insertItemRow(id, it);
      reindexRequest(this.db, id);
      for (const pid of new Set(items.map((i) => i.personId).filter((p): p is string => !!p)))
        reindexPerson(this.db, pid);
    });
    return this.get(id)!;
  }

  private insertItemRow(requestId: Ulid, it: RequestItemInput): Ulid {
    const id = it.id ?? newId();
    this.db
      .prepare(
        `INSERT INTO request_item(id, request_id, row_ref, observed_json, core_key, person_id, link_state, unit_id, issues_json, prior_json,
           export_decision, export_reason, name_key_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        requestId,
        it.observed.rowRef,
        toJson(it.observed),
        it.coreKey ?? (it.nameKey.coreTokens.join(' ') || null),
        it.personId,
        it.linkState,
        it.unitId,
        toJson(it.issues),
        it.prior === null ? null : toJson(it.prior),
        it.exportDecision,
        it.exportReason,
        toJson(it.nameKey),
      );
    return id;
  }

  addItems(requestId: Ulid, items: RequestItemInput[]): RequestItem[] {
    return this.db.transaction(() => {
      if (!this.exists(requestId)) throw new DbError('NOT_FOUND', 'request not found');
      const ids = items.map((it) => this.insertItemRow(requestId, it));
      reindexRequest(this.db, requestId);
      for (const pid of new Set(items.map((i) => i.personId).filter((p): p is string => !!p)))
        reindexPerson(this.db, pid);
      return this.getItems(ids);
    });
  }

  exists(id: Ulid): boolean {
    return !!this.db.prepare('SELECT 1 AS x FROM request WHERE id = ?').get(id);
  }

  get(id: Ulid): VettingRequest | null {
    const h = this.getHeader(id);
    return h ? { ...h, items: this.listItems(id) } : null;
  }

  getHeader(id: Ulid): RequestHeader | null {
    const r = this.db.prepare('SELECT * FROM request WHERE id = ?').get(id) as ReqRow | undefined;
    return r ? this.mapHeader(r) : null;
  }

  update(id: Ulid, patch: RequestPatchFields): RequestHeader {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const set = (c: string, v: unknown) => {
      sets.push(`${c} = ?`);
      vals.push(v);
    };
    if (patch.requestor) {
      set('requestor_name', patch.requestor.name);
      set('requestor_email', patch.requestor.email);
      set('requestor_org', patch.requestor.organisation);
    }
    if (patch.eventName !== undefined) set('event_name', patch.eventName);
    if (patch.eventStart !== undefined) set('event_start', patch.eventStart);
    if (patch.eventEnd !== undefined) set('event_end', patch.eventEnd);
    if (patch.eventLocation !== undefined) set('event_location', patch.eventLocation);
    if (patch.batchId !== undefined) set('batch_id', patch.batchId);
    if (patch.notes !== undefined) set('notes', patch.notes);
    if (patch.units !== undefined) set('units_json', toJson(patch.units));
    if (patch.templateVersion !== undefined) set('template_version', patch.templateVersion);
    if (patch.respondedAt !== undefined) set('responded_at', patch.respondedAt);
    if (patch.responseKind !== undefined) set('response_kind', patch.responseKind);
    if (patch.sentToDcAt !== undefined) set('sent_to_dc_at', patch.sentToDcAt);
    this.db.transaction(() => {
      if (sets.length > 0) {
        const r = this.db.prepare(`UPDATE request SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
        if (r.changes === 0) throw new DbError('NOT_FOUND', 'request not found');
      }
      reindexRequest(this.db, id);
    });
    return this.getHeader(id)!;
  }

  /** Status change; 'sent-to-dc' stamps sentToDcAt (default now), 'responded' stamps respondedAt when unset. */
  setStatus(id: Ulid, status: RequestStatus, at: IsoDateTime = new Date().toISOString()): RequestHeader {
    this.db.transaction(() => {
      const r = this.db.prepare('UPDATE request SET status = ? WHERE id = ?').run(status, id);
      if (r.changes === 0) throw new DbError('NOT_FOUND', 'request not found');
      if (status === 'sent-to-dc') this.db.prepare('UPDATE request SET sent_to_dc_at = ? WHERE id = ?').run(at, id);
      if (status === 'responded')
        this.db.prepare('UPDATE request SET responded_at = coalesce(responded_at, ?) WHERE id = ?').run(at, id);
    });
    return this.getHeader(id)!;
  }

  list(q: RequestListFilter): { items: RequestHeader[]; total: number } {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (q.statuses?.length) {
      where.push(`status IN (${qs(q.statuses.length)})`);
      vals.push(...q.statuses);
    }
    if (q.from) {
      where.push('substr(received_at, 1, 10) >= ?');
      vals.push(q.from);
    }
    if (q.to) {
      where.push('substr(received_at, 1, 10) <= ?');
      vals.push(q.to);
    }
    if (q.outstandingOnly) where.push(OUTSTANDING);
    if (q.ids) {
      if (q.ids.length === 0) return { items: [], total: 0 };
      where.push(`id IN (SELECT value FROM json_each(?))`);
      vals.push(toJson(q.ids));
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const dir = (q.direction ?? 'desc') === 'asc' ? 'ASC' : 'DESC';
    const col =
      q.sort === 'sentToDcAt'
        ? `sent_to_dc_at ${dir}`
        : q.sort === 'eventStart'
          ? `event_start ${dir}`
          : q.sort === 'agingDays'
            ? `sent_to_dc_at ${dir === 'ASC' ? 'DESC' : 'ASC'}` // older send => more aging days
            : `received_at ${dir}`;
    const total = (this.db.prepare(`SELECT count(*) AS n FROM request ${w}`).get(...vals) as { n: number }).n;
    const rows = this.db
      .prepare(`SELECT * FROM request ${w} ORDER BY ${col}, id LIMIT ? OFFSET ?`)
      .all(...vals, q.limit, q.offset) as ReqRow[];
    return { items: rows.map((r) => this.mapHeader(r)), total };
  }

  /** Requests awaiting a DC response (exported or sent, no respondedAt), oldest send first. */
  outstanding(opts: { sentOnly?: boolean } = {}): RequestHeader[] {
    const extra = opts.sentOnly ? ' AND sent_to_dc_at IS NOT NULL' : '';
    return (
      this.db.prepare(`SELECT * FROM request WHERE ${OUTSTANDING}${extra} ORDER BY sent_to_dc_at, id`).all() as ReqRow[]
    ).map((r) => this.mapHeader(r));
  }

  /** Requests holding a source file with this sha256 (duplicate import check). */
  findBySourceSha256(sha: string): RequestHeader[] {
    return (
      this.db
        .prepare(
          'SELECT r.* FROM request r JOIN stored_file f ON f.id = r.source_file_id WHERE f.sha256 = ? ORDER BY r.id',
        )
        .all(sha) as ReqRow[]
    ).map((r) => this.mapHeader(r));
  }

  /** Answered requests with both timestamps (turnaround statistics); `since` filters on respondedAt. */
  responseTimings(since?: IsoDateTime): ResponseTiming[] {
    const rows = this.db
      .prepare(
        `SELECT id, sent_to_dc_at, responded_at FROM request WHERE sent_to_dc_at IS NOT NULL AND responded_at IS NOT NULL
         ${since ? 'AND responded_at >= ?' : ''} ORDER BY responded_at`,
      )
      .all(...(since ? [since] : [])) as { id: string; sent_to_dc_at: string; responded_at: string }[];
    return rows.map((r) => ({ requestId: r.id, sentToDcAt: r.sent_to_dc_at, respondedAt: r.responded_at }));
  }

  /** Per-request item counters for RequestSummary. */
  itemStats(requestIds: readonly Ulid[]): Map<Ulid, RequestItemStats> {
    const out = new Map<Ulid, RequestItemStats>();
    for (const id of requestIds)
      out.set(id, { itemCount: 0, errorCount: 0, openIssueCount: 0, unresolvedLinkCount: 0, answeredCount: 0 });
    chunked(requestIds, (c) => {
      const rows = this.db
        .prepare(
          `SELECT ri.request_id AS rid,
             count(*) AS items,
             sum(EXISTS(SELECT 1 FROM json_each(ri.issues_json) j WHERE json_extract(j.value, '$.severity') = 'error')) AS errs,
             sum(EXISTS(SELECT 1 FROM json_each(ri.issues_json) j WHERE json_extract(j.value, '$.severity') IN ('error','warning'))) AS open,
             sum(coalesce(ri.link_state, 'unlinked') IN ('pending-review','unlinked')) AS unresolved,
             sum(EXISTS(SELECT 1 FROM response_row rr WHERE rr.request_item_id = ri.id)) AS answered
           FROM request_item ri WHERE ri.request_id IN (${qs(c.length)}) GROUP BY ri.request_id`,
        )
        .all(...c) as {
        rid: string;
        items: number;
        errs: number;
        open: number;
        unresolved: number;
        answered: number;
      }[];
      for (const r of rows)
        out.set(r.rid, {
          itemCount: r.items,
          errorCount: r.errs,
          openIssueCount: r.open,
          unresolvedLinkCount: r.unresolved,
          answeredCount: r.answered,
        });
      return [];
    });
    return out;
  }

  // ---- items ----

  listItems(requestId: Ulid): RequestItem[] {
    return (
      this.db.prepare('SELECT * FROM request_item WHERE request_id = ? ORDER BY id').all(requestId) as ItemRow[]
    ).map(mapItem);
  }
  getItem(id: Ulid): RequestItem | null {
    const r = this.db.prepare('SELECT * FROM request_item WHERE id = ?').get(id) as ItemRow | undefined;
    return r ? mapItem(r) : null;
  }
  getItems(ids: readonly Ulid[]): RequestItem[] {
    return chunked(ids, (c) =>
      (
        this.db.prepare(`SELECT * FROM request_item WHERE id IN (${qs(c.length)}) ORDER BY id`).all(...c) as ItemRow[]
      ).map(mapItem),
    );
  }
  itemsByPerson(personId: Ulid): RequestItem[] {
    return (
      this.db.prepare('SELECT * FROM request_item WHERE person_id = ? ORDER BY id').all(personId) as ItemRow[]
    ).map(mapItem);
  }
  itemsByCoreKey(coreKey: string): RequestItem[] {
    return (this.db.prepare('SELECT * FROM request_item WHERE core_key = ? ORDER BY id').all(coreKey) as ItemRow[]).map(
      mapItem,
    );
  }
  /** Request ids a person appears on. */
  requestIdsForPerson(personId: Ulid): Ulid[] {
    return (
      this.db.prepare('SELECT DISTINCT request_id FROM request_item WHERE person_id = ?').all(personId) as {
        request_id: string;
      }[]
    ).map((r) => r.request_id);
  }
  /** Persons on a request still awaiting a response (drives 'pending' status). */
  pendingPersonIds(): Set<Ulid> {
    return new Set(
      (
        this.db
          .prepare(
            `SELECT DISTINCT ri.person_id FROM request_item ri JOIN request r ON r.id = ri.request_id
                    WHERE ri.person_id IS NOT NULL AND r.status IN ('exported','sent-to-dc') AND r.responded_at IS NULL`,
          )
          .all() as { person_id: string }[]
      ).map((r) => r.person_id),
    );
  }

  updateItem(id: Ulid, patch: RequestItemPatch): RequestItem {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const set = (c: string, v: unknown) => {
      sets.push(`${c} = ?`);
      vals.push(v);
    };
    if (patch.personId !== undefined) set('person_id', patch.personId);
    if (patch.linkState !== undefined) set('link_state', patch.linkState);
    if (patch.unitId !== undefined) set('unit_id', patch.unitId);
    if (patch.issues !== undefined) set('issues_json', toJson(patch.issues));
    if (patch.prior !== undefined) set('prior_json', patch.prior === null ? null : toJson(patch.prior));
    if (patch.exportDecision !== undefined) set('export_decision', patch.exportDecision);
    if (patch.exportReason !== undefined) set('export_reason', patch.exportReason);
    if (patch.nameKey !== undefined) set('name_key_json', toJson(patch.nameKey));
    if (patch.coreKey !== undefined) set('core_key', patch.coreKey);
    return this.db.transaction(() => {
      const before = this.getItem(id);
      if (!before) throw new DbError('NOT_FOUND', 'request item not found');
      if (sets.length > 0) this.db.prepare(`UPDATE request_item SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
      if (patch.personId !== undefined || patch.unitId !== undefined) {
        const after = this.getItem(id)!;
        for (const pid of new Set([before.personId, after.personId])) if (pid) reindexPerson(this.db, pid);
      }
      return this.getItem(id)!;
    });
  }

  private mapHeader(r: ReqRow): RequestHeader {
    const sourceFile: StoredFile | null = r.source_file_id ? this.files.get(r.source_file_id) : null;
    return {
      id: r.id,
      kind: r.kind as VettingRequest['kind'],
      receivedAt: r.received_at,
      requestor: { name: r.requestor_name ?? '', email: r.requestor_email, organisation: r.requestor_org },
      eventName: r.event_name ?? '',
      eventStart: r.event_start,
      eventEnd: r.event_end,
      eventLocation: r.event_location,
      sourceFile,
      templateVersion: r.template_version,
      units: fromJson<ObservedUnit[]>(r.units_json, []),
      status: r.status as RequestStatus,
      sentToDcAt: r.sent_to_dc_at,
      respondedAt: r.responded_at,
      responseKind: r.response_kind as VettingRequest['responseKind'],
      batchId: r.batch_id,
      notes: r.notes ?? '',
      finishedAt: null,
      closedAt: null,
      closeNote: '',
      reopenCount: 0,
    };
  }
}
