/**
 * Light name helpers used by request validation (R-13, R-14). The full normalisation and matching lives in the
 * identity lane; this is only enough to spot duplicate rows and honorifics inside one workbook.
 */

/** Particles dropped from core name keys (lower case, folded). */
export const NAME_PARTICLES: ReadonlySet<string> = new Set([
  'bin',
  'binti',
  'bte',
  'bt',
  'b',
  'bint',
  'ibn',
  'ben',
  'a/l',
  'a/p',
  's/o',
  'd/o',
  'w/o',
  'al',
  'el',
  'van',
  'von',
  'de',
  'der',
  'den',
  'di',
  'da',
  'du',
  'la',
  'le',
]);

/** Folds a token: NFKC, lower case, Latin diacritics and Thai tone marks removed. */
export function foldToken(t: string): string {
  return t
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-่ͯ-๋]/g, '')
    .replace(/đ/g, 'd')
    .normalize('NFC');
}

export function tokenize(...fields: string[]): string[] {
  const out: string[] = [];
  for (const f of fields) {
    for (const raw of f.split(/[\s,]+/)) {
      const t = foldToken(raw).replace(/^\.+|\.+$/g, '');
      if (t !== '') out.push(t);
    }
  }
  return out;
}

/** Sorted, particle-free token key: equal for names that differ only in order, case, diacritics or particles. */
export function coreKey(...fields: string[]): string {
  return tokenize(...fields)
    .filter((t) => !NAME_PARTICLES.has(t))
    .sort()
    .join(' ');
}

const HONORIFIC =
  /^(?:(?:mr|mrs|ms|miss|mx|dr|prof|col|lt|maj|gen|capt|cpt|sgt|cpl|pvt|insp|supt|dsp|asp|acp|dig|igp|datuk|dato|datin|haji|hajah|mejar|kolonel|leftenan|khun|ajarn)(?:\.|\s|$)|pol\.|police\s)/i;

/** True when a name field starts with an honorific or rank. */
export function startsWithHonorific(field: string): boolean {
  return HONORIFIC.test(field.trim());
}

/** Trim and collapse internal whitespace (R-09 unit-name comparison). */
export function normalizeUnitName(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}
