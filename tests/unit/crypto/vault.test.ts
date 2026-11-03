import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CryptoError } from '../../../src/main/crypto/errors';
import { autoTune, KDF_LIMITS } from '../../../src/main/crypto/kdf';
import { _resetAllLockoutsForTests, backoffDelayMs } from '../../../src/main/crypto/lockout';
import {
  changePassword,
  createVault,
  KeyMaterial,
  lockoutStatus,
  pendingRotationPath,
  readHeader,
  rotateDek,
  unlock,
  vaultFilePath,
} from '../../../src/main/crypto/vault';
import { isZeroed } from '../../../src/main/crypto/zeroize';
import { cleanupTempDirs, FAST_KDF, flipB64, PW, readJson, SKIP_SLOW, tempDir, writeJson } from './helpers';

vi.setConfig({ testTimeout: 60_000 });
afterAll(cleanupTempDirs);
beforeEach(() => _resetAllLockoutsForTests());

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    expect(e).toBeInstanceOf(CryptoError);
    return (e as CryptoError).code;
  }
}

async function freshVault() {
  const dir = tempDir();
  const km = await createVault({ dir, password: PW, kdf: FAST_KDF });
  const dekHex = km.dbKeyHex();
  km.dispose();
  return { dir, dekHex };
}

type Slot = Record<string, unknown> & { wrap: Record<string, string>; kdf: Record<string, unknown> };
const slotsOf = (j: Record<string, unknown>) => j.slots as Slot[];
const firstSlot = (j: Record<string, unknown>) => slotsOf(j)[0] as Slot;

describe('vault create / unlock', () => {
  it('creates vault.json with one password slot and unlocks to the same DEK', async () => {
    const { dir, dekHex } = await freshVault();
    const h = readHeader(dir);
    expect(h.version).toBe(1);
    expect(h.slots).toHaveLength(1);
    expect(h.slots[0]?.type).toBe('password');
    expect(h.slots[0]?.kdf).toEqual(FAST_KDF);
    expect(readFileSync(vaultFilePath(dir), 'utf8')).not.toContain(dekHex);
    const km = await unlock({ dir, password: PW });
    expect(km.dbKeyHex()).toBe(dekHex);
    expect(km.dbKeyHex()).toMatch(/^[0-9a-f]{64}$/);
    km.dispose();
  });

  it('refuses to create over an existing vault', async () => {
    const { dir } = await freshVault();
    expect(await code(createVault({ dir, password: PW, kdf: FAST_KDF }))).toBe('VAULT_EXISTS');
  });

  it('rejects KDF parameters below the 64 MiB floor at creation', async () => {
    const dir = tempDir();
    expect(await code(createVault({ dir, password: PW, kdf: { ...FAST_KDF, m: 32 * 1024 } }))).toBe('BAD_REQUEST');
  });

  it('wrong, empty and near-miss passwords all fail with the same generic error', async () => {
    const { dir } = await freshVault();
    const errors: unknown[] = [];
    for (const pw of ['wrong', '', `${PW} `]) {
      try {
        await unlock({ dir, password: pw });
      } catch (e) {
        errors.push(e);
      }
      _resetAllLockoutsForTests();
      const j = readJson(vaultFilePath(dir));
      writeJson(vaultFilePath(dir), { ...j, failedAttempts: 0, lastFailureAt: null });
    }
    expect(errors).toHaveLength(3);
    for (const e of errors) {
      expect(e).toBeInstanceOf(CryptoError);
      expect((e as CryptoError).code).toBe('BAD_CREDENTIALS');
      expect((e as CryptoError).message).toBe('Unlock failed');
    }
  });

  it('NFC/NFD forms of the same password unlock the same vault', async () => {
    const dir = tempDir();
    const nfc = 'Cáfe-pässwörd-ทดสอบ'.normalize('NFC');
    (await createVault({ dir, password: nfc, kdf: FAST_KDF })).dispose();
    const km = await unlock({ dir, password: nfc.normalize('NFD') });
    km.dispose();
  });

  it('missing vault => VAULT_NOT_FOUND', async () => {
    expect(await code(unlock({ dir: tempDir(), password: PW }))).toBe('VAULT_NOT_FOUND');
  });
});

