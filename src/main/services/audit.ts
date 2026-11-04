/**
 * Hash-chained, append-only audit log (WP-20).
 * hash_n = SHA-256( prev_hash || canonicalJson({seq, at, actor, type, subjectType, subjectId, details}) ), genesis
 * prev_hash = 64 zeros. SQL triggers block UPDATE/DELETE; `verifyChain` detects tampering done around them (raw
 * connection, dropped triggers) and truncation (the chain head is mirrored in meta 'audit.head' in the same transaction).
 * Details are allowlisted: only non-PII keys, primitive values, strings <= 200 chars.
 */
import { createHash } from 'node:crypto';
import type { AuditEvent, IsoDateTime, Ulid } from '@shared/domain/types';
import type { AuditListQuery, AuditVerifyResult, Page } from '@shared/ipc/contract';
import { DbError } from '../db/errors';
import type { Db } from '../db/open';

export const GENESIS_HASH = '0'.repeat(64);
export const AUDIT_MAX_STRING = 200;
const HEAD_KEY = 'audit.head';

/** Detail keys that never carry personal data. Extend here (reviewed) when a service needs a new one. */
export const AUDIT_DETAIL_KEYS: ReadonlySet<string> = new Set([
  // counts and sizes
  'count',
  'itemCount',
  'unitCount',
  'rowCount',
  'recordCount',
  'recordsCreated',
  'reviewItemsCreated',
  'includedCount',
  'excludedCount',
  'autoMatchedCount',
  'needsReviewCount',
  'unmatchedCount',
  'errorCount',
  'warningCount',
  'bytes',
  'durationMs',
  'personsDeleted',
  'unitsDeleted',
  'itemsDeleted',
  'noteLength',
  'filesDeleted',
  // enums / codes
  'status',
  'fromStatus',
  'toStatus',
  'mode',
  'kind',
  'decision',
  'tier',
  'disposition',
  'source',
  'section',
  'action',
  'result',
  'code',
  'reasonCode',
  'linkState',
  'exportDecision',
  'responseKind',
  'slotKind',
  'template',
  'phase',
  // versions / hashes / flags
  'schemaVersion',
  'fromVersion',
  'toVersion',
  'appVersion',
  'templateVersion',
  'sha256',
  'enabled',
  'expiryAssumed',
  // entity ids (ULIDs) and setting names
  'requestId',
  'responseId',
  'personId',
  'unitId',
  'itemId',
  'rowId',
  'exportId',
  'reviewItemId',
  'mergeLogId',
  'survivorId',
  'mergedId',
  'recordId',
  'fileId',
  'slotId',
  'setting',
  'fields',
]);

export type AuditDetails = Record<string, string | number | boolean>;
export interface AuditAppend {
  actor: string;
  type: string;
  subjectType: string;
  subjectId: Ulid | null;
  details?: AuditDetails;
  at?: IsoDateTime;
}

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new TypeError('non-finite number');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

export function validateDetails(details: AuditDetails): void {
  for (const [k, v] of Object.entries(details)) {
    if (!AUDIT_DETAIL_KEYS.has(k))
      throw new DbError('AUDIT_DETAIL_REJECTED', `audit detail key not allowed: ${k.slice(0, 40)}`);
    const t = typeof v;
    if (t !== 'string' && t !== 'number' && t !== 'boolean')
      throw new DbError('AUDIT_DETAIL_REJECTED', `audit detail ${k}: value must be primitive`);
    if (t === 'number' && !Number.isFinite(v))
      throw new DbError('AUDIT_DETAIL_REJECTED', `audit detail ${k}: non-finite number`);
    if (t === 'string' && (v as string).length > AUDIT_MAX_STRING)
      throw new DbError('AUDIT_DETAIL_REJECTED', `audit detail ${k}: string longer than ${AUDIT_MAX_STRING}`);
  }
}

export function hashEvent(prevHash: string, e: Omit<AuditEvent, 'prevHash' | 'hash'>): string {
  const body = canonicalJson({
    seq: e.seq,
    at: e.at,
    actor: e.actor,
    type: e.type,
    subjectType: e.subjectType,
    subjectId: e.subjectId,
    details: e.details,
  });
  return createHash('sha256').update(prevHash).update(body).digest('hex');
}

