/** PersonName builders for the two source formats. */
import type { PersonName } from '../domain/types';
import { isUnknownSurname } from './key';
import { cleanDisplay, detectNameScript, splitByScript } from './normalize';

function words(s: string): string[] {
  const c = cleanDisplay(s);
  return c === '' ? [] : c.split(' ');
}

/**
 * DC response NAME cell: `SURNAME, Given names` (S-04). Split at the first comma; trim; collapse spaces.
 * A placeholder surname (`UNKNOWN`) becomes ''. With no comma the surname is unknown: surname '' and every word is
 * given, so no surname-based evidence can be produced from a guess.
 */
export function splitDcName(raw: string): PersonName {
  const clean = cleanDisplay(raw);
  const comma = clean.indexOf(',');
  let surname: string;
  let givenPart: string;
  if (comma < 0) {
    surname = '';
    givenPart = clean;
  } else {
    surname = cleanDisplay(clean.slice(0, comma));
    givenPart = clean.slice(comma + 1);
  }
  if (surname !== '' && isUnknownSurname(surname)) surname = '';
  // Given words are split where the script changes (Latin given names followed by the Thai-script ones, S-04).
  const given = words(givenPart.replace(/,/g, ' ')).flatMap(splitByScript);
  return { surname, given, raw, script: detectNameScript([...words(surname), ...given]) };
}

/** INVESTc request row: Surname + Name 1..4 (each may hold several words; empty fields dropped). */
export function personNameFromRequest(surname: string, name1 = '', name2 = '', name3 = '', name4 = ''): PersonName {
  const s = cleanDisplay(surname);
  const given = [name1, name2, name3, name4].map(cleanDisplay).filter((g) => g !== '');
  const raw = [s, ...given].filter((x) => x !== '').join(' ');
  return {
    surname: s,
    given,
    raw,
    script: detectNameScript([...words(s), ...given.flatMap(words)]),
  };
}
