import { isCalendarIsoDate } from '../../shared/domain/dob';
import type { IsoDate, MatchEvidence, RawDate } from '../../shared/domain/types';
import type { DobInfo } from './types';

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Dates registries and forms use when the real date is not known (security review F-06): 1 January (also how a
 * year-only date is usually encoded), 1 July (mid-year default), 31 December, and any year up to 1900 (system
 * sentinels such as 1900-01-01). Such a date can still be a real birthday, so it is never evidence against a match,
 * but it is never precise enough for an automatic link.
 */
export function isPlaceholderDob(date: IsoDate | null | undefined): boolean {
  const m = date ? ISO.exec(date) : null;
  if (!m) return false;
  const md = `${m[2]}-${m[3]}`;
  return Number(m[1]) <= 1900 || md === '01-01' || md === '07-01' || md === '12-31';
}

export function dobFromRaw(raw: RawDate | null | undefined): DobInfo {
  // An impossible stored date (e.g. month 20) is no date at all: never evidence for (or against) a match.
  if (!raw || !isCalendarIsoDate(raw.parsed)) return { date: null, precision: 'unknown' };
  return {
    date: raw.parsed,
    precision: raw.ambiguousDayMonth ? 'ambiguous-dm' : 'exact',
    placeholder: isPlaceholderDob(raw.parsed),
  };
}

/** Day/month swapped date, or null when the swap is invalid or identical. */
export function swapDayMonth(date: IsoDate): IsoDate | null {
  const m = ISO.exec(date);
  if (!m) return null;
  const [, y, mo, d] = m;
  if (mo === d) return null;
  const day = Number(mo);
  const month = Number(d);
  if (month < 1 || month > 12) return null;
  const dim = new Date(Date.UTC(Number(y), month, 0)).getUTCDate();
  if (day < 1 || day > dim) return null;
  return `${y}-${d}-${mo}`;
}

function usable(d: DobInfo): d is DobInfo & { date: IsoDate } {
  return d.date !== null && d.precision !== 'unknown' && isCalendarIsoDate(d.date);
}

/**
 * DOB evidence. Exactly one of DOB_EQUAL | DOB_SWAPPED | DOB_YEAR_EQUAL | DOB_CONFLICT | DOB_MISSING.
 * - year-only on either side: same year => DOB_YEAR_EQUAL, else DOB_CONFLICT (never DOB_EQUAL).
 * - an 'ambiguous-dm' side whose date equals (or swaps to) the other => DOB_SWAPPED, unless day === month:
 *   an ambiguous text date is not certain, so it can never support an automatic link.
 */
export function compareDob(a: DobInfo, b: DobInfo): MatchEvidence {
  if (!usable(a) || !usable(b)) return 'DOB_MISSING';
  if (a.precision === 'year-only' || b.precision === 'year-only') {
    return a.date.slice(0, 4) === b.date.slice(0, 4) ? 'DOB_YEAR_EQUAL' : 'DOB_CONFLICT';
  }
  const ambiguous = a.precision === 'ambiguous-dm' || b.precision === 'ambiguous-dm';
  if (a.date === b.date) return ambiguous && swapDayMonth(a.date) !== null ? 'DOB_SWAPPED' : 'DOB_EQUAL';
  if (swapDayMonth(a.date) === b.date) return 'DOB_SWAPPED';
  return 'DOB_CONFLICT';
}

/** Dates to look up in the DOB block: the date itself and its day/month swap. */
export function dobLookupDates(d: DobInfo): IsoDate[] {
  if (!usable(d) || d.precision === 'year-only') return [];
  const s = swapDayMonth(d.date);
  return s ? [d.date, s] : [d.date];
}
