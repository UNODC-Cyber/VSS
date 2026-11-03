// All names below are synthetic (invented token combinations), never real persons.
import { describe, expect, it } from 'vitest';
import {
  VERIFY_ITEMS,
  buildNameKey,
  cleanRaw,
  coreKeyOf,
  detectNameScript,
  detectScript,
  doubleMetaphone,
  foldIdentifier,
  foldToken,
  isUnknownSurname,
  jaroWinkler,
  normalizeName,
  personNameFromRequest,
  splitDcName,
  surnameCoreTokens,
  tokenSetJaroWinkler,
  tokenize,
} from '../../../src/shared/names';

const ZWSP = String.fromCodePoint(0x200b);
const BOM = String.fromCodePoint(0xfeff);
const THAI_MAI_EK = String.fromCodePoint(0x0e48);
const THAI_THANTHAKHAT = String.fromCodePoint(0x0e4c);

describe('normalisation pipeline', () => {
  it('NFKC, zero-width/BOM strip, whitespace collapse, trim', () => {
    expect(normalizeName(`  ${BOM}Ａｒｋａｎ${ZWSP}   VELLOSO\t\n`)).toBe('arkan velloso');
  });
  it('splits on commas, keeps "/" inside tokens and joins spaced slashes', () => {
    expect(tokenize('VELLOSO, Arkan A / L')).toEqual(['velloso', 'arkan', 'a/l']);
    expect(tokenize('Devi S/O Kumaran')).toEqual(['devi', 's/o', 'kumaran']);
  });
  it('Latin fold: casefold + diacritics + special letters', () => {
    expect(foldToken('ĐẶNG')).toBe('dang');
    expect(foldToken('Søren')).toBe('soren');
    expect(foldToken('Straße')).toBe('strasse');
    expect(foldToken("O'Rourke")).toBe('orourke');
    expect(foldToken('Łukasz')).toBe('lukasz');
  });
  it('dots: before a Latin letter split, otherwise dropped', () => {
    expect(cleanRaw('Mohd.Arkan')).toBe('Mohd Arkan');
    expect(tokenize('Dr. Arkan')).toEqual(['dr', 'arkan']);
    expect(tokenize('พ.ต.อ. สมปอง')).toEqual(['พตอ', 'สมปอง']);
  });
  it('Thai: tone marks and thanthakhat removed, vowels kept', () => {
    expect(foldToken(`ส${THAI_MAI_EK}มปอง`)).toBe('สมปอง');
    expect(foldToken(`กานต${THAI_THANTHAKHAT}`)).toBe('กานต');
    expect(foldToken('ชัยวิทย')).toBe('ชัยวิทย');
  });
  it('script detection per token and per name', () => {
    expect(detectScript('arkan')).toBe('Latn');
    expect(detectScript('สมปอง')).toBe('Thai');
    expect(detectScript('សុខា')).toBe('Khmr');
    expect(detectScript('ສົມພອນ')).toBe('Laoo');
    expect(detectScript('မောင်')).toBe('Mymr');
    expect(detectScript('明华')).toBe('Hani');
    expect(detectScript('arkanสม')).toBe('Mixed');
    expect(detectNameScript(['arkan', 'สมปอง'])).toBe('Mixed');
  });
  it('other scripts are NFC (+ lowercase)', () => {
    expect(foldToken('ИВАНОВА')).toBe('иванова');
    expect(foldToken('សុខា')).toBe('សុខា'.normalize('NFC'));
  });
  it('identifier fold rejects placeholders and short/repeated junk', () => {
    expect(foldIdentifier(' ab-12 345 ')).toBe('AB12345');
    for (const junk of ['N/A', 'nil', '-', '0000000', 'abc', 'NONE']) expect(foldIdentifier(junk)).toBe('');
  });
});

