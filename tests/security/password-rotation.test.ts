/**
 * Security review F-03: changing the password rotates the DEK and re-keys the database, so an old copy of vault.json
 * plus the old password no longer opens the live DB. The rotation is crash-safe: an interrupted change is completed
 * or rolled back at the next unlock, with either the old or the new password. Real vault + encrypted DB; synthetic
 * data only.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _resetAllLockoutsForTests } from '../../src/main/crypto/lockout';
import { pendingRotationPath, rotateDek, rotationRecordPath, vaultFilePath } from '../../src/main/crypto/vault';
import { openDatabase } from '../../src/main/db/open';
import { makeApp, PW, PW2 } from '../unit/app/helpers';
import type { TestApp } from '../unit/app/helpers';

vi.setConfig({ testTimeout: 90_000 });

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

async function withData(): Promise<TestApp> {
  const app = await makeApp();
  expect((await app.call('vault', 'create', { password: PW, displayName: 'x' })).ok).toBe(true);
  app.app.db.repos().meta.set('synthetic.marker', 'kept-across-rotation');
  return app;
}
const marker = (app: TestApp) => app.app.db.repos().meta.get('synthetic.marker');

/** Snapshot of the vault files at one instant (simulates the process dying right there). */
function snapshot(dir: string, tag: string): () => void {
  const names = ['vault.json', 'vault.json.next', 'vault.json.rotation'];
  const saved = names.filter((n) => existsSync(join(dir, n)));
  for (const n of saved) copyFileSync(join(dir, n), join(dir, `${n}.${tag}`));
  return () => {
    for (const n of names) {
      const src = join(dir, `${n}.${tag}`);
      if (saved.includes(n)) copyFileSync(src, join(dir, n));
    }
  };
}

describe('F-03 password change rotates the DEK', () => {
  it('an old vault.json + the old password no longer opens the database after a password change', async () => {
    t = await withData();
    const dir = t.paths.dataDir;
    const oldHeader = join(t.root, 'old-vault.json');
    copyFileSync(vaultFilePath(dir), oldHeader);
    const ch = await t.call('vault', 'changePassword', { currentPassword: PW, newPassword: PW2 });
    expect(ch.ok).toBe(true);
    expect(marker(t)).toBe('kept-across-rotation'); // the open connection keeps working after the rekey
    await t.call('vault', 'lock');

    // Attacker restores the old header (OneDrive version history) and uses the old password.
    const current = readFileSync(vaultFilePath(dir));
    copyFileSync(oldHeader, vaultFilePath(dir));
    _resetAllLockoutsForTests();
    const attack = await t.call('vault', 'unlock', { password: PW });
    expect(attack.ok).toBe(false);
    expect(t.app.db.isOpen).toBe(false);

    writeFileSync(vaultFilePath(dir), current);
    _resetAllLockoutsForTests();
    expect((await t.call('vault', 'unlock', { password: PW })).ok).toBe(false);
    expect((await t.call('vault', 'unlock', { password: PW2 })).ok).toBe(true);
    expect(marker(t)).toBe('kept-across-rotation');
  });

  it('a wrong current password changes nothing', async () => {
    t = await withData();
    const before = readFileSync(vaultFilePath(t.paths.dataDir), 'utf8');
    const r = await t.call('vault', 'changePassword', { currentPassword: 'not the password at all', newPassword: PW2 });
    expect(r.ok).toBe(false);
    expect(JSON.parse(readFileSync(vaultFilePath(t.paths.dataDir), 'utf8')).slots).toEqual(JSON.parse(before).slots);
    expect(existsSync(pendingRotationPath(t.paths.dataDir))).toBe(false);
  });

  /**
   * Interrupted rotation, run against the closed DB: `rekeyDb` re-keys the file and the vault files are snapshotted
   * at the chosen instant; restoring the snapshot afterwards is the state a crash at that instant leaves behind.
   */
  async function interrupted(app: TestApp, when: 'before-rekey' | 'after-rekey'): Promise<void> {
    const dir = app.paths.dataDir;
    await app.call('vault', 'lock');
    const rot = await rotateDek({ dir, password: PW, newPassword: PW2 });
    let restore: () => void = () => undefined;
    const done = rot.commit((oldHex, newHex) => {
      if (when === 'before-rekey') {
        restore = snapshot(dir, 'crash');
        throw new Error('simulated crash before the rekey');
      }
      const db = openDatabase(join(dir, 'vss.db'), oldHex, { mustExist: true });
      try {
        db.rekey(newHex);
      } finally {
        db.close();
      }
      restore = snapshot(dir, 'crash');
    });
    if (when === 'before-rekey') await expect(done).rejects.toThrow('simulated crash');
    else await done;
    rot.next.dispose();
    restore();
    expect(existsSync(pendingRotationPath(dir))).toBe(true);
    expect(existsSync(rotationRecordPath(dir))).toBe(true);
    _resetAllLockoutsForTests();
  }

  for (const pw of [PW, PW2]) {
    const which = pw === PW ? 'old' : 'new';
    it(`a crash after the rekey is completed at the next unlock (typing the ${which} password)`, async () => {
      t = await withData();
      await interrupted(t, 'after-rekey');
      const un = await t.call('vault', 'unlock', { password: pw });
      const dir = t.paths.dataDir;
      expect(existsSync(pendingRotationPath(dir))).toBe(false);
      expect(existsSync(rotationRecordPath(dir))).toBe(false);
      // Completed: the DB is under the new DEK, only the new password opens the vault from now on.
      expect(un.ok).toBe(pw === PW2);
      if (un.ok) await t.call('vault', 'lock');
      _resetAllLockoutsForTests();
      expect((await t.call('vault', 'unlock', { password: PW2 })).ok).toBe(true);
      expect(marker(t)).toBe('kept-across-rotation');
    });

    it(`a crash before the rekey is rolled back at the next unlock (typing the ${which} password)`, async () => {
      t = await withData();
      await interrupted(t, 'before-rekey');
      const un = await t.call('vault', 'unlock', { password: pw });
      const dir = t.paths.dataDir;
      expect(existsSync(pendingRotationPath(dir))).toBe(false);
      expect(existsSync(rotationRecordPath(dir))).toBe(false);
      // Rolled back: the change never happened, the old password is still the password.
      expect(un.ok).toBe(pw === PW);
      if (!un.ok) expect(un.error.message).toMatch(/previous password/);
      if (un.ok) await t.call('vault', 'lock');
      _resetAllLockoutsForTests();
      expect((await t.call('vault', 'unlock', { password: PW })).ok).toBe(true);
      expect(marker(t)).toBe('kept-across-rotation');
    });
  }

  it('a torn vault.json.next (crash while writing it) is rolled back; the old password still works', async () => {
    t = await withData();
    const dir = t.paths.dataDir;
    await t.call('vault', 'lock');
    writeFileSync(pendingRotationPath(dir), '{"format":"vss-vault","vers');
    writeFileSync(rotationRecordPath(dir), '{}');
    expect((await t.call('vault', 'unlock', { password: PW })).ok).toBe(true);
    expect(existsSync(pendingRotationPath(dir))).toBe(false);
    expect(existsSync(rotationRecordPath(dir))).toBe(false);
    expect(marker(t)).toBe('kept-across-rotation');
  });
});