interface Row {
  seq: number;
  at: string;
  actor: string;
  type: string;
  subject_type: string;
  subject_id: string | null;
  details_json: string;
  prev_hash: string;
  hash: string;
}
const map = (r: Row): AuditEvent => ({
  seq: r.seq,
  at: r.at,
  actor: r.actor,
  type: r.type,
  subjectType: r.subject_type,
  subjectId: r.subject_id,
  details: JSON.parse(r.details_json) as AuditDetails,
  prevHash: r.prev_hash,
  hash: r.hash,
});

export class AuditLog {
  constructor(private readonly db: Db) {}

  append(input: AuditAppend): AuditEvent {
    const details = input.details ?? {};
    validateDetails(details);
    for (const [k, v] of [
      ['actor', input.actor],
      ['type', input.type],
      ['subjectType', input.subjectType],
    ] as const)
      if (v.length > AUDIT_MAX_STRING)
        throw new DbError('AUDIT_DETAIL_REJECTED', `audit ${k} longer than ${AUDIT_MAX_STRING}`);
    return this.db.transaction(() => {
      const last = this.db.prepare('SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1').get() as
        { seq: number; hash: string } | undefined;
      const prevHash = last?.hash ?? GENESIS_HASH;
      const base = {
        seq: (last?.seq ?? 0) + 1,
        at: input.at ?? new Date().toISOString(),
        actor: input.actor,
        type: input.type,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        details,
      };
      const hash = hashEvent(prevHash, base);
      this.db
        .prepare(
          'INSERT INTO audit(seq, at, actor, type, subject_type, subject_id, details_json, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?)',
        )
        .run(
          base.seq,
          base.at,
          base.actor,
          base.type,
          base.subjectType,
          base.subjectId,
          canonicalJson(details),
          prevHash,
          hash,
        );
      this.db
        .prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(HEAD_KEY, `${base.seq}:${hash}`);
      return { ...base, prevHash, hash };
    });
  }

  list(q: AuditListQuery): Page<AuditEvent> {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (q.type) {
      where.push('type = ?');
      vals.push(q.type);
    }
    if (q.subjectType) {
      where.push('subject_type = ?');
      vals.push(q.subjectType);
    }
    if (q.subjectId) {
      where.push('subject_id = ?');
      vals.push(q.subjectId);
    }
    if (q.from) {
      where.push('at >= ?');
      vals.push(q.from);
    }
    if (q.to) {
      where.push('at <= ?');
      vals.push(q.to);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT count(*) AS n FROM audit ${w}`).get(...vals) as { n: number }).n;
    const rows = this.db
      .prepare(`SELECT * FROM audit ${w} ORDER BY seq DESC LIMIT ? OFFSET ?`)
      .all(...vals, q.limit, q.offset) as Row[];
    return { items: rows.map(map), total, offset: q.offset, limit: q.limit };
  }

  /** Walk the whole chain from genesis. `brokenAtSeq` is the first seq whose link/hash/sequence is wrong. */
  verifyChain(): AuditVerifyResult {
    let prev = GENESIS_HASH;
    let expectSeq = 1;
    let checked = 0;
    for (const r of this.db.prepare('SELECT * FROM audit ORDER BY seq').iterate() as IterableIterator<Row>) {
      let ok = r.seq === expectSeq && r.prev_hash === prev;
      if (ok) {
        try {
          const e = map(r);
          ok = canonicalJson(e.details) === r.details_json && hashEvent(prev, e) === r.hash;
        } catch {
          ok = false;
        }
      }
      if (!ok) return { ok: false, checked, brokenAtSeq: r.seq };
      prev = r.hash;
      expectSeq++;
      checked++;
    }
    const head = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(HEAD_KEY) as { value: string } | undefined;
    if (head ? head.value !== `${expectSeq - 1}:${prev}` : checked > 0) {
      return { ok: false, checked, brokenAtSeq: expectSeq };
    }
    return { ok: true, checked, brokenAtSeq: null };
  }
}
