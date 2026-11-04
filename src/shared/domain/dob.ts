/**
 * Calendar checks and the display classification of dates of birth (UI review round 2, R2O-02 / R2O-04).
 *
 * Identity rule: a date of birth is never shown as if it were valid when it is not, and an ambiguous day/month
 * date is never silently normalised. Callers render `text` exactly (the value as read or as written) and show a
 * badge for `invalid` and `ambiguous`.
 */
import type { IsoDate } from './types';

/** Proleptic Gregorian check, years 1900..9999 (the range every VSS date parser accepts). */
export function isValidYmd(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1900 || y > 9999 || m < 1 || m > 12 || d < 1) return false;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= dim;
}

/** True only for a 'YYYY-MM-DD' string that names a real calendar day (so '1995-20-07' is false). */
export function isCalendarIsoDate(s: string | null | undefined): s is IsoDate {
  const m = typeof s === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) : null;
  return !!m && isValidYmd(Number(m[1]), Number(m[2]), Number(m[3]));
}

const pad = (n: number): string => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number): IsoDate => `${y}-${pad(m)}-${pad(d)}`;

/** Both readings of a 'a/b/yyyy' text date when each is a real date and they differ; otherwise null. */
export function slashDateReadings(raw: string | null | undefined): { md: IsoDate; dm: IsoDate } | null {
  const m = typeof raw === 'string' ? /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(raw.trim()) : null;
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const y = Number(m[3]);
  if (a === b || !isValidYmd(y, a, b) || !isValidYmd(y, b, a)) return null;
  return { md: iso(y, a, b), dm: iso(y, b, a) };
}

export type DobState = 'empty' | 'ok' | 'ambiguous' | 'invalid';
export interface DobView {
  state: DobState;
  /** What to show: the ISO date when it is a real date, otherwise the text exactly as stored or written. */
  text: string;
  /** The value as written in the source ('' when unknown or the same as `text`). */
  raw: string;
  /** For 'ambiguous': both readings (month/day first, day/month second). */
  readings: { md: IsoDate; dm: IsoDate } | null;
}

/**
 * Classify a date of birth for display.
 * - `parsed` is the date VSS read (ISO) or null; `raw` is the cell/text as written ('' when none).
 * - invalid: something was written but it is not a real date, or a stored ISO value is not a calendar date.
 * - ambiguous: the source flagged day/month as ambiguous, or the written text is a slash date that reads as two
 *   different real dates. The text shown is the parsed reading; `readings` gives both.
 */
export function classifyDob(
  parsed: string | null | undefined,
  raw: string | null | undefined,
  opts: { ambiguous?: boolean } = {},
): DobView {
  const r = (raw ?? '').trim();
  const p = (parsed ?? '').trim();
  if (p === '' && r === '') return { state: 'empty', text: '', raw: '', readings: null };
  if (p === '' || !isCalendarIsoDate(p)) {
    // Never normalise: show what was written (or the impossible stored value).
    return { state: 'invalid', text: r !== '' ? r : p, raw: r !== '' && r !== p ? r : '', readings: null };
  }
  const readings = slashDateReadings(r);
  if (readings && (readings.md === p || readings.dm === p)) return { state: 'ambiguous', text: p, raw: r, readings };
  if (opts.ambiguous) {
    const [y, mo, d] = p.split('-').map(Number) as [number, number, number];
    const swapped = mo !== d && isValidYmd(y, d, mo) ? iso(y, d, mo) : null;
    if (swapped) return { state: 'ambiguous', text: p, raw: r !== p ? r : '', readings: { md: p, dm: swapped } };
  }
  return { state: 'ok', text: p, raw: r !== p ? r : '', readings: null };
}
