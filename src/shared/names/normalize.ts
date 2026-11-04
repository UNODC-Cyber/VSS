/**
 * Name text normalisation. Pure, no Node-only APIs (usable in the renderer).
 *
 * Pipeline for a raw name string:
 *  1. NFKC; strip zero-width characters / BOM / soft hyphen; control characters become spaces.
 *  2. Spaces around '/' are removed ("A / L" -> "A/L"); '.' followed by a Latin letter becomes a space
 *     ("Mohd.Faizal" -> "Mohd Faizal"), any other '.' is dropped ("พ.ต.อ." -> "พตอ").
 *  3. Split on whitespace and commas.
 *  4. Each token is folded by script: Latin (and Latin-containing mixed tokens) = casefold + NFD + strip combining
 *     marks that sit on a Latin base + ø->o ß->ss đ->d (and a few more letters) + drop everything that is not a
 *     letter, digit, '/' or '-'; Thai = NFC + remove tone marks U+0E48-U+0E4B and thanthakhat U+0E4C; other scripts =
 *     NFC + lowercase (lowercase is a no-op for caseless scripts; it makes Cyrillic/Greek case-insensitive).
 * The whole pipeline is iterated to a fixpoint so it is idempotent by construction.
 */
import type { Script } from '../domain/types';

const ZERO_WIDTH = /[\u{200B}-\u{200D}\u{2060}\u{FEFF}\u{00AD}\u{180E}\u{2061}-\u{2064}]/gu;
const CONTROL = /\p{Cc}/gu;
const THAI_TONES = /[\u{0E48}-\u{0E4C}]/gu;

const LETTER_MAP: Readonly<Record<string, string>> = {
  ø: 'o',
  ß: 'ss',
  ẞ: 'ss',
  đ: 'd',
  ð: 'd',
  ł: 'l',
  ı: 'i',
  æ: 'ae',
  œ: 'oe',
  þ: 'th',
  ħ: 'h',
};

const RE_LATIN = /\p{Script=Latin}/u;
const RE_THAI = /\p{Script=Thai}/u;
const RE_KHMER = /\p{Script=Khmer}/u;
const RE_LAO = /\p{Script=Lao}/u;
const RE_MYANMAR = /\p{Script=Myanmar}/u;
const RE_HAN = /\p{Script=Han}/u;
const RE_LETTER = /\p{L}/u;

function charScript(ch: string): Script | null {
  if (!RE_LETTER.test(ch)) return null;
  if (RE_LATIN.test(ch)) return 'Latn';
  if (RE_THAI.test(ch)) return 'Thai';
  if (RE_KHMER.test(ch)) return 'Khmr';
  if (RE_LAO.test(ch)) return 'Laoo';
  if (RE_MYANMAR.test(ch)) return 'Mymr';
  if (RE_HAN.test(ch)) return 'Hani';
  return 'Other';
}

/** Script of one token (letters only; digits/punctuation ignored). No letters => 'Other'. */
export function detectScript(text: string): Script {
  let found: Script | null = null;
  for (const ch of text) {
    const s = charScript(ch);
    if (s === null) continue;
    if (found === null) found = s;
    else if (found !== s) return 'Mixed';
  }
  return found ?? 'Other';
}

/** Script of a whole name: the common script of its tokens, 'Mixed' when they differ, 'Other' when empty. */
export function detectNameScript(tokens: readonly string[]): Script {
  let found: Script | null = null;
  for (const t of tokens) {
    const s = detectScript(t);
    if (s === 'Other' && !RE_LETTER.test(t)) continue;
    if (found === null) found = s;
    else if (found !== s) return 'Mixed';
  }
  return found ?? 'Other';
}

/**
 * Split one word where its letters change between Latin and non-Latin script ("Arkanสมปอง" -> ["Arkan", "สมปอง"]).
 * Marks, digits and punctuation stay with the run they follow, so Thai vowel signs never detach from their consonant.
 * A single-script word comes back unchanged. Total: never throws.
 */
export function splitByScript(word: string): string[] {
  const out: string[] = [];
  let cur = '';
  let curLatin: boolean | null = null;
  for (const ch of word) {
    if (RE_LETTER.test(ch)) {
      const latin = RE_LATIN.test(ch);
      if (curLatin !== null && latin !== curLatin && cur !== '') {
        out.push(cur);
        cur = '';
      }
      curLatin = latin;
    }
    cur += ch;
  }
  if (cur !== '') out.push(cur);
  return out;
}

/** 'latin' / 'non-latin' by the letters of a token; 'none' when it has no letter (digits, punctuation). */
export function tokenScriptClass(token: string): 'latin' | 'non-latin' | 'none' {
  let latin = false;
  let other = false;
  for (const ch of token) {
    if (!RE_LETTER.test(ch)) continue;
    if (RE_LATIN.test(ch)) latin = true;
    else other = true;
  }
  return latin ? 'latin' : other ? 'non-latin' : 'none';
}

