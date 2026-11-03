/**
 * Security review F-08 / F-09: files read from disk cannot make VSS burn unbounded memory or CPU before anything is
 * authenticated or validated.
 * - F-08: KDF parameters in a backup header or a vault slot are capped (m <= 512 MiB, t <= 8, m x t <= 2 GiB-passes;
 *   all slots together <= twice that). A crafted header is refused before any derivation, in milliseconds.
 * - F-09: an .xlsx larger than 20 MiB, a part inflating past 64 MiB, a package past 256 MiB or a part whose
 *   inflated size differs from its header is refused with a clear message; oversized backups are refused before
 *   any key derivation.
 * Synthetic data only.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { openBackup, sealBackup } from '../../src/main/crypto/envelope';
import { isValidKdfParams, KDF_LIMITS } from '../../src/main/crypto/kdf';
import { createVault, parseHeader, vaultFilePath } from '../../src/main/crypto/vault';
import { readZip, ZIP_LIMITS } from '../../src/main/formats/ooxml/zip';
import { parseInvestc } from '../../src/main/formats/investc/parse';
import { VaultService } from '../../src/main/services/vault-service';
import { FAST_KDF } from '../unit/crypto/helpers';
import { makeApp, PW } from '../unit/app/helpers';

vi.setConfig({ testTimeout: 60_000 });
const root = mkdtempSync(join(tmpdir(), 'vss-caps-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const MiB = 1024; // KiB
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};
const kdf = (m: number, t: number) => ({ alg: 'argon2id' as const, v: 19 as const, m, t, p: 1 });

/** Patch the declared uncompressed size of every entry (local header + central directory). */
function patchDeclared(zip: Uint8Array, size: number): Uint8Array {
  const b = Buffer.from(zip);
  for (let i = 0; i + 4 <= b.length; i++) {
    const sig = b.readUInt32LE(i);
    if (sig === 0x04034b50) b.writeUInt32LE(size, i + 22);
    if (sig === 0x02014b50) b.writeUInt32LE(size, i + 24);
  }
  return new Uint8Array(b);
}

describe('F-08 KDF cost ceiling for files read from disk', () => {
  it('the bounds', () => {
    expect(isValidKdfParams(kdf(256 * MiB, 3))).toBe(true); // default
    expect(isValidKdfParams(kdf(512 * MiB, 4))).toBe(true); // at the cost ceiling
    expect(isValidKdfParams(kdf(256 * MiB, 8))).toBe(true);
    expect(isValidKdfParams(kdf(1024 * MiB, 1))).toBe(false); // m > 512 MiB
    expect(isValidKdfParams(kdf(64 * MiB, 9))).toBe(false); // t > 8
    expect(isValidKdfParams(kdf(512 * MiB, 8))).toBe(false); // m x t > 2 GiB-passes
    expect(KDF_LIMITS.maxCost).toBe(2048 * MiB);
  });

  it.each([
    [1024 * MiB, 16],
    [512 * MiB, 8],
    [512 * MiB, 5],
  ])('a backup header asking for m=%i KiB, t=%i is refused before any derivation', async (m, t) => {
    const sealed = Buffer.from(await sealBackup(new Uint8Array(1000), 'backup-pass-123', { kdf: FAST_KDF }));
    sealed.writeUInt32BE(m, 9);
    sealed.writeUInt8(t, 13);
    const t0 = performance.now();
    expect(await code(openBackup(sealed, 'backup-pass-123'))).toBe('BACKUP_INVALID');
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('a vault slot over the ceiling, or eight slots that together exceed it, is VAULT_CORRUPT on parse', async () => {
    const dir = mkdtempSync(join(root, 'v-'));
    (await createVault({ dir, password: 'correct-password-1', kdf: FAST_KDF })).dispose();
    const h = JSON.parse(readFileSync(vaultFilePath(dir), 'utf8'));
    const big = { ...h, slots: [{ ...h.slots[0], kdf: kdf(1024 * MiB, 16) }] };
    expect(() => parseHeader(JSON.stringify(big))).toThrow(expect.objectContaining({ code: 'VAULT_CORRUPT' }));
    const many = {
      ...h,
      slots: Array.from({ length: 8 }, (_, i) => ({
        ...h.slots[0],
        id: randomBytes(16).toString('hex'),
        label: `slot ${i}`,
        kdf: kdf(256 * MiB, 8),
      })),
    };
    expect(() => parseHeader(JSON.stringify(many))).toThrow(expect.objectContaining({ code: 'VAULT_CORRUPT' }));
  });
});

describe('F-09 input and decompression caps', () => {
  it('an .xlsx larger than 20 MiB is refused without unzipping', () => {
    const big = new Uint8Array(ZIP_LIMITS.maxInputBytes + 1);
    expect(() => readZip(big)).toThrow(/larger than 20 MiB/);
  });

  it('a part declaring more than 64 MiB is refused before inflating', () => {
    const z = patchDeclared(zipSync({ 'xl/worksheets/sheet1.xml': new Uint8Array(1000).fill(65) }), 65 * 1024 * 1024);
    expect(() => readZip(z)).toThrow(/more than 64 MiB/);
  });

  it('parts adding up to more than 256 MiB are refused', () => {
    const parts: Record<string, Uint8Array> = {};
    for (let i = 0; i < 5; i++) parts[`p${i}.xml`] = new Uint8Array(100).fill(66);
    const z = patchDeclared(zipSync(parts), 60 * 1024 * 1024);
    expect(() => readZip(z)).toThrow(/more than 256 MiB/);
  });

  it('a part whose inflated size differs from its declared size is refused', () => {
    const z = patchDeclared(zipSync({ 'a.xml': new Uint8Array(1000).fill(65) }), 2000);
    expect(() => readZip(z)).toThrow(/declared size/);
  });

  it('the parser turns the refusal into a clear validation error', () => {
    const r = parseInvestc(new Uint8Array(ZIP_LIMITS.maxInputBytes + 1));
    expect(r.issues.some((i) => i.severity === 'error' && /larger than 20 MiB/.test(i.message))).toBe(true);
  });

  it('importing a file over 20 MiB through IPC is refused before it is read', async () => {
    const t = await makeApp();
    try {
      expect((await t.call('vault', 'create', { password: PW, displayName: 'x' })).ok).toBe(true);
      const big = join(t.root, 'big.xlsx');
      writeFileSync(big, Buffer.alloc(ZIP_LIMITS.maxInputBytes + 1));
      const r = await t.call('requests', 'importPreview', { path: await t.pickOpen(big, 'request-xlsx') });
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('FILE_INVALID');
      expect(r.error.message).toMatch(/larger than 20 MiB/);
    } finally {
      t.cleanup();
    }
  });

  it('a backup over the size cap is refused before any key derivation', async () => {
    const db = { open() {}, close() {}, vacuumInto() {}, rekey() {}, probe: () => false };
    const svc = new VaultService({ db, kdf: FAST_KDF, backupKdf: FAST_KDF, maxBackupBytes: 1024 });
    const src = join(root, 'huge.vssbak');
    writeFileSync(src, Buffer.alloc(2048));
    const r = await svc.restore({ srcPath: src, passphrase: 'x'.repeat(12), destDirectory: join(root, 'dest') });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('BACKUP_INVALID');
      expect(r.error.message).toMatch(/larger than/);
    }
  });
});
