import { randomBytes } from 'node:crypto';
import { open, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  BACKUP_HEADER_BYTES,
  bytesSource,
  fileSource,
  openBackup,
  openStream,
  sealBackup,
  sealedLength,
  sealToFile,
} from '../../../src/main/crypto/envelope';
import { CryptoError } from '../../../src/main/crypto/errors';
import { cleanupTempDirs, FAST_KDF, SKIP_SLOW, tempDir } from './helpers';

vi.setConfig({ testTimeout: 120_000 });
afterAll(cleanupTempDirs);

const PASS = 'backup passphrase for tests';
const opts = { kdf: FAST_KDF, chunkSize: 4096 };

async function rejectCode(p: Promise<unknown>): Promise<string> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(CryptoError);
  return (e as CryptoError).code;
}

describe('backup envelope', () => {
  it('round-trips empty, sub-chunk, exact-chunk and multi-chunk payloads', async () => {
    for (const n of [0, 1, 4095, 4096, 4097, 3 * 4096 + 17]) {
      const plain = randomBytes(n);
      const sealed = await sealBackup(plain, PASS, opts);
      expect(sealed.length).toBe(sealedLength(n, 4096));
      expect(sealed.subarray(0, 8).toString('latin1')).toBe('VSSBKUP\0');
      expect((await openBackup(sealed, PASS)).equals(plain)).toBe(true);
    }
  });

  it('two seals of the same data differ (random salt and nonce prefix)', async () => {
    const plain = Buffer.from('same data');
    const a = await sealBackup(plain, PASS, opts);
    const b = await sealBackup(plain, PASS, opts);
    expect(a.equals(b)).toBe(false);
  });

  it('rejects a wrong passphrase', async () => {
    const sealed = await sealBackup(Buffer.from('payload'), PASS, opts);
    expect(await rejectCode(openBackup(sealed, 'not the passphrase'))).toBe('BACKUP_INVALID');
  });

  it('every single corrupted byte is rejected (header and body)', async () => {
    const sealed = await sealBackup(randomBytes(2 * 4096 + 5), PASS, opts);
    // Header fields (except KDF params that would merely change the derived key: still rejected), first/last bytes.
    const positions = [
      0,
      8,
      15,
      47,
      66,
      70,
      77,
      BACKUP_HEADER_BYTES,
      BACKUP_HEADER_BYTES + 4096 + 3,
      sealed.length - 1,
    ];
    for (const pos of positions) {
      const bad = Buffer.from(sealed);
      bad[pos] = (bad[pos] ?? 0) ^ 0x40;
      expect(await rejectCode(openBackup(bad, PASS))).toBe('BACKUP_INVALID');
    }
  });

  it('rejects truncation, extension and chunk reordering', async () => {
    const sealed = await sealBackup(randomBytes(3 * 4096), PASS, opts);
    expect(await rejectCode(openBackup(sealed.subarray(0, sealed.length - 1), PASS))).toBe('BACKUP_INVALID');
    expect(await rejectCode(openBackup(Buffer.concat([sealed, Buffer.alloc(1)]), PASS))).toBe('BACKUP_INVALID');
    const seg = 4096 + 16;
    const h = BACKUP_HEADER_BYTES;
    const swapped = Buffer.concat([
      sealed.subarray(0, h),
      sealed.subarray(h + seg, h + 2 * seg),
      sealed.subarray(h, h + seg),
      sealed.subarray(h + 2 * seg),
    ]);
    expect(await rejectCode(openBackup(swapped, PASS))).toBe('BACKUP_INVALID');
    expect(await rejectCode(openBackup(Buffer.alloc(10), PASS))).toBe('BACKUP_INVALID');
  });

  it('rejects a header asking for excessive Argon2 memory before deriving', async () => {
    const sealed = await sealBackup(Buffer.from('x'), PASS, opts);
    sealed.writeUInt32BE(8 * 1024 * 1024, 9); // 8 GiB
    const s = performance.now();
    expect(await rejectCode(openBackup(sealed, PASS))).toBe('BACKUP_INVALID');
    expect(performance.now() - s).toBeLessThan(1000); // generous for loaded CI; an 8 GiB derivation would fail or take far longer
  });

  it('file streaming: sealToFile + openStream with a bounded chunk buffer', async () => {
    const dir = tempDir();
    const src = join(dir, 'plain.bin');
    const dst = join(dir, 'backup.vssbak');
    const plain = randomBytes(5 * 1024 * 1024 + 123);
    await writeFile(src, plain);
    const fh = await open(src, 'r');
    try {
      const n = await sealToFile(fileSource(fh, plain.length), dst, PASS, { kdf: FAST_KDF });
      expect((await stat(dst)).size).toBe(n);
    } finally {
      await fh.close();
    }
    const out: Buffer[] = [];
    const in2 = await open(dst, 'r');
    try {
      await openStream(
        fileSource(in2, (await stat(dst)).size),
        { write: async (c) => void out.push(Buffer.from(c)) },
        PASS,
      );
    } finally {
      await in2.close();
    }
    expect(Buffer.concat(out).equals(plain)).toBe(true);
    expect(Math.max(...out.map((b) => b.length))).toBeLessThanOrEqual(1024 * 1024);
    expect(await readFile(dst)).not.toContain(plain.subarray(0, 64));
  });

  it('openStream fails on a corrupted later chunk after earlier chunks were emitted (caller must discard)', async () => {
    const sealed = await sealBackup(randomBytes(3 * 4096), PASS, opts);
    sealed[sealed.length - 2] = (sealed[sealed.length - 2] ?? 0) ^ 1;
    let emitted = 0;
    expect(
      await rejectCode(openStream(bytesSource(sealed), { write: async (c) => void (emitted += c.length) }, PASS)),
    ).toBe('BACKUP_INVALID');
    expect(emitted).toBe(2 * 4096);
  });
});

describe.skipIf(SKIP_SLOW)('200 MB payload (slow; VSS_SKIP_SLOW_CRYPTO=1 skips)', () => {
  it('seals and opens 200 MB with input + output buffers only', async () => {
    const plain = Buffer.alloc(200 * 1024 * 1024, 0x61);
    for (let i = 0; i < plain.length; i += 4096) plain[i] = i & 0xff;
    const rssBefore = process.memoryUsage().arrayBuffers;
    const sealed = await sealBackup(plain, PASS, { kdf: FAST_KDF });
    const peakAfterSeal = process.memoryUsage().arrayBuffers;
    // input (200 MB) + output (~200 MB) + small chunk/KDF buffers; well under a third copy.
    expect(peakAfterSeal - rssBefore).toBeLessThan(330 * 1024 * 1024);
    const back = await openBackup(sealed, PASS);
    expect(back.length).toBe(plain.length);
    expect(back.equals(plain)).toBe(true);
  });
});
