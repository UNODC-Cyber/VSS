import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildNameKey, normalizeName } from '../../src/shared/names';

const LATIN_BASE = 'abcdefghijklmnopqrstuvwxyz'.split('');
const COMBINING = [0x0300, 0x0301, 0x0302, 0x0303, 0x0308, 0x0323, 0x0327, 0x031b].map((c) => String.fromCodePoint(c));
const THAI_CONSONANTS = 'กขคงจชซญดตถทนบปผพฟมยรลวสหอฮ'.split('');
const THAI_VOWELS = ['ะ', 'า', 'ิ', 'ี', 'ุ', 'ู', 'เ', 'แ', 'โ'];
const THAI_TONES = [0x0e48, 0x0e49, 0x0e4a, 0x0e4b].map((c) => String.fromCodePoint(c));
const THANTHAKHAT = String.fromCodePoint(0x0e4c);
const PARTICLES = ['bin', 'binti', 'a/l', 'a/p', 's/o', 'd/o', 'van', 'de', 'al'];
const NOISE = [' ', '  ', ',', '-', '/', '.', "'", String.fromCodePoint(0x200b), String.fromCodePoint(0xfeff), ' '];

const latinWord = fc.array(fc.constantFrom(...LATIN_BASE), { minLength: 3, maxLength: 9 }).map((cs) => cs.join(''));
/** Synthetic Latin words that are not particles/honorifics/variants (prefix "zq" never occurs in the config lists). */
const plainWord = latinWord.map((w) => `zq${w}`);
const thaiWord = fc
  .array(fc.tuple(fc.constantFrom(...THAI_CONSONANTS), fc.constantFrom('', ...THAI_VOWELS)), {
    minLength: 2,
    maxLength: 5,
  })
  .map((parts) => parts.map(([c, v]) => c + v).join(''));
const anyText = fc
  .array(
    fc.oneof(
      latinWord,
      thaiWord,
      fc.constantFrom(...NOISE, ...COMBINING, ...THAI_TONES, THANTHAKHAT, 'Ø', 'ß', 'Đ', 'ﬁ', 'Ａ', 'İ', 'Mohd', 'A/L'),
    ),
    { maxLength: 12 },
  )
  .map((xs) => xs.join(''));

/** Fisher-Yates driven by fast-check so shrinking works. */
const shuffled = <T>(xs: T[]): fc.Arbitrary<T[]> =>
  fc.array(fc.nat(), { minLength: xs.length, maxLength: xs.length }).map((rs) => {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      const j = (rs[i] ?? 0) % (i + 1);
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  });

describe('name normalisation properties', { timeout: 60_000 }, () => {
  it('normalizeName is idempotent', () => {
    fc.assert(
      fc.property(anyText, (s) => normalizeName(normalizeName(s)) === normalizeName(s)),
      { numRuns: 2000 },
    );
  });

  it('normalizeName is idempotent on arbitrary Unicode', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'grapheme', maxLength: 30 }),
        (s) => normalizeName(normalizeName(s)) === normalizeName(s),
      ),
      { numRuns: 2000 },
    );
  });

  it('buildNameKey(normalizeName(x)) equals buildNameKey(x)', () => {
    fc.assert(
      fc.property(anyText, (s) => {
        expect(buildNameKey(normalizeName(s))).toEqual(buildNameKey(s));
      }),
      { numRuns: 1000 },
    );
  });

  it('token order invariant', () => {
    const tokens = fc.array(fc.oneof(latinWord, thaiWord, fc.constantFrom(...PARTICLES)), {
      minLength: 1,
      maxLength: 6,
    });
    fc.assert(
      fc.property(
        tokens.chain((ts) => fc.tuple(fc.constant(ts), shuffled(ts))),
        ([a, b]) => {
          expect(buildNameKey(b.join(' '))).toEqual(buildNameKey(a.join(' ')));
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('particle position invariant', () => {
    fc.assert(
      fc.property(
        fc.array(plainWord, { minLength: 1, maxLength: 4 }),
        fc.constantFrom(...PARTICLES),
        fc.nat(),
        fc.nat(),
        (words, particle, i, j) => {
          const at = (k: number) => {
            const w = [...words];
            w.splice(k % (w.length + 1), 0, particle);
            return w.join(' ');
          };
          const ka = buildNameKey(at(i));
          expect(buildNameKey(at(j))).toEqual(ka);
          expect(ka.coreTokens).toEqual(buildNameKey(words.join(' ')).coreTokens);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('NFC / NFD / NFKC / NFKD invariant', () => {
    fc.assert(
      fc.property(anyText, (s) => {
        const k = buildNameKey(s.normalize('NFC'));
        for (const f of ['NFD', 'NFKC', 'NFKD'] as const) expect(buildNameKey(s.normalize(f))).toEqual(k);
      }),
      { numRuns: 1000 },
    );
  });

  it('case and Latin diacritic invariant', () => {
    const decorated = fc
      .array(fc.tuple(fc.constantFrom(...LATIN_BASE), fc.constantFrom('', ...COMBINING), fc.boolean()), {
        minLength: 2,
        maxLength: 8,
      })
      .map((cs) => ({
        plain: cs.map(([c]) => c).join(''),
        fancy: cs.map(([c, m, up]) => (up ? c.toUpperCase() : c) + m).join(''),
      }));
    fc.assert(
      fc.property(fc.array(decorated, { minLength: 1, maxLength: 4 }), (ws) => {
        expect(buildNameKey(ws.map((w) => w.fancy).join(' '))).toEqual(buildNameKey(ws.map((w) => w.plain).join(' ')));
      }),
      { numRuns: 1000 },
    );
  });

  it('Thai tone-mark invariant', () => {
    const thaiWithTones = fc
      .array(
        fc.tuple(
          fc.constantFrom(...THAI_CONSONANTS),
          fc.constantFrom('', ...THAI_VOWELS),
          fc.constantFrom('', ...THAI_TONES, THANTHAKHAT),
        ),
        {
          minLength: 2,
          maxLength: 5,
        },
      )
      .map((ps) => ({ plain: ps.map(([c, v]) => c + v).join(''), toned: ps.map(([c, v, t]) => c + t + v).join('') }));
    fc.assert(
      fc.property(fc.array(thaiWithTones, { minLength: 1, maxLength: 3 }), (ws) => {
        expect(buildNameKey(ws.map((w) => w.toned).join(' '))).toEqual(buildNameKey(ws.map((w) => w.plain).join(' ')));
      }),
      { numRuns: 1000 },
    );
  });

  it('every NameKey array is sorted and core is never empty for a non-empty name', () => {
    fc.assert(
      fc.property(anyText, (s) => {
        const k = buildNameKey(s);
        for (const arr of [k.fullTokens, k.coreTokens, k.particles, k.phonetic]) expect([...arr].sort()).toEqual(arr);
        if (normalizeName(s) !== '') expect(k.coreTokens.length).toBeGreaterThan(0);
      }),
      { numRuns: 1000 },
    );
  });
});
