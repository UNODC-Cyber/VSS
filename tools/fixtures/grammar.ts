/**
 * Seeded PRNG and per-culture syllable grammars for SYNTHETIC names and places. Nothing here is derived from real
 * data: words are random syllable strings, so a chance resemblance to a real person is coincidence.
 */
import { startsWithHonorific } from '../../src/main/formats/investc/names.ts';

export type Rng = () => number;

/** FNV-1a 32-bit hash of a string, used to turn a seed label into a PRNG state. */
export function hashSeed(label: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: small, fast, deterministic across platforms (pure 32-bit integer arithmetic). */
export function createRng(seed: string | number): Rng {
  let a = typeof seed === 'string' ? hashSeed(seed) : seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const int = (rng: Rng, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
export const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)] as T;
export const chance = (rng: Rng, p: number): boolean => rng() < p;

export type Culture = 'malay' | 'tamil-my' | 'thai' | 'thai-script' | 'lao' | 'khmer' | 'vietnamese' | 'western';

interface Syl {
  onsets: readonly string[];
  vowels: readonly string[];
  codas: readonly string[];
}

const GRAMMARS: Record<Exclude<Culture, 'thai-script'>, Syl> = {
  malay: {
    onsets: ['b', 'd', 'h', 'j', 'k', 'l', 'm', 'n', 'r', 's', 't', 'z', 'f', 'sh', 'kh', 'w', 'y', 'f'],
    vowels: ['a', 'i', 'u', 'e', 'o', 'ai', 'a', 'i'],
    codas: ['', '', '', 'n', 'm', 'r', 'l', 'k', 'h', 's', 'd'],
  },
  'tamil-my': {
    onsets: ['k', 's', 'r', 'm', 'v', 'g', 'p', 't', 'th', 'n', 'l', 'd', 'b', 'sh'],
    vowels: ['a', 'i', 'u', 'e', 'o', 'aa', 'ee', 'a'],
    codas: ['', '', 'n', 'm', 'sh', 'r', 'l', 'k', 'th'],
  },
  thai: {
    onsets: ['s', 'k', 'ch', 'th', 'p', 'n', 'w', 'm', 'b', 'ph', 'r', 't', 'j', 'l', 'y', 'kh'],
    vowels: ['a', 'o', 'i', 'u', 'ai', 'ao', 'ia', 'ua', 'oe', 'ee', 'aa', 'am'],
    codas: ['', '', 'n', 'ng', 'm', 't', 'k', 'p'],
  },
  lao: {
    onsets: ['s', 'k', 'v', 'ph', 'th', 'b', 'm', 'n', 'l', 'x', 'kh', 'h', 'd', 'p', 'ng', 'ny'],
    vowels: ['a', 'ai', 'ao', 'ou', 'ay', 'ia', 'oua', 'e', 'i', 'o', 'u'],
    codas: ['', '', 'n', 'ng', 'm', 't', 'k', 'p'],
  },
  khmer: {
    onsets: ['ch', 'k', 's', 'sr', 'p', 'pr', 'th', 'v', 'm', 'n', 'l', 'r', 'kh', 't', 'b', 'ph'],
    vowels: ['a', 'ea', 'ei', 'o', 'u', 'oun', 'ay', 'ey', 'ou', 'eu', 'oe'],
    codas: ['', '', 'n', 'm', 'ng', 't', 'r', 'k', 'h'],
  },
  vietnamese: {
    onsets: [
      'Ph',
      'Tr',
      'Th',
      'Kh',
      'L',
      'H',
      'Qu',
      'Ng',
      'Nh',
      'D',
      'C',
      'B',
      'M',
      'Đ',
      'V',
      'X',
      'G',
      'T',
      'S',
      'N',
    ].map((s) => s.toLowerCase()),
    vowels: ['a', 'ă', 'â', 'e', 'ê', 'i', 'o', 'ô', 'ơ', 'u', 'ư', 'ạ', 'ế', 'ề', 'ộ', 'ữ', 'ả', 'ý', 'ồ', 'ắ'],
    codas: ['', '', 'n', 'ng', 'm', 'nh', 'c', 't', 'p', 'ch'],
  },
  western: {
    onsets: [
      'b',
      'br',
      'c',
      'd',
      'f',
      'g',
      'h',
      'j',
      'k',
      'l',
      'm',
      'n',
      'p',
      'r',
      's',
      'st',
      't',
      'tr',
      'v',
      'w',
      'z',
    ],
    vowels: ['a', 'e', 'i', 'o', 'u', 'ae', 'ea', 'ou', 'y', 'é', 'ü', 'a', 'e', 'o'],
    codas: ['', 'n', 'r', 'l', 's', 't', 'd', 'm', 'ck', 'ne', 'ra'],
  },
};

const cap = (s: string): string => (s === '' ? s : s[0]!.toUpperCase() + s.slice(1));

function word(rng: Rng, g: Syl, syllables: number): string {
  let w = '';
  for (let i = 0; i < syllables; i++) {
    const last = i === syllables - 1;
    w += pick(rng, g.onsets) + pick(rng, g.vowels) + (last || chance(rng, 0.2) ? pick(rng, g.codas) : '');
  }
  return cap(w).normalize('NFC');
}

// ---- Thai script -------------------------------------------------------------------------------------------------
const TH_ONSET = [...'กขคงจชซดตทนบปพฟมยรลวสหอ'];
const TH_FINAL = [...'นมงยวกดบ'];
const TH_TONE = ['่', '้'];
type ThaiPattern = (c: string, f: string, t: string) => string;
const TH_PATTERNS: readonly ThaiPattern[] = [
  (c) => `${c}ะ`,
  (c) => `${c}า`,
  (c) => `${c}ิ`,
  (c) => `${c}ี`,
  (c) => `${c}ุ`,
  (c) => `${c}ู`,
  (c) => `เ${c}`,
  (c) => `แ${c}`,
  (c) => `โ${c}`,
  (c) => `ไ${c}`,
  (c, f) => `${c}ั${f}`,
  (c, f) => `${c}${f}`,
  (c, _f, t) => `${c}${t}า`,
  (c, f) => `${c}า${f}`,
];

function thaiWord(rng: Rng, syllables: number): string {
  let w = '';
  for (let i = 0; i < syllables; i++) {
    w += pick(rng, TH_PATTERNS)(pick(rng, TH_ONSET), pick(rng, TH_FINAL), pick(rng, TH_TONE));
  }
  return w.normalize('NFC');
}

export interface PlaceNames {
  city: string;
  state: string;
}

const COUNTRY: Record<Culture, readonly string[]> = {
  malay: ['MALAYSIA'],
  'tamil-my': ['MALAYSIA'],
  thai: ['THAILAND'],
  'thai-script': ['THAILAND'],
  lao: ['LAOS'],
  khmer: ['CAMBODIA'],
  vietnamese: ['VIETNAM'],
  western: ['UNITED KINGDOM', 'AUSTRALIA', 'CANADA', 'NEW ZEALAND'],
};

export const cultureCountry = (c: Culture, rng: Rng): string => pick(rng, COUNTRY[c]);

const grammarOf = (c: Culture): Syl => GRAMMARS[c === 'thai-script' ? 'thai' : c];

/** A pseudo word of the culture, rejected if it would read as an honorific (R-14). */
export function genWord(rng: Rng, culture: Culture, syllables: number): string {
  for (;;) {
    const w = culture === 'thai-script' ? thaiWord(rng, syllables) : word(rng, grammarOf(culture), syllables);
    if (!startsWithHonorific(w)) return w;
  }
}

export function genPlace(rng: Rng, culture: Culture): PlaceNames {
  return {
    city: genWord(rng, culture === 'thai-script' ? 'thai' : culture, int(rng, 2, 3)),
    state: genWord(rng, culture === 'thai-script' ? 'thai' : culture, int(rng, 2, 3)),
  };
}

export interface GenName {
  surname: string;
  /** Name 1..4 slots, in order, no trailing blanks. */
  names: string[];
  sex: 'M' | 'F';
}

/**
 * A synthetic name laid out the way INVESTc carries it (Surname + Name1..4):
 * Malay `Given [Given2] bin|binti Patronym` (patronym in Surname), Tamil-Malaysian `Given a/l|a/p Father`,
 * Vietnamese `Family Middle Given`, others `Family` + given names.
 */
export function genName(rng: Rng, culture: Culture, sex: 'M' | 'F' = chance(rng, 0.5) ? 'M' : 'F'): GenName {
  switch (culture) {
    case 'malay': {
      const given = [genWord(rng, 'malay', 2)];
      if (chance(rng, 0.4)) given.push(genWord(rng, 'malay', 2));
      return { surname: genWord(rng, 'malay', 2), names: [...given, sex === 'M' ? 'bin' : 'binti'], sex };
    }
    case 'tamil-my':
      return {
        surname: genWord(rng, 'tamil-my', 3),
        names: [genWord(rng, 'tamil-my', 2), sex === 'M' ? 'a/l' : 'a/p'],
        sex,
      };
    case 'vietnamese':
      return {
        surname: genWord(rng, 'vietnamese', 1),
        names: [genWord(rng, 'vietnamese', 1), genWord(rng, 'vietnamese', 1)],
        sex,
      };
    case 'thai':
      return { surname: genWord(rng, 'thai', int(rng, 3, 4)), names: [genWord(rng, 'thai', 2)], sex };
    case 'thai-script':
      return { surname: genWord(rng, 'thai-script', int(rng, 3, 4)), names: [genWord(rng, 'thai-script', 2)], sex };
    case 'lao':
      return { surname: genWord(rng, 'lao', 2), names: [genWord(rng, 'lao', 2)], sex };
    case 'khmer': {
      const names = [genWord(rng, 'khmer', 2)];
      if (chance(rng, 0.3)) names.push(genWord(rng, 'khmer', 1));
      return { surname: genWord(rng, 'khmer', 2), names, sex };
    }
    case 'western': {
      const names = [genWord(rng, 'western', 2)];
      if (chance(rng, 0.35)) names.push(genWord(rng, 'western', 2));
      return { surname: genWord(rng, 'western', 2), names, sex };
    }
  }
}