/** Step 1-2: Unicode clean-up of a raw string (does not fold case or split). */
export function cleanRaw(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(ZERO_WIDTH, '')
    .replace(CONTROL, ' ')
    .replace(/\s*\/\s*/gu, '/')
    .replace(/\.(?=\p{Script=Latin})/gu, ' ')
    .replace(/\./gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function foldLatinish(token: string): string {
  const lower = token.toLowerCase();
  let mapped = '';
  for (const ch of lower) mapped += LETTER_MAP[ch] ?? ch;
  // Strip combining marks only when they sit on a Latin base (Thai vowel signs are marks too and must survive).
  let out = '';
  let baseIsLatin = false;
  for (const ch of mapped.normalize('NFD')) {
    if (/\p{M}/u.test(ch)) {
      if (!baseIsLatin) out += ch;
      continue;
    }
    baseIsLatin = RE_LATIN.test(ch);
    out += ch;
  }
  out = out.normalize('NFC').replace(THAI_TONES, '');
  // Keep letters, marks (non-Latin vowel signs), digits, '/', '-'. Apostrophes, quotes, brackets go.
  return out.replace(/[^\p{L}\p{M}\p{Nd}/-]/gu, '');
}

function foldThai(token: string): string {
  return token
    .normalize('NFC')
    .replace(THAI_TONES, '')
    .replace(/[^\p{L}\p{M}\p{Nd}/-]/gu, '');
}

function foldOther(token: string): string {
  return token
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{Nd}/-]/gu, '');
}

function trimDashesAndSlashes(t: string): string {
  return t.replace(/^[-/]+|[-/]+$/gu, '').replace(/-{2,}/gu, '-');
}

function foldTokenOnce(token: string): string {
  const script = detectScript(token);
  let f: string;
  if (script === 'Latn' || script === 'Mixed') f = foldLatinish(token);
  else if (script === 'Thai') f = foldThai(token);
  else f = foldOther(token);
  return trimDashesAndSlashes(f);
}

/** Fold one already-split token. Idempotent. */
export function foldToken(token: string): string {
  let cur = token;
  for (let i = 0; i < 4; i++) {
    const next = foldTokenOnce(cleanRaw(cur).replace(/[\s,]+/gu, ''));
    if (next === cur) return next;
    cur = next;
  }
  return cur;
}

/** Raw string -> folded tokens in original order (hyphenated tokens kept joined; empty tokens dropped). */
export function tokenize(raw: string): string[] {
  let tokens = splitOnce(raw);
  // Fixpoint: folding can, in rare Unicode cases, expose new separators.
  for (let i = 0; i < 4; i++) {
    const again = splitOnce(tokens.join(' '));
    if (again.length === tokens.length && again.every((t, k) => t === tokens[k])) return tokens;
    tokens = again;
  }
  return tokens;
}

function splitOnce(raw: string): string[] {
  const cleaned = cleanRaw(raw);
  if (cleaned === '') return [];
  const out: string[] = [];
  for (const part of cleaned.split(/[\s,]+/u)) {
    if (part === '') continue;
    const f = foldToken(part);
    if (f !== '') out.push(f);
  }
  return out;
}

/** Folded, single-spaced name string in original token order. Idempotent: normalizeName(normalizeName(x)) === normalizeName(x). */
export function normalizeName(raw: string): string {
  return tokenize(raw).join(' ');
}

/** Clean display form (NFKC, zero-width stripped, whitespace collapsed) without folding case. */
export function cleanDisplay(raw: string): string {
  return raw.normalize('NFKC').replace(ZERO_WIDTH, '').replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim();
}

const JUNK_IDS = new Set(['NA', 'NIL', 'NONE', 'NULL', 'UNKNOWN', 'TBA', 'TBC', 'NOTAPPLICABLE', 'NOPASSPORT', 'NOID']);

/**
 * Identifier fold: NFKC, uppercase, keep [A-Z0-9]. Returns '' for placeholders ("N/A", "NIL", "-"), values shorter
 * than 4 characters, and values made of a single repeated character ("00000"), so junk never produces ID equality.
 */
export function foldIdentifier(value: string): string {
  const v = cleanDisplay(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/gu, '');
  if (v.length < 4 || JUNK_IDS.has(v) || /^(.)\1*$/u.test(v)) return '';
  return v;
}

/** Unit name fold for equality: NFKC, casefold, diacritics stripped, punctuation dropped, whitespace collapsed. */
export function foldUnitName(value: string): string {
  return tokenize(value).join(' ');
}

/** Country fold: NFKC, uppercase, whitespace collapsed. Empty => ''. */
export function foldCountry(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return cleanDisplay(value).toUpperCase();
}