describe('NameKey', () => {
  it('removes honorifics, keeps particles out of core, canonicalises variants', () => {
    const k = buildNameKey('Dr Mohd Arkan bin Velloso');
    expect(k.coreTokens).toEqual(['arkan', 'muhammad', 'velloso']);
    expect(k.particles).toEqual(['bin']);
    expect(k.fullTokens).toEqual(['arkan', 'bin', 'muhammad', 'velloso']);
    expect(k.folded).toContain('mohd');
    expect(k.folded).not.toContain('dr');
  });
  it('variant groups', () => {
    expect(buildNameKey('Md Abd Noor Ahmed').coreTokens).toEqual(['abdul', 'ahmad', 'muhammad', 'nur']);
    expect(buildNameKey('Hj Arkan').particles).toEqual(['haji']);
    expect(buildNameKey('Nurin bte Qasrah').particles).toEqual(['binti']);
  });
  it('ambiguous honorifics become particles (kept in full tokens)', () => {
    const k = buildNameKey('Pol Col Tiravat Phenglom');
    expect(k.coreTokens).toEqual(['phenglom', 'tiravat']);
    expect(k.particles).toEqual(['col', 'pol']);
  });
  it('hyphenated tokens split, joined form in fullTokens only', () => {
    const k = buildNameKey('Arkan Velloso-Diaz');
    expect(k.coreTokens).toEqual(['arkan', 'diaz', 'velloso']);
    expect(k.fullTokens).toContain('vellosodiaz');
  });
  it('an all-particle name keeps its tokens as core', () => {
    const k = buildNameKey('Le Van Do');
    expect(k.coreTokens).toEqual(['do', 'le', 'van']);
    expect(k.particles).toEqual([]);
  });
  it('phonetic codes for Latin core tokens only', () => {
    const k = buildNameKey('Arkan สมปอง');
    expect(k.phonetic).toEqual([doubleMetaphone('arkan')[0]]);
  });
  it('PersonName input ignores placeholder surnames', () => {
    const k = buildNameKey({ surname: 'UNKNOWN', given: ['Arkan'], raw: 'UNKNOWN, Arkan', script: 'Latn' });
    expect(k.coreTokens).toEqual(['arkan']);
    expect(coreKeyOf(buildNameKey('velloso arkan'))).toBe('arkan velloso');
  });
  it('VERIFY list is exposed', () => {
    expect(VERIFY_ITEMS.some((v) => v.startsWith('variant:muhammad'))).toBe(true);
  });
});

describe('PersonName builders', () => {
  it('splitDcName: SURNAME, Given names', () => {
    const n = splitDcName('VELLOSO DIAZ,  ARKAN  BIN  ');
    expect(n.surname).toBe('VELLOSO DIAZ');
    expect(n.given).toEqual(['ARKAN', 'BIN']);
    expect(n.script).toBe('Latn');
    expect(surnameCoreTokens(n)).toEqual(['diaz', 'velloso']);
  });
  it('splitDcName: UNKNOWN commander and no-comma names leave the surname unknown', () => {
    expect(splitDcName('UNKNOWN, TIRAVAT').surname).toBe('');
    expect(splitDcName('TIRAVAT PHENGLOM').surname).toBe('');
    expect(splitDcName('TIRAVAT PHENGLOM').given).toEqual(['TIRAVAT', 'PHENGLOM']);
    expect(isUnknownSurname('FNU')).toBe(true);
  });
  it('personNameFromRequest drops empty fields', () => {
    const n = personNameFromRequest(' Phenglom ', 'Tiravat', '', ' Kesorn  Mali ', '');
    expect(n).toEqual({
      surname: 'Phenglom',
      given: ['Tiravat', 'Kesorn Mali'],
      raw: 'Phenglom Tiravat Kesorn Mali',
      script: 'Latn',
    });
  });
});

describe('Double Metaphone', () => {
  it.each([
    ['Smith', ['SM0', 'XMT']],
    ['Schmidt', ['XMT', 'SMT']],
    ['michael', ['MKL', 'MXL']],
    ['Xavier', ['SF', 'SFR']],
    ['crevalle', ['KRFL', 'KRF']],
    ['Filipowitz', ['FLPT', 'FLPF']],
    ['', ['', '']],
  ])('%s', (w, expected) => {
    expect(doubleMetaphone(w)).toEqual(expected);
  });
});

describe('Jaro-Winkler', () => {
  it('classic values', () => {
    expect(jaroWinkler('martha', 'marhta')).toBeCloseTo(0.9611, 3);
    expect(jaroWinkler('abc', 'abc')).toBe(1);
    expect(jaroWinkler('', 'abc')).toBe(0);
  });
  it('token sets use the best alignment regardless of order', () => {
    expect(tokenSetJaroWinkler(['arkan', 'velloso'], ['veloso', 'arkan'])).toBeGreaterThan(0.95);
    expect(tokenSetJaroWinkler(['a', 'b'], ['b', 'a'])).toBe(1);
    expect(tokenSetJaroWinkler(['arkan'], ['arkan', 'velloso'])).toBe(0.5);
    expect(tokenSetJaroWinkler([], [])).toBe(1);
  });
  it('greedy fallback for large sets stays in [0,1]', () => {
    const a = Array.from({ length: 12 }, (_, i) => `tok${i}`);
    const s = tokenSetJaroWinkler(a, [...a].reverse());
    expect(s).toBe(1);
  });
});
