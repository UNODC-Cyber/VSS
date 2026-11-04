import type {
  DcResponse,
  DispClass,
  IsoDate,
  IsoDateTime,
  NameKey,
  RawDate,
  ResponseRow,
  ResponseSection,
  RowMatch,
  Script,
  StoredFile,
  Ulid,
} from '@shared/domain/types';
import { dispClassOfSection } from '@shared/domain/response-section';
import { DbError } from '../errors';
import type { Db } from '../open';
import { reindexResponse } from '../search';
import { StoredFileRepo } from './storedFile';
import { fromJson, newId, toJson } from './util';

export type ResponseHeader = Omit<DcResponse, 'rows'>;
export type ResponseInput = Omit<DcResponse, 'id' | 'rows' | 'sourceFile'> & { sourceFileId: Ulid; id?: Ulid };
/** `dispClass` / `sectionSource` are stored from migration 007 (lane C); until then they derive from the section. */
export type ResponseRowInput = Omit<ResponseRow, 'id' | 'responseId' | 'dispClass' | 'sectionSource'> &
  Partial<Pick<ResponseRow, 'dispClass' | 'sectionSource'>> & {
    coreKey?: string | null;
    /** Links derived from match.chosen + candidate targetKind when omitted. */
    requestItemId?: Ulid | null;
    personId?: Ulid | null;
    id?: Ulid;
  };
export interface RowLinks {
  requestItemId: Ulid | null;
  personId: Ulid | null;
}

interface HeadRow {
  id: string;
  batch_id: string | null;
  post: string | null;
  results_as_of: string | null;
  assistance_line: string | null;
  source_file_id: string | null;
  imported_at: string | null;
  request_id: string | null;
}
interface RowRow {
  id: string;
  response_id: string;
  row_ref: string | null;
  section: string | null;
  disp: string | null;
  name_raw: string | null;
  surname: string | null;
  given_json: string | null;
  core_key: string | null;
  dob: string | null;
  dob_raw: string | null;
  pob_city: string | null;
  pob_state: string | null;
  pob_country: string | null;
  unit_type: string | null;
  unit_name: string | null;
  cert_date: string | null;
  expires: string | null;
  match_json: string | null;
  request_item_id: string | null;
  person_id: string | null;
  detail_json: string | null;
  original_json?: string | null;
}
interface Detail {
  script: Script;
  raw: string;
  nameKey: NameKey;
  dob: RawDate;
  certDate: RawDate;
  expires: RawDate;
  /** Lane K: a disposition set by the reviewer (edit in place / set-disposition); absent = derived. */
  dispClass?: DispClass;
}

/** Stored columns a correction may change (lane K); `original_json` snapshots exactly these. */
const EDIT_COLUMNS = [
  'name_raw',
  'surname',
  'given_json',
  'core_key',
  'dob',
  'dob_raw',
  'pob_city',
  'pob_state',
  'pob_country',
  'unit_name',
  'cert_date',
  'expires',
  'detail_json',
] as const;
/** Raw column values of one row (snapshot / restore unit). */
export type RowColumns = Record<string, string | null>;
/** One recorded correction of a response row (migration 008). `diff` holds personal data: purge clears it. */
export interface RowEdit {
  id: Ulid;
  rowId: Ulid;
  at: IsoDateTime;
  actor: string;
  reason: string;
  diff: Record<string, { from: unknown; to: unknown }>;
}

const columnCache = new WeakMap<Db, boolean>();
/** Lane C's migration 007 adds `response_row.disp_class`; edits keep it in step when it exists. */
function hasDispClassColumn(db: Db): boolean {
  let v = columnCache.get(db);
  if (v === undefined) {
    const cols = db.prepare('PRAGMA table_info(response_row)').all() as { name: string }[];
    v = cols.some((c) => c.name === 'disp_class');
    columnCache.set(db, v);
  }
  return v;
}
const EMPTY_KEY: NameKey = { fullTokens: [], coreTokens: [], particles: [], phonetic: [], folded: '' };
const rawFrom = (parsed: string | null, value: string | null): RawDate => ({
  kind: value ? 'text' : 'empty',
  value: value ?? parsed ?? '',
  parsed,
  ambiguousDayMonth: false,
});
const NO_MATCH: RowMatch = { candidates: [], decision: 'none', chosen: null, decidedBy: null, decidedAt: null };

function deriveLinks(m: RowMatch): RowLinks {
  if (!m.chosen || (m.decision !== 'auto' && m.decision !== 'confirmed'))
    return { requestItemId: null, personId: null };
  const c = m.candidates.find((x) => x.targetId === m.chosen);
  if (c?.targetKind === 'person') return { requestItemId: null, personId: m.chosen };
  return { requestItemId: m.chosen, personId: null };
}

