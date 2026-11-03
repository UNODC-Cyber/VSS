/** Known-answer tests against published vectors. */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { aesGcmOpen, aesGcmSeal } from '../../../src/main/crypto/aead';
import { argon2idRaw, hkdf, hkdfSha512 } from '../../../src/main/crypto/kdf';

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

describe('HKDF (RFC 5869 Appendix A, SHA-256 vectors)', () => {
  it('test case 1', () => {
    const okm = hkdf(
      'sha256',
      hex('0b'.repeat(22)),
      hex('000102030405060708090a0b0c'),
      hex('f0f1f2f3f4f5f6f7f8f9'),
      42,
    );
    expect(okm.toString('hex')).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });
  it('test case 3 (empty salt and info)', () => {
    const okm = hkdf('sha256', hex('0b'.repeat(22)), Buffer.alloc(0), Buffer.alloc(0), 42);
    expect(okm.toString('hex')).toBe(
      '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8',
    );
  });
  it('HKDF-SHA-512 matches an independent extract/expand built from HMAC-SHA-512', () => {
    // RFC 5869 publishes no SHA-512 vectors; cross-check against the RFC definition instead.
    const ikm = hex('0b'.repeat(22));
    const salt = hex('000102030405060708090a0b0c');
    const info = 'vss-kek-v1';
    const prk = createHmac('sha512', salt).update(ikm).digest();
    let t = Buffer.alloc(0);
    let okm = Buffer.alloc(0);
    for (let i = 1; okm.length < 80; i++) {
      t = createHmac('sha512', prk)
        .update(Buffer.concat([t, Buffer.from(info), Buffer.from([i])]))
        .digest();
      okm = Buffer.concat([okm, t]);
    }
    expect(hkdfSha512(ikm, salt, info, 80).equals(okm.subarray(0, 80))).toBe(true);
  });
});

describe('AES-256-GCM (McGrew & Viega GCM spec, test cases 13 and 14)', () => {
  const key = Buffer.alloc(32);
  const iv = Buffer.alloc(12);
  it('test case 13: empty plaintext', () => {
    expect(aesGcmSeal(key, iv, Buffer.alloc(0), Buffer.alloc(0)).toString('hex')).toBe(
      '530f8afbc74536b9a963b4f1c4cb738b',
    );
  });
  it('test case 14: one zero block', () => {
    const sealed = aesGcmSeal(key, iv, Buffer.alloc(16), Buffer.alloc(0));
    expect(sealed.toString('hex')).toBe('cea7403d4d606b6e074ec5d3baf39d18' + 'd0d1c8a799996bf0265b98b5d48ab919');
    expect(aesGcmOpen(key, iv, sealed, Buffer.alloc(0))?.equals(Buffer.alloc(16))).toBe(true);
  });
  it('rejects a modified tag, ciphertext or AAD', () => {
    const sealed = aesGcmSeal(key, iv, Buffer.alloc(16), Buffer.from('aad'));
    for (const i of [0, 15, 16, 31]) {
      const bad = Buffer.from(sealed);
      bad[i] = (bad[i] ?? 0) ^ 1;
      expect(aesGcmOpen(key, iv, bad, Buffer.from('aad'))).toBeNull();
    }
    expect(aesGcmOpen(key, iv, sealed, Buffer.from('aae'))).toBeNull();
  });
});

describe('Argon2id v1.3 (reference implementation phc-winner-argon2 test vectors)', () => {
  const pw = Buffer.from('password');
  const salt = Buffer.from('somesalt');
  it('t=2, m=2^16, p=1', async () => {
    const h = await argon2idRaw({ password: pw, salt, t: 2, m: 1 << 16, p: 1, length: 32 });
    expect(h.toString('hex')).toBe('09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7');
  });
  it('t=1, m=2^16, p=1', async () => {
    const h = await argon2idRaw({ password: pw, salt, t: 1, m: 1 << 16, p: 1, length: 32 });
    expect(h.toString('hex')).toBe('f6a5adc1ba723dddef9b5ac1d464e180fcd9dffc9d1cbf76cca2fed795d9ca98');
  });
  it('t=2, m=2^8, p=1 and p=2', async () => {
    const h1 = await argon2idRaw({ password: pw, salt, t: 2, m: 1 << 8, p: 1, length: 32 });
    expect(h1.toString('hex')).toBe('9dfeb910e80bad0311fee20f9c0e2b12c17987b4cac90c2ef54d5b3021c68bfe');
    const h2 = await argon2idRaw({ password: pw, salt, t: 2, m: 1 << 8, p: 2, length: 32 });
    expect(h2.toString('hex')).toBe('6d093c501fd5999645e0ea3bf620d7b8be7fd2db59c20d9fff9539da2bf57037');
  });
});
