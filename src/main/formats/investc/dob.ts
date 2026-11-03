import type { IsoDate, RawDate } from '../../../shared/domain/types.ts';
import { formatIso, isValidYmd, serialToIso } from '../ooxml/dates.ts';
import type { Cell } from '../ooxml/sheet.ts';

export interface DobTextParse {
  parsed: IsoDate | null;
  /** Both MM/DD and DD/MM are valid dates and they differ. */
  ambiguous: boolean;
  /** Which reading produced `parsed`. */
  reading: 'mdy' | 'dmy' | 'iso' | null;
}

/** Text dates: ISO first, then MM/DD/YYYY, then DD/MM/YYYY ( / . - accepted as separators, 4-digit years only). */
export function parseDobText(text: string): DobTextParse {
  const t = text.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]);
    const d = Number(iso[3]);
    return isValidYmd(y, m, d)
      ? { parsed: formatIso(y, m, d), ambiguous: false, reading: 'iso' }
      : { parsed: null, ambiguous: false, reading: null };
  }
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (!m) return { parsed: null, ambiguous: false, reading: null };
  const a = Number(m[1]);
  const b = Number(m[2]);
  const y = Number(m[3]);
  const mdy = isValidYmd(y, a, b) ? formatIso(y, a, b) : null;
  const dmy = isValidYmd(y, b, a) ? formatIso(y, b, a) : null;
  if (mdy && dmy) return { parsed: mdy, ambiguous: mdy !== dmy, reading: 'mdy' };
  if (mdy) return { parsed: mdy, ambiguous: false, reading: 'mdy' };
  if (dmy) return { parsed: dmy, ambiguous: false, reading: 'dmy' };
  return { parsed: null, ambiguous: false, reading: null };
}

/** RawDate for a request DOB cell: numeric cells are serials, string cells are text. */
export function rawDateFromRequestCell(cell: Cell | undefined): RawDate {
  if (!cell || cell.kind === 'blank' || cell.text.trim() === '') {
    return { kind: 'empty', value: '', parsed: null, ambiguousDayMonth: false };
  }
  if (cell.kind === 'number' && cell.num !== undefined) {
    return { kind: 'serial', value: cell.text, parsed: serialToIso(cell.num), ambiguousDayMonth: false };
  }
  const p = parseDobText(cell.text);
  return { kind: 'text', value: cell.text, parsed: p.parsed, ambiguousDayMonth: p.ambiguous };
}
