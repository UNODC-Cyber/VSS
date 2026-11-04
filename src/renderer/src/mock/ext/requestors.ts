/**
 * LANE B mock (docs/PLAN-ALPHA.md section 4): saved requestors and the type-ahead, same rules as the real service.
 * The record store is kept per mock DB (created on first use and backfilled from the requests); request counts are
 * derived from the requests, so they cannot drift.
 */
import type { Requestor, RequestorRecord } from '@shared/domain/types';
import { appendAudit, newId } from '../db';
import type { MockDb } from '../db';
import { mockFail, mockOk } from './types';
import type { MockExtension } from './types';

const fold = (s: string | null | undefined): string =>
  (s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const foldMail = (s: string | null | undefined): string => fold(s).replace(/ /g, '');
const blank = (s: string | null | undefined): string | null => (s && s.trim() !== '' ? s.trim() : null);

type Stored = Omit<RequestorRecord, 'requestCount'>;
const stores = new WeakMap<MockDb, Stored[]>();

function store(db: MockDb): Stored[] {
  let s = stores.get(db);
  if (s) return s;
  s = [];
  stores.set(db, s);
  // Backfill from existing requests (the same grouping as migration 005).
  for (const r of [...db.requests].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))) {
    const rec = touchIn(db, s, r.requestor, r.receivedAt);
    if (rec) r.requestor = { ...r.requestor, id: rec.id };
  }
  return s;
}

function find(s: Stored[], r: { name: string; email: string | null; organisation: string | null }): Stored | null {
  const ef = foldMail(r.email);
  if (ef !== '') {
    const hit = s.find((x) => foldMail(x.email) === ef);
    if (hit) return hit;
  }
  const nf = fold(r.name);
  if (nf === '') return null;
  return s.find((x) => !x.email && fold(x.name) === nf && fold(x.organisation) === fold(r.organisation)) ?? null;
}

function touchIn(db: MockDb, s: Stored[], r: Requestor, at: string, audit = false): Stored | null {
  const name = r.name.trim();
  const email = blank(r.email);
  if (name === '' && email === null) return null;
  const org = blank(r.organisation);
  const byId = r.id ? s.find((x) => x.id === r.id) : undefined;
  if (byId) {
    const next = { name, email, organisation: org, phone: r.phone === undefined ? byId.phone : blank(r.phone) };
    const fields = (['name', 'email', 'organisation', 'phone'] as const).filter(
      (k) => (byId[k] ?? '') !== (next[k] ?? ''),
    );
    if (fields.length === 0) return byId;
    // Requests that still mirror the old values follow the record.
    for (const q of db.requests) {
      if (
        q.requestor.id === byId.id &&
        q.requestor.name === byId.name &&
        (q.requestor.email ?? null) === byId.email &&
        (q.requestor.organisation ?? null) === byId.organisation
      )
        q.requestor = { ...q.requestor, name, email, organisation: org };
    }
    Object.assign(byId, next, { updatedAt: at });
    if (audit) appendAudit(db, 'requestor.update', 'requestor', byId.id, 0, { fields: fields.join(',') });
    return byId;
  }
  const hit = find(s, { name, email, organisation: org });
  if (hit) {
    hit.email ??= email;
    hit.organisation ??= org;
    hit.phone ??= blank(r.phone);
    return hit;
  }
  const rec: Stored = {
    id: newId(),
    name,
    email,
    organisation: org,
    phone: blank(r.phone),
    notes: r.notes ?? '',
    createdAt: at,
    updatedAt: at,
    lastUsedAt: at,
  };
  s.push(rec);
  if (audit) appendAudit(db, 'requestor.create', 'requestor', rec.id, 0, { source: 'request' });
  return rec;
}

/** Used by the base mock when a request is created or edited: returns the requestor linked to its saved record. */
export function linkMockRequestor(db: MockDb, r: Requestor): Requestor {
  const s = store(db);
  const at = new Date().toISOString();
  const rec = touchIn(db, s, r, at, true);
  const { id: _drop, ...rest } = r;
  if (!rec) return rest;
  rec.lastUsedAt = at;
  return { ...rest, id: rec.id };
}

const record = (db: MockDb, s: Stored): RequestorRecord => ({
  ...s,
  requestCount: db.requests.filter((q) => q.requestor.id === s.id).length,
});

export const requestorsMock: MockExtension = ({ db }) => ({
  requestors: {
    search: (req) => {
      const t = fold(req.text);
      const tm = t.replace(/ /g, '');
      const all = store(db).filter((x) => t === '' || fold(x.name).includes(t) || foldMail(x.email).includes(tm));
      const starts = (x: Stored) => (fold(x.name).startsWith(t) || foldMail(x.email).startsWith(tm) ? 0 : 1);
      all.sort((a, b) => starts(a) - starts(b) || (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''));
      return Promise.resolve(mockOk(all.slice(0, req.limit ?? 8).map((x) => record(db, x))));
    },
    get: ({ id }) => {
      const s = store(db).find((x) => x.id === id);
      return Promise.resolve(s ? mockOk(record(db, s)) : mockFail('NOT_FOUND', 'Requestor not found'));
    },
    upsert: ({ requestor }) => {
      const s = store(db);
      if (requestor.name.trim() === '') return Promise.resolve(mockFail('BAD_REQUEST', 'A requestor needs a name'));
      if (requestor.id && !s.some((x) => x.id === requestor.id))
        return Promise.resolve(mockFail('NOT_FOUND', 'Requestor not found'));
      const clash =
        requestor.id && blank(requestor.email)
          ? s.find((x) => x.id !== requestor.id && foldMail(x.email) === foldMail(requestor.email))
          : undefined;
      if (clash)
        return Promise.resolve(mockFail('CONFLICT', 'another saved requestor already uses this e-mail address'));
      const rec = touchIn(db, s, requestor, new Date().toISOString(), true);
      return Promise.resolve(rec ? mockOk(record(db, rec)) : mockFail('BAD_REQUEST', 'A requestor needs a name'));
    },
    merge: ({ survivorId, mergedId }) => {
      const s = store(db);
      if (survivorId === mergedId)
        return Promise.resolve(mockFail('BAD_REQUEST', 'A requestor cannot be merged into itself'));
      const a = s.find((x) => x.id === survivorId);
      const b = s.find((x) => x.id === mergedId);
      if (!a || !b) return Promise.resolve(mockFail('NOT_FOUND', 'Requestor not found'));
      let moved = 0;
      for (const q of db.requests)
        if (q.requestor.id === mergedId) {
          q.requestor = { ...q.requestor, id: survivorId };
          moved++;
        }
      a.email ??= b.email;
      a.organisation ??= b.organisation;
      a.phone ??= b.phone;
      if (a.notes === '') a.notes = b.notes;
      s.splice(s.indexOf(b), 1);
      appendAudit(db, 'requestor.merge', 'requestor', survivorId, 0, { survivorId, mergedId, count: moved });
      return Promise.resolve(mockOk(record(db, a)));
    },
    list: (q) => {
      const t = fold(q.text);
      const all = store(db)
        .filter((x) => t === '' || fold(x.name).includes(t) || foldMail(x.email).includes(t.replace(/ /g, '')))
        .sort((a, b) => fold(a.name).localeCompare(fold(b.name)));
      return Promise.resolve(
        mockOk({
          items: all.slice(q.offset, q.offset + q.limit).map((x) => record(db, x)),
          total: all.length,
          offset: q.offset,
          limit: q.limit,
        }),
      );
    },
  },
});
