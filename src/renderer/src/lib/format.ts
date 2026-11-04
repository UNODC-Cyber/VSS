import type { IsoDate, IsoDateTime, RawDate, RequestStatus, VettingStatus } from '@shared/domain/types';

export function fmtDate(d: IsoDate | null | undefined): string {
  return d ?? '-';
}
export function fmtDateTime(d: IsoDateTime | null | undefined): string {
  return d ? `${d.slice(0, 10)} ${d.slice(11, 16)}` : '-';
}
export function todayIso(): IsoDate {
  return new Date().toISOString().slice(0, 10);
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
  if (iso) return { y: Number(iso[1]), a: Number(iso[2]), b: Number(iso[3]) }; // a=month b=day
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

/**
 * Date of birth as shown in previews: an Excel serial (e.g. 35410) becomes ISO `YYYY-MM-DD`; with `mdy` set,
 * `M/D/YYYY` text (the response workbook format) becomes ISO too. Anything else is returned verbatim.
 */
export function dobDisplay(raw: string | null | undefined, mdy = false): string {
  const v = (raw ?? '').trim();
  if (!v) return '';
  if (/^\d{5,6}(\.\d+)?$/.test(v)) {
    const n = Math.floor(Number(v));
    if (n >= 1 && n < 2958466) return new Date(Date.UTC(1899, 11, 30) + n * 86_400_000).toISOString().slice(0, 10);
  }
  const m = mdy ? /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v) : null;
  if (m) {
    const [, mo, d, y] = m as unknown as [string, string, string, string];
    if (Number(mo) >= 1 && Number(mo) <= 12 && Number(d) >= 1 && Number(d) <= 31)
      return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return v;
}
