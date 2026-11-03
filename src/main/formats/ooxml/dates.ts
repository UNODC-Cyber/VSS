import type { IsoDate } from '../../../shared/domain/types.ts';

/** Excel 1900 date system, including the historical leap-year bug (serial 60 is the non-existent 1900-02-29). */

export const MAX_SERIAL = 2958465; // 9999-12-31
const EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

export function isValidYmd(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1900 || y > 9999 || m < 1 || m > 12 || d < 1) return false;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= dim;
}

export function formatIso(y: number, m: number, d: number): IsoDate {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseIso(iso: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return isValidYmd(y, mo, d) ? { y, m: mo, d } : null;
}

/** Excel serial (fraction ignored) to ISO date. Null for serial 60 (fake leap day), < 1 and > MAX_SERIAL. */
export function serialToIso(serial: number): IsoDate | null {
  if (!Number.isFinite(serial)) return null;
  const day = Math.floor(serial);
  if (day < 1 || day > MAX_SERIAL || day === 60) return null;
  const days = day < 60 ? day + 1 : day; // days since 1899-12-30 in the proleptic Gregorian calendar
  const dt = new Date(EPOCH_MS + days * DAY_MS);
  return formatIso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** ISO date to Excel serial. Null for invalid dates or years outside 1900..9999. */
export function isoToSerial(iso: IsoDate): number | null {
  const p = parseIso(iso);
  if (!p) return null;
  const days = Math.round((Date.UTC(p.y, p.m - 1, p.d) - EPOCH_MS) / DAY_MS);
  const serial = days < 61 ? days - 1 : days;
  return serial >= 1 && serial <= MAX_SERIAL ? serial : null;
}

/** Whole days between two ISO dates (b - a). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  const pa = parseIso(a);
  const pb = parseIso(b);
  if (!pa || !pb) return NaN;
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / DAY_MS);
}

export function addDays(iso: IsoDate, days: number): IsoDate {
  const p = parseIso(iso);
  if (!p) throw new RangeError(`bad ISO date ${iso}`);
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d) + days * DAY_MS);
  return formatIso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** Completed years between a birth date and a reference date. */
export function ageOn(birth: IsoDate, on: IsoDate): number {
  const b = parseIso(birth);
  const o = parseIso(on);
  if (!b || !o) return NaN;
  let age = o.y - b.y;
  if (o.m < b.m || (o.m === b.m && o.d < b.d)) age -= 1;
  return age;
}

export function todayIso(now: Date): IsoDate {
  return formatIso(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
}
