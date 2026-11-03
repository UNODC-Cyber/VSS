/**
 * FTS5 (trigram) search. Blobs are built here from the stored rows and maintained explicitly by the repositories on
 * every write (no SQL triggers). Folding is one swappable function so the names lane (WP-11) can plug in its
 * normaliser without touching the index code; after swapping, call `rebuildAllSearch(db)`.
 */
import { createHash } from 'node:crypto';
import type { IsoDate, ObservedPerson, ObservedUnit, Ulid } from '@shared/domain/types';
import type { Db } from './open';

// ---------------------------------------------------------------------------------------------------------------
// Folding
// ---------------------------------------------------------------------------------------------------------------

export type SearchFolder = (text: string) => string;

/**
 * Code-point ranges removed after NFD: Latin/Greek/Cyrillic combining diacritics (U+0300-036F, 1AB0-1AFF, 1DC0-1DFF,
 * 20D0-20FF, FE20-FE2F) and the Thai tone marks mai ek..mai chattawa (U+0E48-0E4B). Thai/Khmer/Lao/Myanmar vowel signs
 * are also Mn but are KEPT (stripping them would merge distinct names).
 */
const STRIP_RANGES: readonly [number, number][] = [
  [0x0300, 0x036f],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x20d0, 0x20ff],
  [0xfe20, 0xfe2f],
  [0x0e48, 0x0e4b],
];
const stripped = (cp: number): boolean => STRIP_RANGES.some(([a, b]) => cp >= a && cp <= b);
/** Letters with no canonical decomposition (sharp s, d with stroke, eth, o slash, l stroke, ligatures, dotless i, thorn, final sigma). */
const SPECIAL = new Map<number, string>([
  [0x00df, 'ss'],
  [0x0111, 'd'],
  [0x00f0, 'd'],
  [0x00f8, 'o'],
  [0x0142, 'l'],
  [0x00e6, 'ae'],
  [0x0153, 'oe'],
  [0x0131, 'i'],
  [0x00fe, 'th'],
  [0x03c2, String.fromCodePoint(0x03c3)],
]);

/** Default fold: NFKC, casefold, strip combining marks, strip Thai tone marks, collapse whitespace. */
export function defaultFoldForSearch(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFKC').toLowerCase().normalize('NFD')) {
    const cp = ch.codePointAt(0)!;
    if (stripped(cp)) continue;
    out += SPECIAL.get(cp) ?? ch;
  }
  return out.normalize('NFC').replace(/\s+/g, ' ').trim();
}

let folder: SearchFolder = defaultFoldForSearch;

export function foldForSearch(text: string): string {
  return folder(text);
}
/** Swap the folding function (null restores the default). Existing blobs must then be rebuilt. */
export function setSearchFolder(f: SearchFolder | null): void {
  folder = f ?? defaultFoldForSearch;
}

/** DOB in the three formats users type: YYYY-MM-DD, DD/MM/YYYY, MM/DD/YYYY. */
export function dobVariants(dob: IsoDate | null | undefined): string[] {
  if (!dob) return [];
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
  if (!m) return [dob];
  const [, y, mo, d] = m;
  return [`${y}-${mo}-${d}`, `${d}/${mo}/${y}`, `${mo}/${d}/${y}`];
}

function blobOf(parts: (string | null | undefined)[]): string {
  return foldForSearch(parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '').join(' | '));
}

// ---------------------------------------------------------------------------------------------------------------
// Blob builders (pure)
// ---------------------------------------------------------------------------------------------------------------

export interface PersonBlobInput {
  surname: string | null;
  given: string[];
  raw: string | null;
  aliases: { surname: string | null; given: string[]; raw: string | null }[];
  identifiers: { value: string | null; valueFolded: string | null }[];
  dob: IsoDate | null;
  nationality: string | null;
  pob: { city: string | null; state: string | null; country: string | null };
  unitNames: string[];
}
export function buildPersonBlob(p: PersonBlobInput): string {
  return blobOf([
    p.surname,
    p.given.join(' '),
    p.raw,
    ...p.aliases.flatMap((a) => [a.surname, a.given.join(' '), a.raw]),
    ...p.identifiers.flatMap((i) => [i.value, i.valueFolded]),
    ...dobVariants(p.dob),
    p.nationality,
    p.pob.city,
    p.pob.state,
    p.pob.country,
    ...p.unitNames,
  ]);
}

