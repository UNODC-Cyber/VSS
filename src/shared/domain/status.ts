/**
 * Derivation of a person's VettingStatus.
 * Precedence (docs/PLAN.md): non-approved > expired > expiring > pending > approved > unknown.
 * The deciding record is the person's most recent one (recordedAt, then certDate): a later approval supersedes an earlier
 * refusal and vice versa. Pure and deterministic; `asOf` is always passed in.
 */
import type { IsoDate, RequestStatus, Ulid, VettingRecord, VettingStatus, VettingStatusSnapshot } from './types';

export type StatusRecord = Pick<
  VettingRecord,
  'id' | 'unitId' | 'disposition' | 'certDate' | 'expiresAt' | 'recordedAt'
>;

export interface StatusInput {
  records: readonly StatusRecord[];
  /** True when the person is on an exported/sent request that has no response yet (see isRequestAwaitingResponse). */
  pending: boolean;
  asOf: IsoDate;
  /** settings.exportPolicy.expiringWithinDays */
  expiringWithinDays: number;
}

/** Request states in which the people on it count as "pending" (until a response is recorded). */
export function isRequestAwaitingResponse(status: RequestStatus): boolean {
  return status === 'exported' || status === 'sent-to-dc';
}

function parseIsoDateUtc(d: IsoDate): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) throw new RangeError(`invalid ISO date: ${d}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
/** Whole days from a to b (b - a), calendar based. */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((parseIsoDateUtc(b) - parseIsoDateUtc(a)) / 86_400_000);
}
export function addDays(d: IsoDate, days: number): IsoDate {
  return new Date(parseIsoDateUtc(d) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The record that decides the status: latest recordedAt, ties broken by certDate then id. */
export function latestRecord<T extends StatusRecord>(records: readonly T[]): T | null {
  let best: T | null = null;
  for (const r of records) {
    if (best === null) {
      best = r;
      continue;
    }
    const a = [r.recordedAt, r.certDate ?? '', r.id];
    const b = [best.recordedAt, best.certDate ?? '', best.id];
    for (let i = 0; i < 3; i++) {
      if (a[i]! === b[i]!) continue;
      if (a[i]! > b[i]!) best = r;
      break;
    }
  }
  return best;
}

export function deriveStatus(input: StatusInput): VettingStatus {
  return deriveSnapshot(input).status;
}

export function deriveSnapshot(input: StatusInput): VettingStatusSnapshot {
  const { asOf, expiringWithinDays, pending } = input;
  const rec = latestRecord(input.records);
  const base = {
    certDate: rec?.certDate ?? null,
    expiresAt: rec?.expiresAt ?? null,
    unitId: (rec?.unitId ?? null) as Ulid | null,
    source: (rec?.id ?? null) as Ulid | null,
    asOf,
  };
  const make = (status: VettingStatus): VettingStatusSnapshot => ({ status, ...base });

  if (rec && rec.disposition === 'non-approved') return make('non-approved');

  if (rec && rec.expiresAt !== null) {
    const left = daysBetween(asOf, rec.expiresAt);
    if (left < 0) return make('expired');
    if (left <= expiringWithinDays) return make('expiring');
  }
  if (pending) return make('pending');
  if (rec) return make('approved');
  return make('unknown');
}