export class ResponseRepo {
  private readonly files: StoredFileRepo;
  constructor(private readonly db: Db) {
    this.files = new StoredFileRepo(db);
  }

  insert(input: ResponseInput, rows: ResponseRowInput[] = []): DcResponse {
    const id = input.id ?? newId();
    this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO response(id, batch_id, post, results_as_of, assistance_line, source_file_id, imported_at, request_id) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          input.batchId,
          input.post,
          input.resultsAsOf,
          input.assistanceLine,
          input.sourceFileId,
          input.importedAt,
          input.requestId,
        );
      for (const r of rows) this.insertRow(id, r);
      reindexResponse(this.db, id);
    });
    return this.get(id)!;
  }

  private insertRow(responseId: Ulid, r: ResponseRowInput): Ulid {
    const id = r.id ?? newId();
    const derived = deriveLinks(r.match);
    const detail: Detail = {
      script: r.name.script,
      raw: r.name.raw,
      nameKey: r.nameKey,
      dob: r.dob,
      certDate: r.certDate,
      expires: r.expires,
    };
    this.db
      .prepare(
        `INSERT INTO response_row(id, response_id, row_ref, section, disp, name_raw, surname, given_json, core_key, dob, dob_raw,
           pob_city, pob_state, pob_country, unit_type, unit_name, cert_date, expires, match_json, request_item_id, person_id, detail_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        responseId,
        r.rowRef,
        r.section,
        r.disp,
        r.nameRaw,
        r.name.surname,
        toJson(r.name.given),
        r.coreKey ?? (r.nameKey.coreTokens.join(' ') || null),
        r.dob.parsed,
        r.dob.value,
        r.pob.city,
        r.pob.state,
        r.pob.country,
        r.unitType,
        r.unitName,
        r.certDate.parsed,
        r.expires.parsed,
        toJson(r.match),
        r.requestItemId !== undefined ? r.requestItemId : derived.requestItemId,
        r.personId !== undefined ? r.personId : derived.personId,
        toJson(detail),
      );
    return id;
  }

  get(id: Ulid): DcResponse | null {
    const h = this.getHeader(id);
    return h ? { ...h, rows: this.listRows(id) } : null;
  }
  getHeader(id: Ulid): ResponseHeader | null {
    const r = this.db.prepare('SELECT * FROM response WHERE id = ?').get(id) as HeadRow | undefined;
    return r ? this.mapHead(r) : null;
  }
  list(q: { offset: number; limit: number; requestId?: Ulid; ids?: Ulid[] }): {
    items: ResponseHeader[];
    total: number;
  } {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (q.requestId) {
      where.push('request_id = ?');
      vals.push(q.requestId);
    }
    if (q.ids) {
      if (q.ids.length === 0) return { items: [], total: 0 };
      where.push('id IN (SELECT value FROM json_each(?))');
      vals.push(toJson(q.ids));
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT count(*) AS n FROM response ${w}`).get(...vals) as { n: number }).n;
    const rows = this.db
      .prepare(`SELECT * FROM response ${w} ORDER BY imported_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...vals, q.limit, q.offset) as HeadRow[];
    return { items: rows.map((r) => this.mapHead(r)), total };
  }
  listByRequest(requestId: Ulid): ResponseHeader[] {
    return (
      this.db
        .prepare('SELECT * FROM response WHERE request_id = ? ORDER BY imported_at, id')
        .all(requestId) as HeadRow[]
    ).map((r) => this.mapHead(r));
  }
  findBySourceSha256(sha: string): ResponseHeader[] {
    return (
      this.db
        .prepare(
          'SELECT r.* FROM response r JOIN stored_file f ON f.id = r.source_file_id WHERE f.sha256 = ? ORDER BY r.id',
        )
        .all(sha) as HeadRow[]
    ).map((r) => this.mapHead(r));
  }

  listRows(responseId: Ulid): ResponseRow[] {
    return (
      this.db.prepare('SELECT * FROM response_row WHERE response_id = ? ORDER BY id').all(responseId) as RowRow[]
    ).map(mapRow);
  }
  getRow(id: Ulid): ResponseRow | null {
    const r = this.db.prepare('SELECT * FROM response_row WHERE id = ?').get(id) as RowRow | undefined;
    return r ? mapRow(r) : null;
  }
  rowLinks(id: Ulid): RowLinks | null {
    const r = this.db.prepare('SELECT request_item_id, person_id FROM response_row WHERE id = ?').get(id) as
      { request_item_id: string | null; person_id: string | null } | undefined;
    return r ? { requestItemId: r.request_item_id, personId: r.person_id } : null;
  }
  rowsByRequestItem(itemId: Ulid): ResponseRow[] {
    return (
      this.db.prepare('SELECT * FROM response_row WHERE request_item_id = ? ORDER BY id').all(itemId) as RowRow[]
    ).map(mapRow);
  }
  rowsByPerson(personId: Ulid): ResponseRow[] {
    return (
      this.db.prepare('SELECT * FROM response_row WHERE person_id = ? ORDER BY id').all(personId) as RowRow[]
    ).map(mapRow);
  }
  /** Rows still needing a decision ('pending' or 'none'). */
  unresolvedRows(responseId: Ulid): ResponseRow[] {
    return this.listRows(responseId).filter((r) => r.match.decision === 'pending' || r.match.decision === 'none');
  }

  setRowMatch(rowId: Ulid, match: RowMatch, links?: Partial<RowLinks>): ResponseRow {
    const d = deriveLinks(match);
    const r = this.db
      .prepare('UPDATE response_row SET match_json = ?, request_item_id = ?, person_id = ? WHERE id = ?')
      .run(
        toJson(match),
        links?.requestItemId !== undefined ? links.requestItemId : d.requestItemId,
        links?.personId !== undefined ? links.personId : d.personId,
        rowId,
      );
    if (r.changes === 0) throw new DbError('NOT_FOUND', 'response row not found');
    return this.getRow(rowId)!;
  }

  setRequest(id: Ulid, requestId: Ulid | null): void {
    this.db.prepare('UPDATE response SET request_id = ? WHERE id = ?').run(requestId, id);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Lane K: corrections in place (migration 008). The DC original is snapshotted on the first edit only.
  // -------------------------------------------------------------------------------------------------------------

  private editColumns(): readonly string[] {
    return hasDispClassColumn(this.db) ? [...EDIT_COLUMNS, 'disp_class'] : EDIT_COLUMNS;
  }
  private readColumns(id: Ulid): RowColumns | null {
    const cols = this.editColumns();
    const r = this.db.prepare(`SELECT ${cols.join(', ')} FROM response_row WHERE id = ?`).get(id) as
      RowColumns | undefined;
    return r ? { ...r } : null;
  }
  private writeColumns(id: Ulid, cols: RowColumns): void {
    const names = this.editColumns().filter((c) => c in cols);
    this.db
      .prepare(`UPDATE response_row SET ${names.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`)
      .run({ ...Object.fromEntries(names.map((c) => [c, cols[c] ?? null])), id });
  }

  /** The row as the DC file stated it (null when it was never corrected). */
  originalRow(id: Ulid): ResponseRow | null {
    const r = this.db.prepare('SELECT * FROM response_row WHERE id = ?').get(id) as RowRow | undefined;
    if (!r?.original_json) return null;
    const orig = fromJson<RowColumns>(r.original_json, {});
    return mapRow({ ...r, ...orig } as RowRow);
  }
  isEdited(id: Ulid): boolean {
    const r = this.db.prepare('SELECT original_json FROM response_row WHERE id = ?').get(id) as
      { original_json: string | null } | undefined;
    return !!r?.original_json;
  }

  /**
   * Replace the correctable fields of a row with those of `next` (name, name key, DOB, POB, unit name, cert / expiry
   * dates, disposition). The first correction snapshots the stored columns into `original_json`. Re-indexes the
   * response search blob. Links and match are NOT touched (the service decides).
   */
  correctRow(id: Ulid, next: ResponseRow): ResponseRow {
    const before = this.readColumns(id);
    if (!before) throw new DbError('NOT_FOUND', 'response row not found');
    const head = this.db
      .prepare('SELECT response_id, original_json, section FROM response_row WHERE id = ?')
      .get(id) as {
      response_id: string;
      original_json: string | null;
      section: string | null;
    };
    if (!head.original_json)
      this.db.prepare('UPDATE response_row SET original_json = ? WHERE id = ?').run(toJson(before), id);
    const derived = dispClassOfSection((head.section ?? 'approved-individual') as ResponseSection);
    const detail: Detail = {
      script: next.name.script,
      raw: next.name.raw,
      nameKey: next.nameKey,
      dob: next.dob,
      certDate: next.certDate,
      expires: next.expires,
      ...(next.dispClass !== derived ? { dispClass: next.dispClass } : {}),
    };
    const cols: RowColumns = {
      name_raw: next.nameRaw,
      surname: next.name.surname,
      given_json: toJson(next.name.given),
      core_key: next.nameKey.coreTokens.join(' ') || null,
      dob: next.dob.parsed,
      dob_raw: next.dob.value,
      pob_city: next.pob.city,
      pob_state: next.pob.state,
      pob_country: next.pob.country,
      unit_name: next.unitName,
      cert_date: next.certDate.parsed,
      expires: next.expires.parsed,
      detail_json: toJson(detail),
    };
    if (hasDispClassColumn(this.db)) cols.disp_class = next.dispClass;
    this.writeColumns(id, cols);
    reindexResponse(this.db, head.response_id);
    return this.getRow(id)!;
  }

  /** Restore the DC original byte for byte and forget the snapshot. False when the row was never corrected. */
  restoreOriginal(id: Ulid): boolean {
    const r = this.db.prepare('SELECT response_id, original_json FROM response_row WHERE id = ?').get(id) as
      { response_id: string; original_json: string | null } | undefined;
    if (!r?.original_json) return false;
    this.writeColumns(id, fromJson<RowColumns>(r.original_json, {}));
    this.db.prepare('UPDATE response_row SET original_json = NULL WHERE id = ?').run(id);
    reindexResponse(this.db, r.response_id);
    return true;
  }

  addEdit(e: Omit<RowEdit, 'id'>): RowEdit {
    const id = newId();
    this.db
      .prepare('INSERT INTO response_row_edit(id, row_id, at, actor, reason, diff_json) VALUES (?,?,?,?,?,?)')
      .run(id, e.rowId, e.at, e.actor, e.reason, toJson(e.diff));
    return { id, ...e };
  }
  listEdits(rowId: Ulid): RowEdit[] {
    return (
      this.db.prepare('SELECT * FROM response_row_edit WHERE row_id = ? ORDER BY at, id').all(rowId) as {
        id: string;
        row_id: string;
        at: string;
        actor: string;
        reason: string;
        diff_json: string;
      }[]
    ).map((r) => ({
      id: r.id,
      rowId: r.row_id,
      at: r.at,
      actor: r.actor,
      reason: r.reason,
      diff: fromJson<RowEdit['diff']>(r.diff_json, {}),
    }));
  }

  /** Delete a response, its rows and search blob (records created from it are the caller's concern). */
  delete(id: Ulid): void {
    this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM response_row_edit WHERE row_id IN (SELECT id FROM response_row WHERE response_id = ?)')
        .run(id);
      this.db.prepare('DELETE FROM response_row WHERE response_id = ?').run(id);
      this.db.prepare('DELETE FROM response WHERE id = ?').run(id);
      reindexResponse(this.db, id);
    });
  }

  private mapHead(r: HeadRow): ResponseHeader {
    const sf: StoredFile | null = r.source_file_id ? this.files.get(r.source_file_id) : null;
    return {
      id: r.id,
      batchId: r.batch_id ?? '',
      post: r.post ?? '',
      resultsAsOf: (r.results_as_of ?? '') as IsoDate,
      assistanceLine: r.assistance_line ?? '',
      sourceFile: sf ?? {
        id: r.source_file_id ?? '',
        originalName: '',
        sha256: '',
        bytes: 0,
        storedAt: '' as IsoDateTime,
      },
      importedAt: r.imported_at ?? '',
      requestId: r.request_id,
    };
  }
}

function mapRow(r: RowRow): ResponseRow {
  const d = fromJson<Partial<Detail>>(r.detail_json, {});
  return {
    id: r.id,
    responseId: r.response_id,
    rowRef: r.row_ref ?? '',
    section: (r.section ?? 'approved-individual') as ResponseSection,
    disp: r.disp ?? '',
    nameRaw: r.name_raw ?? '',
    name: {
      surname: r.surname ?? '',
      given: fromJson<string[]>(r.given_json, []),
      raw: d.raw ?? r.name_raw ?? '',
      script: d.script ?? 'Other',
    },
    nameKey: d.nameKey ?? EMPTY_KEY,
    dob: d.dob ?? rawFrom(r.dob, r.dob_raw),
    pob: { city: r.pob_city, state: r.pob_state, country: r.pob_country },
    unitType: r.unit_type ?? '',
    unitName: r.unit_name ?? '',
    certDate: d.certDate ?? rawFrom(r.cert_date, null),
    expires: d.expires ?? rawFrom(r.expires, null),
    match: fromJson<RowMatch>(r.match_json, NO_MATCH),
    dispClass: d.dispClass ?? dispClassOfSection((r.section ?? 'approved-individual') as ResponseSection),
    sectionSource: 'label',
  };
}