export interface UnitBlobInput {
  name: string;
  aliases: string[];
  unitIdNo: string | null;
  alias: string | null;
  location: string | null;
  country: string | null;
  englishDescription: string | null;
  branchName: string | null;
  parentOrg: string | null;
}
export function buildUnitBlob(u: UnitBlobInput): string {
  return blobOf([
    u.name,
    ...u.aliases,
    u.unitIdNo,
    u.alias,
    u.location,
    u.country,
    u.englishDescription,
    u.branchName,
    u.parentOrg,
  ]);
}

export interface RequestBlobInput {
  eventName: string | null;
  eventLocation: string | null;
  requestorName: string | null;
  requestorEmail: string | null;
  requestorOrg: string | null;
  batchId: string | null;
  units: Pick<ObservedUnit, 'name' | 'alias'>[];
  items: Pick<ObservedPerson, 'surname' | 'name1' | 'name2' | 'name3' | 'name4' | 'unitName'>[];
}
export function buildRequestBlob(r: RequestBlobInput): string {
  return blobOf([
    r.eventName,
    r.eventLocation,
    r.requestorName,
    r.requestorEmail,
    r.requestorOrg,
    r.batchId,
    ...r.units.flatMap((u) => [u.name, u.alias]),
    ...r.items.map((i) => [i.surname, i.name1, i.name2, i.name3, i.name4].filter(Boolean).join(' ')),
  ]);
}

export interface ResponseBlobInput {
  batchId: string | null;
  post: string | null;
  assistanceLine: string | null;
  rows: { nameRaw: string | null; unitName: string | null; dob: IsoDate | null }[];
}
export function buildResponseBlob(r: ResponseBlobInput): string {
  return blobOf([
    r.batchId,
    r.post,
    r.assistanceLine,
    ...r.rows.flatMap((x) => [x.nameRaw, x.unitName, ...dobVariants(x.dob)]),
  ]);
}

// ---------------------------------------------------------------------------------------------------------------
// Index maintenance (called by the repositories)
// ---------------------------------------------------------------------------------------------------------------

export type SearchKind = 'person' | 'unit' | 'request' | 'response';
const TABLE: Record<SearchKind, { table: string; col: string }> = {
  person: { table: 'person_search', col: 'person_id' },
  unit: { table: 'unit_search', col: 'unit_id' },
  request: { table: 'request_search', col: 'request_id' },
  response: { table: 'response_search', col: 'response_id' },
};

/**
 * Deterministic FTS rowid from the entity id (63-bit prefix of SHA-256), so updates and deletes hit the rowid index
 * instead of scanning the UNINDEXED id column.
 */
export function searchRowid(id: string): bigint {
  const h = createHash('sha256').update(id).digest();
  return h.readBigUInt64BE(0) & 0x7fff_ffff_ffff_ffffn;
}

function writeBlob(db: Db, kind: SearchKind, id: Ulid, blob: string | null): void {
  const { table, col } = TABLE[kind];
  const rowid = searchRowid(id);
  db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(rowid);
  if (blob !== null) db.prepare(`INSERT INTO ${table}(rowid, ${col}, blob) VALUES (?, ?, ?)`).run(rowid, id, blob);
}

export function removeFromSearch(db: Db, kind: SearchKind, id: Ulid): void {
  writeBlob(db, kind, id, null);
}

