import { isCalendarIsoDate } from '@shared/domain/dob';
import type { IsoDate, IsoDateTime, RawDate, RequestStatus, VettingStatus } from '@shared/domain/types';

export function fmtDate(d: IsoDate | null | undefined): string {
  return d ?? '-';
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
const localYmd = (d: Date): IsoDate => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseInstant = (v: IsoDateTime | null | undefined): Date | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** "UTC+7", "UTC-3:30", "UTC" for the computer's offset at that instant (UI review R2O-07). */
export function utcOffsetLabel(at: Date = new Date()): string {
  const off = -at.getTimezoneOffset();
  if (off === 0) return 'UTC';
  const h = Math.floor(Math.abs(off) / 60);
  const m = Math.abs(off) % 60;
  return `UTC${off > 0 ? '+' : '-'}${h}${m ? `:${pad2(m)}` : ''}`;
}
/** The computer's time zone, e.g. "Asia/Bangkok, UTC+7" (the IANA name is left out when the runtime has none). */
export function localZoneLabel(at: Date = new Date()): string {
  let name = '';
  try {
    name = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    name = '';
  }
  const off = utcOffsetLabel(at);
  return name && name !== 'UTC' && name !== 'Etc/UTC' ? `${name}, ${off}` : off;
}

/**
 * A stored instant (UTC ISO-8601) in the computer's local time, "YYYY-MM-DD HH:mm". Every date-time on screen goes
 * through here, so displayed times and the local-time inputs (Mark sent, manual request) always agree. With
 * `zone`, the UTC offset is appended ("2026-11-04 14:31 UTC+7") for places where the zone matters.
 */
export function fmtDateTime(d: IsoDateTime | null | undefined, opts: { zone?: boolean } = {}): string {
  const at = parseInstant(d);
  if (!at) return '-';
  const s = `${localYmd(at)} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  return opts.zone ? `${s} ${utcOffsetLabel(at)}` : s;
}
/** The local calendar day of a stored instant (lists that show only the day, e.g. "Received"). */
export function fmtLocalDate(d: IsoDateTime | null | undefined): string {
  const at = parseInstant(d);
  return at ? localYmd(at) : '-';
}
/** Today in the computer's local calendar (not the UTC day). */
export function todayIso(): IsoDate {
  return localYmd(new Date());
}
export function addDaysIso(d: IsoDate, days: number): IsoDate {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, day + days)).toISOString().slice(0, 10);
}
export function nowLocalInput(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}
export function localInputToIso(v: string): IsoDateTime {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}
export function rawDateText(d: RawDate): string {
  return d.parsed ?? d.value;
}

export const STATUS_COLOR: Record<VettingStatus, string> = {
  unknown: 'gray',
  pending: 'blue',
  approved: 'green',
  expiring: 'orange',
  expired: 'red',
  'non-approved': 'red',
};

export const REQUEST_STATUS_COLOR: Record<RequestStatus, string> = {
  received: 'gray',
  validated: 'gray',
  exported: 'blue',
  'sent-to-dc': 'blue',
  responded: 'cyan',
  finished: 'green',
  closed: 'dark',
  withdrawn: 'red',
};

/** Mask a sensitive value. Keeps the shape (separators) but hides characters. */
export function mask(value: string): string {
  return value.replace(/[A-Za-z0-9]/g, '•');
}

/** Parse 'YYYY-MM-DD' (or D/M/Y, M/D/Y text) into [y,m,d] parts when unambiguous enough to compare. */
export function dobParts(v: string): { y: number; a: number; b: number } | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  // An impossible ISO value (e.g. 1995-20-07) has no day and month to swap: it is shown as invalid instead.
  if (iso) return isCalendarIsoDate(v) ? { y: Number(iso[1]), a: Number(iso[2]), b: Number(iso[3]) } : null; // a=month b=day
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
  if (dmy) return { y: Number(dmy[3]), a: Number(dmy[2]), b: Number(dmy[1]) };
  return null;
}
/** True when two dates are equal except that day and month are swapped. */
export function dobSwapped(x: string, y: string): boolean {
  const p = dobParts(x);
  const q = dobParts(y);
  return !!p && !!q && p.y === q.y && p.a === q.b && p.b === q.a && p.a !== p.b;
}
/** 'D/M' and 'M/D' rendering of an ISO date. */
export function dobBoth(iso: string): { dm: string; md: string } | null {
  const p = dobParts(iso);
  if (!p) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return { dm: `${pad(p.b)}/${pad(p.a)}/${p.y}`, md: `${pad(p.a)}/${pad(p.b)}/${p.y}` };
}
