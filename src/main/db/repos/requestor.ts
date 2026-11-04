/**
 * Saved requestors (migration 005): staff who send requests, de-duplicated by folded e-mail, else folded name +
 * organisation. Requestors are not vetted persons, so person purge never touches this table.
 */
import type { IsoDateTime, RequestorRecord, Ulid } from '@shared/domain/types';
import type { Page, PageQuery } from '@shared/ipc/contract';
import { DbError } from '../errors';
import type { Db } from '../open';
import { foldForSearch, reindexRequest } from '../search';
import { newId, page } from './util';

interface Row {
  id: string;
  name: string;
  name_folded: string;
  email: string | null;
  email_folded: string | null;
  organisation: string | null;
  phone: string | null;
  notes: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  request_count: number;
}

const SELECT = `SELECT q.*, (SELECT count(*) FROM request r WHERE r.requestor_id = q.id) AS request_count FROM requestor q`;
const ESC = `ESCAPE '\\'`;

export interface RequestorFields {
  name: string;
  email: string | null;
  organisation: string | null;
  phone: string | null;
  notes: string;
}
export type RequestorInsert = RequestorFields & { id?: Ulid; at: IsoDateTime; lastUsedAt?: IsoDateTime | null };

const blank = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim();
  return t === '' ? null : t;
};
/** Folded e-mail (dedupe key); null for no address. */
export const foldEmail = (e: string | null | undefined): string | null => {
  const b = blank(e);
  return b === null ? null : foldForSearch(b).replace(/\s+/g, '');
};
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const map = (r: Row): RequestorRecord => ({
  id: r.id,
  name: r.name,
  email: r.email,
  organisation: r.organisation,
  phone: r.phone,
  notes: r.notes,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  requestCount: r.request_count,
  lastUsedAt: r.last_used_at,
});

function emailConflict(e: unknown): unknown {
  return e instanceof Error && /UNIQUE/i.test(e.message)
    ? new DbError('IN_USE', 'another saved requestor already uses this e-mail address', { cause: e })
    : e;
}

export class RequestorRepo {
  constructor(private readonly db: Db) {}

  get(id: Ulid): RequestorRecord | null {
    const r = this.db.prepare(`${SELECT} WHERE q.id = ?`).get(id) as Row | undefined;
    return r ? map(r) : null;
  }

  /** The record the dedupe rule maps these fields to, or null. */
  findMatch(f: { name: string; email: string | null; organisation: string | null }): RequestorRecord | null {
    const ef = foldEmail(f.email);
    if (ef !== null) {
      const r = this.db.prepare(`${SELECT} WHERE q.email_folded = ?`).get(ef) as Row | undefined;
      // No record owns this address: a same name + organisation record without an address may adopt it.
      if (r) return map(r);
    }
    const nf = foldForSearch(f.name);
    if (nf === '') return null;
    const of = foldForSearch(blank(f.organisation) ?? '');
    const rows = this.db
      .prepare(`${SELECT} WHERE q.email_folded IS NULL AND q.name_folded = ? ORDER BY q.created_at, q.id`)
      .all(nf) as Row[];
    const hit = rows.find((r) => foldForSearch(r.organisation ?? '') === of);
    return hit ? map(hit) : null;
  }

