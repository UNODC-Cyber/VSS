import { latestRecord } from '@shared/domain/status';
import type { IsoDate, Ulid, UnitVettingRecord, VettingRecord } from '@shared/domain/types';
import type { Db } from '../open';
import { reindexPerson } from '../search';
import { b2i, chunked, newId, qs } from './util';

interface VRow {
  id: string;
  person_id: string;
  unit_id: string | null;
  request_id: string | null;
  response_row_id: string | null;
  disposition: string;
  cert_date: string | null;
  expires_at: string | null;
  expiry_assumed: number;
  source: string;
  recorded_at: string;
  recorded_by: string | null;
  note: string | null;
}
const mapV = (r: VRow): VettingRecord => ({
  id: r.id,
  personId: r.person_id,
  unitId: r.unit_id,
  requestId: r.request_id,
  responseRowId: r.response_row_id,
  disposition: r.disposition as VettingRecord['disposition'],
  certDate: r.cert_date,
  expiresAt: r.expires_at,
  expiryAssumed: r.expiry_assumed === 1,
  source: r.source as VettingRecord['source'],
  recordedAt: r.recorded_at,
  recordedBy: r.recorded_by ?? '',
  note: r.note ?? '',
});

export class VettingRecordRepo {
  constructor(private readonly db: Db) {}

  insert(input: Omit<VettingRecord, 'id'> & { id?: Ulid }): VettingRecord {
    const rec: VettingRecord = { ...input, id: input.id ?? newId() };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO vetting_record(id, person_id, unit_id, request_id, response_row_id, disposition, cert_date, expires_at, expiry_assumed,
             source, recorded_at, recorded_by, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          rec.id,
          rec.personId,
          rec.unitId,
          rec.requestId,
          rec.responseRowId,
          rec.disposition,
          rec.certDate,
          rec.expiresAt,
          b2i(rec.expiryAssumed),
          rec.source,
          rec.recordedAt,
          rec.recordedBy,
          rec.note,
        );
      if (rec.unitId) reindexPerson(this.db, rec.personId);
    });
    return rec;
  }

  get(id: Ulid): VettingRecord | null {
    const r = this.db.prepare('SELECT * FROM vetting_record WHERE id = ?').get(id) as VRow | undefined;
    return r ? mapV(r) : null;
  }
  listByPerson(personId: Ulid): VettingRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM vetting_record WHERE person_id = ? ORDER BY recorded_at, id')
        .all(personId) as VRow[]
    ).map(mapV);
  }
  listByPersons(personIds: readonly Ulid[]): Map<Ulid, VettingRecord[]> {
    const out = new Map<Ulid, VettingRecord[]>();
    for (const r of chunked(
      personIds,
      (c) =>
        this.db
          .prepare(`SELECT * FROM vetting_record WHERE person_id IN (${qs(c.length)}) ORDER BY recorded_at, id`)
          .all(...c) as VRow[],
    )) {
      const v = mapV(r);
      out.set(v.personId, [...(out.get(v.personId) ?? []), v]);
    }
    return out;
  }
  listByRequest(requestId: Ulid): VettingRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM vetting_record WHERE request_id = ? ORDER BY recorded_at, id')
        .all(requestId) as VRow[]
    ).map(mapV);
  }
  listByResponseRow(rowId: Ulid): VettingRecord[] {
    return (
      this.db.prepare('SELECT * FROM vetting_record WHERE response_row_id = ? ORDER BY id').all(rowId) as VRow[]
    ).map(mapV);
  }

  /** The deciding record (same ordering as shared/domain/status.latestRecord). */
  latestByPerson(personId: Ulid): VettingRecord | null {
    return latestRecord(this.listByPerson(personId));
  }
  latestByPersons(personIds: readonly Ulid[]): Map<Ulid, VettingRecord> {
    const out = new Map<Ulid, VettingRecord>();
    for (const [pid, recs] of this.listByPersons(personIds)) {
      const l = latestRecord(recs);
      if (l) out.set(pid, l);
    }
    return out;
  }
  /** Records whose expiry falls in [from, to] (inclusive). */
  expiringBetween(from: IsoDate, to: IsoDate): VettingRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM vetting_record WHERE expires_at >= ? AND expires_at <= ? ORDER BY expires_at, id')
        .all(from, to) as VRow[]
    ).map(mapV);
  }
  delete(id: Ulid): void {
    const r = this.get(id);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM vetting_record WHERE id = ?').run(id);
      if (r?.unitId) reindexPerson(this.db, r.personId);
    });
  }
  /** Re-point records after a merge (survivor takes the merged person's history). */
  reassignPerson(fromPersonId: Ulid, toPersonId: Ulid): number {
    return this.db.transaction(() => {
      const n = this.db
        .prepare('UPDATE vetting_record SET person_id = ? WHERE person_id = ?')
        .run(toPersonId, fromPersonId).changes;
      reindexPerson(this.db, toPersonId);
      reindexPerson(this.db, fromPersonId);
      return n;
    });
  }
}

interface URow {
  id: string;
  unit_id: string;
  request_id: string;
  response_row_id: string | null;
  commander_person_id: string | null;
  disposition: string;
  cert_date: string | null;
  expires_at: string | null;
  recorded_at: string;
}
const mapU = (r: URow): UnitVettingRecord => ({
  id: r.id,
  unitId: r.unit_id,
  requestId: r.request_id,
  responseRowId: r.response_row_id,
  commanderPersonId: r.commander_person_id,
  disposition: r.disposition as UnitVettingRecord['disposition'],
  certDate: r.cert_date,
  expiresAt: r.expires_at,
  recordedAt: r.recorded_at,
});

export class UnitVettingRecordRepo {
  constructor(private readonly db: Db) {}

  insert(input: Omit<UnitVettingRecord, 'id'> & { id?: Ulid }): UnitVettingRecord {
    const rec: UnitVettingRecord = { ...input, id: input.id ?? newId() };
    this.db
      .prepare(
        `INSERT INTO unit_vetting_record(id, unit_id, request_id, response_row_id, commander_person_id, disposition, cert_date, expires_at, recorded_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        rec.id,
        rec.unitId,
        rec.requestId,
        rec.responseRowId,
        rec.commanderPersonId,
        rec.disposition,
        rec.certDate,
        rec.expiresAt,
        rec.recordedAt,
      );
    return rec;
  }
  get(id: Ulid): UnitVettingRecord | null {
    const r = this.db.prepare('SELECT * FROM unit_vetting_record WHERE id = ?').get(id) as URow | undefined;
    return r ? mapU(r) : null;
  }
  listByUnit(unitId: Ulid): UnitVettingRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM unit_vetting_record WHERE unit_id = ? ORDER BY recorded_at, id')
        .all(unitId) as URow[]
    ).map(mapU);
  }
  latestByUnit(unitId: Ulid): UnitVettingRecord | null {
    const r = this.db
      .prepare('SELECT * FROM unit_vetting_record WHERE unit_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 1')
      .get(unitId) as URow | undefined;
    return r ? mapU(r) : null;
  }
  listByRequest(requestId: Ulid): UnitVettingRecord[] {
    return (
      this.db.prepare('SELECT * FROM unit_vetting_record WHERE request_id = ? ORDER BY id').all(requestId) as URow[]
    ).map(mapU);
  }
  delete(id: Ulid): void {
    this.db.prepare('DELETE FROM unit_vetting_record WHERE id = ?').run(id);
  }
}