const parseArr = (s: string | null): string[] => {
  if (!s) return [];
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

export function reindexPerson(db: Db, id: Ulid): void {
  const p = db
    .prepare(
      'SELECT surname, given_json, raw_name, dob, nationality, pob_city, pob_state, pob_country, state FROM person WHERE id = ?',
    )
    .get(id) as
    | {
        surname: string | null;
        given_json: string | null;
        raw_name: string | null;
        dob: string | null;
        nationality: string | null;
        pob_city: string | null;
        pob_state: string | null;
        pob_country: string | null;
        state: string;
      }
    | undefined;
  if (!p || p.state === 'purged') return writeBlob(db, 'person', id, null);
  const aliases = (
    db.prepare('SELECT surname, given_json, raw FROM person_alias WHERE person_id = ?').all(id) as {
      surname: string | null;
      given_json: string | null;
      raw: string | null;
    }[]
  ).map((a) => ({ surname: a.surname, given: parseArr(a.given_json), raw: a.raw }));
  const identifiers = (
    db.prepare('SELECT value, value_folded FROM identifier WHERE person_id = ?').all(id) as {
      value: string | null;
      value_folded: string | null;
    }[]
  ).map((i) => ({ value: i.value, valueFolded: i.value_folded }));
  const unitNames = (
    db
      .prepare(
        `SELECT DISTINCT u.name FROM unit u WHERE u.id IN (
           SELECT unit_id FROM request_item WHERE person_id = ? AND unit_id IS NOT NULL
           UNION SELECT unit_id FROM vetting_record WHERE person_id = ? AND unit_id IS NOT NULL)`,
      )
      .all(id, id) as { name: string }[]
  ).map((r) => r.name);
  writeBlob(
    db,
    'person',
    id,
    buildPersonBlob({
      surname: p.surname,
      given: parseArr(p.given_json),
      raw: p.raw_name,
      aliases,
      identifiers,
      dob: p.dob,
      nationality: p.nationality,
      pob: { city: p.pob_city, state: p.pob_state, country: p.pob_country },
      unitNames,
    }),
  );
}

export function reindexUnit(db: Db, id: Ulid): void {
  const u = db
    .prepare(
      'SELECT name, unit_id_no, alias, location, country, english_description, branch_name, parent_org FROM unit WHERE id = ?',
    )
    .get(id) as
    | {
        name: string;
        unit_id_no: string | null;
        alias: string | null;
        location: string | null;
        country: string | null;
        english_description: string | null;
        branch_name: string | null;
        parent_org: string | null;
      }
    | undefined;
  if (!u) return writeBlob(db, 'unit', id, null);
  const aliases = (
    db.prepare('SELECT name_folded FROM unit_alias WHERE unit_id = ?').all(id) as { name_folded: string }[]
  ).map((a) => a.name_folded);
  writeBlob(
    db,
    'unit',
    id,
    buildUnitBlob({
      name: u.name,
      aliases,
      unitIdNo: u.unit_id_no,
      alias: u.alias,
      location: u.location,
      country: u.country,
      englishDescription: u.english_description,
      branchName: u.branch_name,
      parentOrg: u.parent_org,
    }),
  );
}

export function reindexRequest(db: Db, id: Ulid): void {
  const r = db
    .prepare(
      'SELECT event_name, event_location, requestor_name, requestor_email, requestor_org, batch_id, units_json FROM request WHERE id = ?',
    )
    .get(id) as
    | {
        event_name: string | null;
        event_location: string | null;
        requestor_name: string | null;
        requestor_email: string | null;
        requestor_org: string | null;
        batch_id: string | null;
        units_json: string | null;
      }
    | undefined;
  if (!r) return writeBlob(db, 'request', id, null);
  let units: ObservedUnit[] = [];
  try {
    const v: unknown = r.units_json ? JSON.parse(r.units_json) : [];
    if (Array.isArray(v)) units = v as ObservedUnit[];
  } catch {
    units = [];
  }
  const items = (
    db.prepare('SELECT observed_json FROM request_item WHERE request_id = ?').all(id) as { observed_json: string }[]
  ).map((x) => JSON.parse(x.observed_json) as ObservedPerson);
  writeBlob(
    db,
    'request',
    id,
    buildRequestBlob({
      eventName: r.event_name,
      eventLocation: r.event_location,
      requestorName: r.requestor_name,
      requestorEmail: r.requestor_email,
      requestorOrg: r.requestor_org,
      batchId: r.batch_id,
      units,
      items,
    }),
  );
}

export function reindexResponse(db: Db, id: Ulid): void {
  const r = db.prepare('SELECT batch_id, post, assistance_line FROM response WHERE id = ?').get(id) as
    { batch_id: string | null; post: string | null; assistance_line: string | null } | undefined;
  if (!r) return writeBlob(db, 'response', id, null);
  const rows = (
    db.prepare('SELECT name_raw, unit_name, dob FROM response_row WHERE response_id = ?').all(id) as {
      name_raw: string | null;
      unit_name: string | null;
      dob: string | null;
    }[]
  ).map((x) => ({ nameRaw: x.name_raw, unitName: x.unit_name, dob: x.dob }));
  writeBlob(
    db,
    'response',
    id,
    buildResponseBlob({ batchId: r.batch_id, post: r.post, assistanceLine: r.assistance_line, rows }),
  );
}

const REINDEX: Record<SearchKind, (db: Db, id: Ulid) => void> = {
  person: reindexPerson,
  unit: reindexUnit,
  request: reindexRequest,
  response: reindexResponse,
};
export function reindex(db: Db, kind: SearchKind, id: Ulid): void {
  REINDEX[kind](db, id);
}

/** Drop and rebuild every blob (after `setSearchFolder`, or as a repair). */
export function rebuildAllSearch(db: Db): void {
  db.transaction(() => {
    const src: Record<SearchKind, string> = {
      person: 'SELECT id FROM person',
      unit: 'SELECT id FROM unit',
      request: 'SELECT id FROM request',
      response: 'SELECT id FROM response',
    };
    for (const kind of Object.keys(TABLE) as SearchKind[]) {
      db.exec(`DELETE FROM ${TABLE[kind].table}`);
      for (const { id } of db.prepare(src[kind]).all() as { id: string }[]) REINDEX[kind](db, id);
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------------------------------------------

export interface SearchFilters {
  kinds?: SearchKind[];
  /** Include merged persons (default false; purged persons are never indexed). */
  includeMerged?: boolean;
}
export interface SearchPage {
  offset: number;
  limit: number;
}
export interface SearchHit {
  kind: SearchKind;
  id: Ulid;
  /** Lower is better (bm25); 0 in LIKE mode. */
  rank: number;
}
export interface SearchGroup {
  kind: SearchKind;
  total: number;
  hits: SearchHit[];
}
export interface SearchResults {
  /** 'fts' when every term has >= 3 characters, 'like' otherwise, 'empty' for a blank query. */
  mode: 'fts' | 'like' | 'empty';
  groups: SearchGroup[];
}

interface Compiled {
  mode: 'fts' | 'like' | 'empty';
  where: string;
  params: string[];
}

function compile(text: string, table: string): Compiled {
  const terms = foldForSearch(text).split(' ').filter(Boolean);
  if (terms.length === 0) return { mode: 'empty', where: '0', params: [] };
  if (terms.every((t) => [...t].length >= 3)) {
    const q = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
    return { mode: 'fts', where: `s.${table} MATCH ?`, params: [q] };
  }
  const esc = (t: string) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return { mode: 'like', where: terms.map(() => `s.blob LIKE ? ESCAPE '\\'`).join(' AND '), params: terms.map(esc) };
}

function queryKind(
  db: Db,
  kind: SearchKind,
  text: string,
  filters: SearchFilters,
  page: SearchPage,
): { mode: Compiled['mode']; group: SearchGroup } {
  const { table, col } = TABLE[kind];
  const c = compile(text, table);
  if (c.mode === 'empty') return { mode: 'empty', group: { kind, total: 0, hits: [] } };
  const join =
    kind === 'person' && !filters.includeMerged ? `JOIN person p ON p.id = s.${col} AND p.state = 'active'` : '';
  // In fts mode the FTS5 hidden column (named like the table) is qualified with the alias s.
  const from = `FROM ${table} s ${join} WHERE ${c.where}`;
  const total = (db.prepare(`SELECT count(*) AS n ${from}`).get(...c.params) as { n: number }).n;
  const order = c.mode === 'fts' ? 'ORDER BY s.rank, s.rowid' : `ORDER BY s.${col}`;
  const rows = db
    .prepare(`SELECT s.${col} AS id, ${c.mode === 'fts' ? 's.rank' : '0'} AS rank ${from} ${order} LIMIT ? OFFSET ?`)
    .all(...c.params, page.limit, page.offset) as { id: string; rank: number }[];
  return { mode: c.mode, group: { kind, total, hits: rows.map((r) => ({ kind, id: r.id, rank: r.rank })) } };
}

/** Grouped search across entity kinds. `page` applies per group. */
export function searchAll(
  db: Db,
  text: string,
  filters: SearchFilters = {},
  page: SearchPage = { offset: 0, limit: 20 },
): SearchResults {
  const kinds = filters.kinds ?? (['person', 'unit', 'request', 'response'] as SearchKind[]);
  let mode: SearchResults['mode'] = 'empty';
  const groups: SearchGroup[] = [];
  for (const kind of kinds) {
    const r = queryKind(db, kind, text, filters, page);
    mode = r.mode;
    groups.push(r.group);
  }
  return { mode, groups };
}

/** Ids of one kind matching `text` (for list queries with a `text` filter). */
export function searchIds(db: Db, kind: SearchKind, text: string, limit = 5000, filters: SearchFilters = {}): Ulid[] {
  return queryKind(db, kind, text, filters, { offset: 0, limit }).group.hits.map((h) => h.id);
}
