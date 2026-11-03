import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { canonicalJson } from '../../src/main/crypto/canonical-json';
import { openBackup, sealBackup } from '../../src/main/crypto/envelope';
import type { CryptoError } from '../../src/main/crypto/errors';
import { _resetAllLockoutsForTests } from '../../src/main/crypto/lockout';
import { createVault, hasControlChars, readHeader, unlock } from '../../src/main/crypto/vault';
import { cleanupTempDirs, FAST_KDF, tempDir } from '../unit/crypto/helpers';

vi.setConfig({ testTimeout: 180_000 });

// Printable labels as the vault accepts them (no control characters), 1..128 chars.
const labelArb = fc
  .string({ minLength: 1, maxLength: 64, unit: 'grapheme' })
  .filter((s) => !hasControlChars(s) && s.length <= 128);
const passwordArb = fc.string({ minLength: 1, maxLength: 80, unit: 'grapheme' });

describe('crypto properties', () => {
  it('random passwords and labels round-trip through create/unlock; other passwords fail', async () => {
    await fc.assert(
      fc.asyncProperty(passwordArb, labelArb, passwordArb, async (pw, label, other) => {
        _resetAllLockoutsForTests();
        const dir = tempDir();
        const km = await createVault({ dir, password: pw, label, kdf: FAST_KDF });
        const hex = km.dbKeyHex();
        km.dispose();
        expect(readHeader(dir).slots[0]?.label).toBe(label);
        const km2 = await unlock({ dir, password: pw });
        expect(km2.dbKeyHex()).toBe(hex);
        km2.dispose();
        if (other.normalize('NFC') !== pw.normalize('NFC')) {
          const e = await unlock({ dir, password: other }).catch((x: unknown) => x);
          expect((e as CryptoError).code).toBe('BAD_CREDENTIALS');
        }
      }),
      { numRuns: 6 },
    );
    cleanupTempDirs();
  });

  it('backup envelope round-trips random payloads and passphrases', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 20_000 }), passwordArb, async (data, pass) => {
        const sealed = await sealBackup(data, pass, { kdf: FAST_KDF, chunkSize: 4096 });
        expect(Buffer.from(await openBackup(sealed, pass)).equals(Buffer.from(data))).toBe(true);
      }),
      { numRuns: 6 },
    );
  });

  it('canonicalJson is key-order independent and parses back to the same value', () => {
    fc.assert(
      fc.property(fc.jsonValue({ noUnicodeString: false }), (v) => {
        const s = canonicalJson(v);
        expect(canonicalJson(JSON.parse(s))).toBe(s);
        const reordered = JSON.parse(JSON.stringify(v), function (this: unknown, _k, val: unknown) {
          if (val && typeof val === 'object' && !Array.isArray(val)) {
            return Object.fromEntries(Object.entries(val as Record<string, unknown>).reverse());
          }
          return val;
        }) as unknown;
        expect(canonicalJson(reordered)).toBe(s);
      }),
    );
  });
});
