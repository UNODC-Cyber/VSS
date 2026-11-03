/**
 * Security review F-07: the back-off fields of vault.json are outside the MAC. A far-future `lastFailureAt` (edited
 * file, or a clock that was wrong when the failure happened) must not lock the owner out: it is clamped to now, so
 * the wait is at most MAX_DELAY_MS. Synthetic credentials only.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { _resetAllLockoutsForTests, lockedOutUntil, MAX_DELAY_MS } from '../../src/main/crypto/lockout';
import { createVault, lockoutStatus, unlock, vaultFilePath } from '../../src/main/crypto/vault';
import { FAST_KDF } from '../unit/crypto/helpers';

const root = mkdtempSync(join(tmpdir(), 'vss-lockout-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const PWD = 'correct-password-1';

async function vaultWith(failedAttempts: number, lastFailureAt: string): Promise<string> {
  const dir = mkdtempSync(join(root, 'v-'));
  (await createVault({ dir, password: PWD, kdf: FAST_KDF })).dispose();
  _resetAllLockoutsForTests();
  const h = JSON.parse(readFileSync(vaultFilePath(dir), 'utf8'));
  writeFileSync(vaultFilePath(dir), JSON.stringify({ ...h, failedAttempts, lastFailureAt }));
  return dir;
}

describe('F-07 lockout timestamps are clamped to now', () => {
  it('lastFailureAt in year 9999 does not lock the owner out until 9999', async () => {
    const now = Date.parse('2026-11-03T10:00:00.000Z');
    const dir = await vaultWith(40, '9999-12-31T23:59:59Z');
    const st = lockoutStatus(dir, () => now);
    expect(st.lockedOutUntil).not.toBeNull();
    expect(st.lockedOutUntil! - now).toBeLessThanOrEqual(MAX_DELAY_MS);
    // after the longest back-off the correct password unlocks
    const km = await unlock({ dir, password: PWD, now: () => now + MAX_DELAY_MS + 1 });
    expect(km.disposed).toBe(false);
    km.dispose();
  });

  it('lockedOutUntil never exceeds now + MAX_DELAY_MS', () => {
    const now = 1_000_000;
    for (const lastAt of [now - 1, now, now + 1, now + 10 * MAX_DELAY_MS, Number.MAX_SAFE_INTEGER]) {
      const until = lockedOutUntil({ count: 50, lastAt }, now);
      if (until !== null) expect(until - now).toBeLessThanOrEqual(MAX_DELAY_MS);
    }
  });
});
