/**
 * Security review F-17 and lane L (R15): wipe also removes the encrypted pre-migration copies, optionally VSS's own
 * automatic backups, leaves no vault file anywhere under the app folders, and a new vault works straight away.
 * Synthetic data only.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeApp, PW, PW2 } from '../unit/app/helpers';
import type { TestApp } from '../unit/app/helpers';

vi.setConfig({ testTimeout: 60_000 });

const NAME = 'Zxqvbnmlkj'; // an unmistakable synthetic surname
const BACKUP = 'vss-backup-20261103-100000.vssbak';
const KEYRING = 'vss-backup-keyring.vsskeys';
const USER_FILE = 'my-own-export.xlsx';
const WRONG = 'a wrong password';

function allFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? allFiles(p) : [p];
  });
}
const VAULT_LEFTOVER = /(^|[\\/])(vault\.json|vss\.db(-wal|-shm)?|.*\.pending|.*rotation.*)$/;

async function seed(t: TestApp, withBackupConfig: boolean): Promise<string> {
  expect((await t.call('vault', 'create', { password: PW, displayName: 'x' })).ok).toBe(true);
  const made = await t.call('requests', 'createManual', {
    requestor: { name: 'Requestor Placeholder', email: 'requestor@example.invalid', organisation: 'Example Org' },
    eventName: 'Synthetic Wipe Course',
    eventStart: '2026-11-20',
    eventEnd: '2026-11-21',
    eventLocation: 'Example City',
    sentToDcAt: null,
    notes: '',
    items: [
      {
        surname: NAME,
        givenNames: ['Aaa', 'Bbb'],
        dob: '1980-01-02',
        dobPrecision: 'exact',
        sex: 'M',
        unitName: 'Example Cyber Crime Unit 1',
        unitType: 'Police',
        unitCountry: 'MALAYSIA',
        pobCountry: 'MALAYSIA',
        pobCity: 'Example City',
        nationality: 'MALAYSIA',
        isHeadOfUnit: false,
      },
    ],
  });
  expect(made.ok).toBe(true);
  const backups = join(t.root, 'backups');
  mkdirSync(backups, { recursive: true });
  if (withBackupConfig) {
    const cfg = { dir: backups, keep: 3, onLock: false, everyHours: null, passphrase: 'synthetic backup passphrase 1' };
    expect(t.app.backup.configure(cfg).ok).toBe(true);
  }
  writeFileSync(join(backups, BACKUP), 'synthetic backup bytes');
  writeFileSync(join(backups, KEYRING), 'synthetic keyring bytes');
  writeFileSync(join(backups, USER_FILE), 'the user wrote this');
  mkdirSync(t.paths.migrationBackupDir, { recursive: true });
  writeFileSync(join(t.paths.migrationBackupDir, 'vss-pre-migration-v1-to-v3-synthetic.db'), 'encrypted copy');
  return backups;
}

function expectNothingLeft(t: TestApp): void {
  const dirs = [t.paths.dataDir, t.paths.sessionDir, t.paths.migrationBackupDir];
  for (const dir of dirs) {
    expect(allFiles(dir).filter((p) => VAULT_LEFTOVER.test(p) || /pre-migration/.test(p))).toEqual([]);
  }
  // Byte scan of everything the app folders still hold: the fixture name is nowhere (cf. purge-complete.test.ts).
  const needles = [Buffer.from(NAME, 'utf8'), Buffer.from(NAME.toLowerCase(), 'utf8')];
  for (const dir of dirs) {
    for (const p of allFiles(dir)) {
      const bytes = readFileSync(p);
      for (const n of needles) expect(bytes.includes(n), p).toBe(false);
    }
  }
}

describe('F-17 wipe leftovers', () => {
  it('vault.wipe deletes the migration-backups folder as well', async () => {
    const t = await makeApp();
    try {
      expect((await t.call('vault', 'create', { password: PW, displayName: 'x' })).ok).toBe(true);
      mkdirSync(t.paths.migrationBackupDir, { recursive: true });
      const copy = join(t.paths.migrationBackupDir, 'vss-pre-migration-v1-to-v3-synthetic.db');
      writeFileSync(copy, 'encrypted copy (synthetic)');
      expect((await t.call('vault', 'wipe', { password: PW, confirm: 'WIPE' })).ok).toBe(true);
      expect(existsSync(copy)).toBe(false);
      expect(existsSync(join(t.paths.dataDir, 'vault.json'))).toBe(false);
    } finally {
      t.cleanup();
    }
  });
});

describe('lane L: delete database', () => {
  it('without the checkbox the backups stay; no vault file or data remains; a new vault works', async () => {
    const t = await makeApp();
    try {
      const backups = await seed(t, true);
      const r = await t.call('vault', 'wipe', { password: PW, confirm: 'WIPE' });
      expect(r.ok && r.value.state).toBe('no-vault');
      for (const f of [BACKUP, KEYRING, USER_FILE]) expect(existsSync(join(backups, f)), f).toBe(true);
      expectNothingLeft(t);
      // The first-run flow works at once, with a different password, and the old request is gone.
      expect((await t.call('vault', 'create', { password: PW2, displayName: 'y' })).ok).toBe(true);
      const list = await t.call('requests', 'list', { offset: 0, limit: 50 });
      expect(list.ok).toBe(true);
      expect(JSON.stringify(list.value)).not.toContain('Synthetic Wipe Course');
      expect(JSON.stringify(list.value)).not.toContain(NAME);
    } finally {
      t.cleanup();
    }
  });

  it('with the checkbox only VSS backup files in the configured folder go', async () => {
    const t = await makeApp();
    try {
      const backups = await seed(t, true);
      const r = await t.call('vault', 'wipe', { password: PW, confirm: 'WIPE', alsoDeleteScheduledBackups: true });
      expect(r.ok && r.value.state).toBe('no-vault');
      expect(existsSync(join(backups, BACKUP))).toBe(false);
      expect(existsSync(join(backups, KEYRING))).toBe(false);
      expect(existsSync(join(backups, USER_FILE))).toBe(true);
      expectNothingLeft(t);
    } finally {
      t.cleanup();
    }
  });

  it('a wrong password deletes nothing, with or without the checkbox', async () => {
    const t = await makeApp({ now: () => 5_000_000 });
    try {
      const backups = await seed(t, true);
      for (const also of [false, true]) {
        const r = await t.call('vault', 'wipe', { password: WRONG, confirm: 'WIPE', alsoDeleteScheduledBackups: also });
        expect(r.error.code).toBe('BAD_CREDENTIALS');
      }
      expect(existsSync(join(t.paths.dataDir, 'vault.json'))).toBe(true);
      expect(existsSync(join(backups, BACKUP))).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  it('wrong attempts count toward the lockout back-off', async () => {
    const t = await makeApp({ now: () => 5_000_000 });
    try {
      await seed(t, false);
      const codes: string[] = [];
      for (let i = 0; i < 3; i++)
        codes.push((await t.call('vault', 'wipe', { password: WRONG, confirm: 'WIPE' })).error.code);
      expect(codes).toEqual(['BAD_CREDENTIALS', 'BAD_CREDENTIALS', 'BAD_CREDENTIALS']);
      // Even the right password is refused during the back-off, and nothing was deleted.
      const r = await t.call('vault', 'wipe', { password: PW, confirm: 'WIPE' });
      expect(r.error.code).toBe('RATE_LIMITED');
      expect(existsSync(join(t.paths.dataDir, 'vault.json'))).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  it('the backend contract literal is unchanged: the phrase itself is not accepted as confirm', async () => {
    const t = await makeApp();
    try {
      await seed(t, false);
      const r = await t.call('vault', 'wipe', { password: PW, confirm: 'DELETE DATABASE' });
      expect(r.ok).toBe(false);
      expect(existsSync(join(t.paths.dataDir, 'vault.json'))).toBe(true);
    } finally {
      t.cleanup();
    }
  });
});
