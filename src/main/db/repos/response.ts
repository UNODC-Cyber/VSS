import type {
  DcResponse,
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
}
interface Detail {
  script: Script;
  raw: string;
  nameKey: NameKey;
  dob: RawDate;
  certDate: RawDate;
  expires: RawDate;
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

  /** Delete a response, its rows and search blob (records created from it are the caller's concern). */
  delete(id: Ulid): void {
    this.db.transaction(() => {
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
    dispClass: dispClassOfSection((r.section ?? 'approved-individual') as ResponseSection),
    sectionSource: 'label',
  };
}