  insert(input: RequestorInsert): RequestorRecord {
    const id = input.id ?? newId();
    try {
      this.db
        .prepare(
          `INSERT INTO requestor(id, name, name_folded, email, email_folded, organisation, phone, notes, created_at, updated_at, last_used_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.name.trim(),
          foldForSearch(input.name),
          blank(input.email),
          foldEmail(input.email),
          blank(input.organisation),
          blank(input.phone),
          input.notes,
          input.at,
          input.at,
          input.lastUsedAt ?? null,
        );
    } catch (e) {
      throw emailConflict(e);
    }
    return this.get(id)!;
  }

  /**
   * Replace the editable fields. Request rows that still mirror the record's previous values (they "follow" it)
   * are rewritten to the new values and re-indexed; rows an operator changed for one request only are left alone.
   * Returns the record and how many request rows followed.
   */
  update(id: Ulid, f: RequestorFields, at: IsoDateTime): { record: RequestorRecord; followed: number } {
    const before = this.get(id);
    if (!before) throw new DbError('NOT_FOUND', 'requestor not found');
    try {
      this.db
        .prepare(
          `UPDATE requestor SET name=?, name_folded=?, email=?, email_folded=?, organisation=?, phone=?, notes=?, updated_at=? WHERE id=?`,
        )
        .run(
          f.name.trim(),
          foldForSearch(f.name),
          blank(f.email),
          foldEmail(f.email),
          blank(f.organisation),
          blank(f.phone),
          f.notes,
          at,
          id,
        );
    } catch (e) {
      throw emailConflict(e);
    }
    const followers = this.db
      .prepare(
        `SELECT id FROM request WHERE requestor_id = ? AND coalesce(requestor_name,'') = ? AND coalesce(requestor_email,'') = ?
           AND coalesce(requestor_org,'') = ?`,
      )
      .all(id, before.name, before.email ?? '', before.organisation ?? '') as { id: string }[];
    for (const r of followers) {
      this.db
        .prepare('UPDATE request SET requestor_name=?, requestor_email=?, requestor_org=? WHERE id=?')
        .run(f.name.trim(), blank(f.email), blank(f.organisation), r.id);
      reindexRequest(this.db, r.id);
    }
    return { record: this.get(id)!, followed: followers.length };
  }

  touchUsed(id: Ulid, at: IsoDateTime): void {
    this.db
      .prepare('UPDATE requestor SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)')
      .run(at, id, at);
  }

  /** Type-ahead: folded name or e-mail contains the text; prefix matches first, then most recently used. */
  search(text: string, limit: number): RequestorRecord[] {
    const t = foldForSearch(text);
    if (t === '') {
      return (
        this.db
          .prepare(`${SELECT} ORDER BY q.last_used_at IS NULL, q.last_used_at DESC, q.name_folded LIMIT ?`)
          .all(limit) as Row[]
      ).map(map);
    }
    const like = likeEscape(t);
    const likeMail = likeEscape(t.replace(/\s+/g, ''));
    const rows = this.db
      .prepare(
        `${SELECT} WHERE q.name_folded LIKE ? ${ESC} OR q.email_folded LIKE ? ${ESC}
         ORDER BY (q.name_folded LIKE ? ${ESC} OR q.email_folded LIKE ? ${ESC}) DESC,
                  q.last_used_at IS NULL, q.last_used_at DESC, q.name_folded, q.id LIMIT ?`,
      )
      .all(`%${like}%`, `%${likeMail}%`, `${like}%`, `${likeMail}%`, limit) as Row[];
    return rows.map(map);
  }

  list(q: PageQuery & { text?: string }): Page<RequestorRecord> {
    const t = foldForSearch(q.text ?? '');
    const where = t === '' ? '' : `WHERE q.name_folded LIKE ? ${ESC} OR q.email_folded LIKE ? ${ESC}`;
    const args = t === '' ? [] : [`%${likeEscape(t)}%`, `%${likeEscape(t.replace(/\s+/g, ''))}%`];
    const total = (this.db.prepare(`SELECT count(*) AS n FROM requestor q ${where}`).get(...args) as { n: number }).n;
    const rows = this.db
      .prepare(`${SELECT} ${where} ORDER BY q.name_folded, q.id LIMIT ? OFFSET ?`)
      .all(...args, q.limit, q.offset) as Row[];
    return page(rows.map(map), total, q);
  }

  /** Repoint every request of `mergedId` to `survivorId`, fill the survivor's blanks, delete the merged record. */
  merge(survivorId: Ulid, mergedId: Ulid, at: IsoDateTime): { record: RequestorRecord; moved: number } {
    const s = this.get(survivorId);
    const m = this.get(mergedId);
    if (!s || !m) throw new DbError('NOT_FOUND', 'requestor not found');
    const moved = this.db
      .prepare('UPDATE request SET requestor_id = ? WHERE requestor_id = ?')
      .run(survivorId, mergedId).changes;
    // The merged record's e-mail is unique: free it before the survivor adopts it.
    this.db.prepare('DELETE FROM requestor WHERE id = ?').run(mergedId);
    const email = s.email ?? m.email;
    this.db
      .prepare(
        `UPDATE requestor SET email=?, email_folded=?, organisation=?, phone=?, notes=?, updated_at=?,
           last_used_at = CASE WHEN ? IS NOT NULL AND (last_used_at IS NULL OR last_used_at < ?) THEN ? ELSE last_used_at END
         WHERE id=?`,
      )
      .run(
        email,
        foldEmail(email),
        s.organisation ?? m.organisation,
        s.phone ?? m.phone,
        s.notes !== '' ? s.notes : m.notes,
        at,
        m.lastUsedAt,
        m.lastUsedAt,
        m.lastUsedAt,
        survivorId,
      );
    return { record: this.get(survivorId)!, moved };
  }

  /**
   * Re-fold name and e-mail with the app's search folding. The 005 backfill can only use SQL lower(), so rows
   * created by it are refolded once; a row that would collide on e-mail keeps its old key. Returns rows changed.
   */
  refoldStale(): number {
    let n = 0;
    const rows = this.db.prepare('SELECT id, name, name_folded, email, email_folded FROM requestor').all() as Row[];
    for (const r of rows) {
      const nf = foldForSearch(r.name);
      const ef = foldEmail(r.email);
      if (nf === r.name_folded && ef === r.email_folded) continue;
      try {
        this.db.prepare('UPDATE requestor SET name_folded = ?, email_folded = ? WHERE id = ?').run(nf, ef, r.id);
        n++;
      } catch {
        /* unique collision: leave the old key */
      }
    }
    return n;
  }
}