describe('tamper detection', () => {
  const cases: [string, (j: Record<string, unknown>) => void, string][] = [
    ['vault createdAt (MAC only)', (j) => void (j.createdAt = '2001-01-01T00:00:00.000Z'), 'VAULT_TAMPERED'],
    ['headerMac', (j) => void (j.headerMac = flipB64(j.headerMac as string, 5)), 'VAULT_TAMPERED'],
    [
      'injected extra slot',
      (j) => {
        const s = firstSlot(j);
        j.slots = [{ ...s, id: 'f'.repeat(32) }, s];
      },
      'VAULT_TAMPERED',
    ],
    ['vaultId', (j) => void (j.vaultId = 'a'.repeat(32)), 'BAD_CREDENTIALS'],
    ['slot label', (j) => void (firstSlot(j).label = 'Other'), 'BAD_CREDENTIALS'],
    ['slot createdAt', (j) => void (firstSlot(j).createdAt = '2001-01-01T00:00:00.000Z'), 'BAD_CREDENTIALS'],
    ['slot salt', (j) => void (firstSlot(j).salt = flipB64(firstSlot(j).salt as string, 3)), 'BAD_CREDENTIALS'],
    ['slot kdf params', (j) => void (firstSlot(j).kdf.t = 2), 'BAD_CREDENTIALS'],
    [
      'wrapped DEK ciphertext',
      (j) => void (firstSlot(j).wrap.ct = flipB64(firstSlot(j).wrap.ct as string, 0)),
      'BAD_CREDENTIALS',
    ],
    [
      'wrapped DEK tag',
      (j) => void (firstSlot(j).wrap.ct = flipB64(firstSlot(j).wrap.ct as string, 47)),
      'BAD_CREDENTIALS',
    ],
    ['wrap iv', (j) => void (firstSlot(j).wrap.iv = flipB64(firstSlot(j).wrap.iv as string, 0)), 'BAD_CREDENTIALS'],
    ['unknown slot type', (j) => void (firstSlot(j).type = 'fido2-prf'), 'VAULT_CORRUPT'],
    ['unknown top-level field', (j) => void (j.extra = 1), 'VAULT_CORRUPT'],
    ['non-canonical base64', (j) => void (firstSlot(j).salt = `${firstSlot(j).salt as string}\n`), 'VAULT_CORRUPT'],
    ['oversized KDF memory (DoS guard)', (j) => void (firstSlot(j).kdf.m = 4 * 1024 * 1024), 'VAULT_CORRUPT'],
    ['version', (j) => void (j.version = 2), 'VAULT_CORRUPT'],
  ];
  for (const [name, mutate, expected] of cases) {
    it(`${name} => ${expected}`, async () => {
      const { dir } = await freshVault();
      const j = readJson(vaultFilePath(dir));
      mutate(j);
      writeJson(vaultFilePath(dir), j);
      expect(await code(unlock({ dir, password: PW }))).toBe(expected);
    });
  }

  it('garbage vault.json => VAULT_CORRUPT', async () => {
    const { dir } = await freshVault();
    writeJson(vaultFilePath(dir), 'not a header');
    expect(await code(unlock({ dir, password: PW }))).toBe('VAULT_CORRUPT');
  });

  it('the failure counter is not MAC-critical', async () => {
    const { dir } = await freshVault();
    const j = readJson(vaultFilePath(dir));
    writeJson(vaultFilePath(dir), { ...j, failedAttempts: 1, lastFailureAt: '2020-01-01T00:00:00.000Z' });
    (await unlock({ dir, password: PW })).dispose();
    expect(readHeader(dir).failedAttempts).toBe(0);
  });
});

describe('lockout back-off', () => {
  it('schedule: 2 free failures, then 1 s doubling, capped at 15 min', () => {
    expect([0, 1, 2, 3, 4, 5].map(backoffDelayMs)).toEqual([0, 0, 0, 1000, 2000, 4000]);
    expect(backoffDelayMs(100)).toBe(15 * 60 * 1000);
  });

  it('enforces the delay, persists the count across restarts and resets on success', async () => {
    const { dir } = await freshVault();
    let t = 1_000_000;
    const now = () => t;
    for (let i = 0; i < 3; i++) expect(await code(unlock({ dir, password: 'nope', now }))).toBe('BAD_CREDENTIALS');
    expect(readHeader(dir).failedAttempts).toBe(3);
    // Locked out now, even with the right password.
    const e = await unlock({ dir, password: PW, now }).catch((x: unknown) => x);
    expect((e as CryptoError).code).toBe('RATE_LIMITED');
    expect((e as CryptoError).retryAt).toBe(t + 1000);
    expect(lockoutStatus(dir, now).lockedOutUntil).toBe(t + 1000);
    // Restart: the in-memory counter is gone, the persisted one still applies.
    _resetAllLockoutsForTests();
    expect(await code(unlock({ dir, password: PW, now }))).toBe('RATE_LIMITED');
    // In-memory counter survives someone resetting the file during the session.
    t += 1001;
    expect(await code(unlock({ dir, password: 'nope', now }))).toBe('BAD_CREDENTIALS');
    const j = readJson(vaultFilePath(dir));
    writeJson(vaultFilePath(dir), { ...j, failedAttempts: 0, lastFailureAt: null });
    expect(await code(unlock({ dir, password: PW, now }))).toBe('RATE_LIMITED');
    t += 2001;
    (await unlock({ dir, password: PW, now })).dispose();
    expect(readHeader(dir).failedAttempts).toBe(0);
  });

  it('concurrent attempts are serialised (cannot all read the same counter)', async () => {
    const { dir } = await freshVault();
    const t = 5_000_000;
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => code(unlock({ dir, password: 'nope', now: () => t }))));
    expect(results.filter((r) => r === 'BAD_CREDENTIALS')).toHaveLength(3);
    expect(results.filter((r) => r === 'RATE_LIMITED')).toHaveLength(2);
  });
});

