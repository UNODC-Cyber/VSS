import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalize, parseCanonical } from '../../../src/main/update/canonical';
import { compareSemver, isUpgrade, parseSemver } from '../../../src/main/update/semver';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('canonicalize', () => {
  it('sorts keys recursively and strips whitespace', () => {
    expect(canonicalize({ b: 1, a: [true, null, { d: 'x', c: 2 }] })).toBe('{"a":[true,null,{"c":2,"d":"x"}],"b":1}');
  });
  it('rejects non-integers, undefined and non-plain objects', () => {
    expect(() => canonicalize({ a: 1.5 })).toThrow();
    expect(() => canonicalize({ a: undefined })).toThrow();
    expect(() => canonicalize(new Date())).toThrow();
    expect(() => canonicalize(Number.NaN)).toThrow();
  });
  it('parseCanonical accepts only exact canonical bytes', () => {
    expect(parseCanonical(enc('{"a":1,"b":2}'))).toEqual({ value: { a: 1, b: 2 } });
    expect(parseCanonical(enc('null'))).toEqual({ value: null });
    expect(parseCanonical(enc('{"b":2,"a":1}'))).toBeNull();
    expect(parseCanonical(enc('{"a": 1}'))).toBeNull();
    expect(parseCanonical(enc('{"a":1,"a":2}'))).toBeNull();
    expect(parseCanonical(enc('{"a":1}\n'))).toBeNull();
    expect(parseCanonical(new Uint8Array([0xff, 0xfe]))).toBeNull();
  });
  it('round-trips arbitrary JSON values', () => {
    const json = fc.letrec((tie) => ({
      v: fc.oneof(
        { depthSize: 'small' },
        fc.constant(null),
        fc.boolean(),
        fc.integer(),
        fc.string(),
        fc.array(tie('v'), { maxLength: 4 }),
        fc.dictionary(fc.string(), tie('v'), { maxKeys: 4 }),
      ),
    })).v;
    fc.assert(
      fc.property(json, (v) => {
        const text = canonicalize(v);
        expect(canonicalize(JSON.parse(text))).toBe(text);
        expect(parseCanonical(enc(text))).not.toBeNull();
      }),
    );
  });
});

describe('semver', () => {
  it('parses strictly', () => {
    expect(parseSemver('1.2.3')).not.toBeNull();
    expect(parseSemver('1.2.3-rc.1+build.5')).not.toBeNull();
    for (const bad of ['v1.2.3', '1.2', '01.2.3', '1.2.3-', '1.2.3-01', ' 1.2.3', '1.2.3.4', '']) {
      expect(parseSemver(bad)).toBeNull();
    }
  });
  it('follows SemVer 2.0.0 precedence', () => {
    const order = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1',
      '1.1.0',
      '2.0.0',
      '10.0.0',
    ];
    for (let i = 0; i < order.length - 1; i++) {
      expect(compareSemver(parseSemver(order[i]!)!, parseSemver(order[i + 1]!)!)).toBe(-1);
      expect(compareSemver(parseSemver(order[i + 1]!)!, parseSemver(order[i]!)!)).toBe(1);
    }
    expect(compareSemver(parseSemver('1.0.0+a')!, parseSemver('1.0.0+b')!)).toBe(0);
  });
  it('isUpgrade ignores prereleases unless allowed and refuses equal/older', () => {
    expect(isUpgrade('1.1.0', '1.0.0')).toBe(true);
    expect(isUpgrade('1.0.0', '1.0.0')).toBe(false);
    expect(isUpgrade('0.9.9', '1.0.0')).toBe(false);
    expect(isUpgrade('1.1.0-rc.1', '1.0.0')).toBe(false);
    expect(isUpgrade('1.1.0-rc.1', '1.0.0', { allowPrerelease: true })).toBe(true);
    expect(isUpgrade('garbage', '1.0.0')).toBe(false);
    expect(isUpgrade('99999999999999999999.0.0', '1.0.0')).toBe(true);
  });
});