describe('change password', () => {
  it('rewraps: new password works, old does not, DEK unchanged', async () => {
    const { dir, dekHex } = await freshVault();
    const before = readHeader(dir).slots[0];
    await changePassword({ dir, currentPassword: PW, newPassword: 'another long passphrase 2' });
    const after = readHeader(dir).slots[0];
    expect(after?.id).toBe(before?.id);
    expect(after?.salt).not.toBe(before?.salt);
    expect(await code(unlock({ dir, password: PW }))).toBe('BAD_CREDENTIALS');
    const km = await unlock({ dir, password: 'another long passphrase 2' });
    expect(km.dbKeyHex()).toBe(dekHex);
    km.dispose();
  });
  it('wrong current password => BAD_CREDENTIALS and nothing changes', async () => {
    const { dir } = await freshVault();
    const before = readFileSync(vaultFilePath(dir), 'utf8');
    expect(await code(changePassword({ dir, currentPassword: 'x', newPassword: 'y'.repeat(12) }))).toBe(
      'BAD_CREDENTIALS',
    );
    const after = readJson(vaultFilePath(dir));
    expect({ ...after, failedAttempts: 0, lastFailureAt: null }).toEqual(JSON.parse(before));
  });
});

describe('rotateDek', () => {
  it('commit rekeys via the callback and the vault then unlocks to the new DEK', async () => {
    const { dir, dekHex } = await freshVault();
    const rot = await rotateDek({ dir, password: PW });
    const newHex = rot.next.dbKeyHex();
    expect(newHex).not.toBe(dekHex);
    expect(rot.droppedSlotIds).toEqual([]);
    const calls: [string, string][] = [];
    await rot.commit((o, n) => void calls.push([o, n]));
    expect(calls).toEqual([[dekHex, newHex]]);
    expect(existsSync(pendingRotationPath(dir))).toBe(false);
    const km = await unlock({ dir, password: PW });
    expect(km.dbKeyHex()).toBe(newHex);
    km.dispose();
    rot.next.dispose();
  });
  it('a failing rekey leaves the old vault intact', async () => {
    const { dir, dekHex } = await freshVault();
    const rot = await rotateDek({ dir, password: PW });
    await expect(
      rot.commit(() => {
        throw new Error('db busy');
      }),
    ).rejects.toThrow('db busy');
    expect(existsSync(pendingRotationPath(dir))).toBe(false);
    const km = await unlock({ dir, password: PW });
    expect(km.dbKeyHex()).toBe(dekHex);
    km.dispose();
    rot.next.dispose();
  });
  it('abort disposes the new key and changes nothing', async () => {
    const { dir, dekHex } = await freshVault();
    const rot = await rotateDek({ dir, password: PW });
    const ref = rot.next.dek;
    rot.abort();
    expect(isZeroed(ref)).toBe(true);
    const km = await unlock({ dir, password: PW });
    expect(km.dbKeyHex()).toBe(dekHex);
    km.dispose();
  });
});

describe('KeyMaterial.dispose', () => {
  it('zero-fills the DEK buffer and refuses further use', async () => {
    const { dir } = await freshVault();
    const km = await unlock({ dir, password: PW });
    const ref = km.dek;
    expect(isZeroed(ref)).toBe(false);
    km.dispose();
    expect(isZeroed(ref)).toBe(true);
    expect(km.disposed).toBe(true);
    expect(() => km.dek).toThrow(CryptoError);
    expect(() => km.dbKeyHex()).toThrow(CryptoError);
    km.dispose(); // idempotent
  });
  it('copies the input so the caller can wipe its own buffer', () => {
    const src = Buffer.alloc(32, 7);
    const km = new KeyMaterial(src, 'a'.repeat(32), 'b'.repeat(32));
    src.fill(0);
    expect(km.dek.every((b) => b === 7)).toBe(true);
    km.dispose();
  });
});

describe('autoTune', () => {
  it('returns policy-valid params (fast target)', async () => {
    const r = await autoTune({ targetMs: 1, startM: KDF_LIMITS.minM });
    expect(r.params).toEqual({ alg: 'argon2id', v: 19, m: KDF_LIMITS.minM, t: 2, p: 1 });
  });
});

describe.skipIf(SKIP_SLOW)('default Argon2id parameters (slow; VSS_SKIP_SLOW_CRYPTO=1 skips)', () => {
  it('autoTune reaches >= 0.7 s on this machine with >= 64 MiB', async () => {
    const r = await autoTune();
    expect(r.params.m).toBeGreaterThanOrEqual(64 * 1024);
    expect(r.ms).toBeGreaterThanOrEqual(700);
  });

  it('unlock takes at least 0.5 s with the default parameters', async () => {
    const dir = tempDir();
    (await createVault({ dir, password: PW })).dispose();
    expect(readHeader(dir).slots[0]?.kdf).toEqual({ alg: 'argon2id', v: 19, m: 262144, t: 3, p: 1 });
    const s = performance.now();
    (await unlock({ dir, password: PW })).dispose();
    expect(performance.now() - s).toBeGreaterThanOrEqual(500);
  });
});
