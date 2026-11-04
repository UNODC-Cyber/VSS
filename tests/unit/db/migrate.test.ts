import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isDbError } from '../../../src/main/db/errors';
import { readSchemaVersion, runMigrations } from '../../../src/main/db/migrate';
import { APP_SCHEMA_VERSION, MIGRATIONS } from '../../../src/main/db/migrations';
import { openDatabase } from '../../../src/main/db/open';
import { newKey } from './helpers';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});
const setup = () => {
  dir = mkdtempSync(join(tmpdir(), 'vss-mig-'));
  return { path: join(dir, 'vss.db'), backupDir: join(dir, 'backups'), key: newKey() };
};

describe('runMigrations', () => {
  it('migrates an empty DB to the app version without a backup', () => {
    const s = setup();
    const db = openDatabase(s.path, s.key);
    const r = runMigrations(db, { backupDir: s.backupDir });
    expect(r).toMatchObject({ from: 0, to: APP_SCHEMA_VERSION, backupPath: null });
    expect(r.applied).toEqual(MIGRATIONS.map((m) => m.version));
    expect(readSchemaVersion(db)).toBe(APP_SCHEMA_VERSION);
    db.close();
  });

  it('is idempotent', () => {
    const s = setup();
    const db = openDatabase(s.path, s.key);
    runMigrations(db, { backupDir: s.backupDir });
    const again = runMigrations(db, { backupDir: s.backupDir });
    expect(again).toEqual({ from: APP_SCHEMA_VERSION, to: APP_SCHEMA_VERSION, applied: [], backupPath: null });
    db.close();
    const re = openDatabase(s.path, s.key);
    expect(runMigrations(re, { backupDir: s.backupDir }).applied).toEqual([]);
    re.close();
  });

  it('takes an encrypted pre-migration backup that opens with the same key', () => {
    const s = setup();
    const db = openDatabase(s.path, s.key);
    runMigrations(db, { migrations: MIGRATIONS.slice(0, 1) });
    db.prepare("INSERT INTO setting(key, value_json, updated_at) VALUES ('autoLockMinutes', '7', 'x')").run();
    const r = runMigrations(db, { backupDir: s.backupDir, now: () => new Date('2026-01-02T03:04:05Z') });
    expect(r.from).toBe(1);
    expect(r.backupPath).toMatch(
      new RegExp(`vss-pre-migration-v1-to-v${APP_SCHEMA_VERSION}-2026-01-02T03-04-05-000Z\\.db$`),
    );
    expect(readdirSync(s.backupDir)).toHaveLength(1);
    db.close();
    const b = openDatabase(r.backupPath!, s.key);
    expect(readSchemaVersion(b)).toBe(1);
    expect(b.prepare("SELECT value_json FROM setting WHERE key='autoLockMinutes'").get()).toEqual({ value_json: '7' });
    b.close();
    expect(() => openDatabase(r.backupPath!, newKey())).toThrow(expect.objectContaining({ code: 'WRONG_KEY' }));
  });

  it('refuses a DB newer than the app', () => {
    const s = setup();
    const db = openDatabase(s.path, s.key);
    runMigrations(db);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(APP_SCHEMA_VERSION + 1));
    let err: unknown;
    try {
      runMigrations(db, { backupDir: s.backupDir });
    } catch (e) {
      err = e;
    }
    expect(isDbError(err, 'SCHEMA_NEWER_THAN_APP')).toBe(true);
    db.close();
  });

  it('rolls back every step when one migration fails', () => {
    const s = setup();
    const db = openDatabase(s.path, s.key);
    const bad = [
      ...MIGRATIONS,
      { version: MIGRATIONS.length + 1, name: 'bad', sql: 'CREATE TABLE extra(a); SELECT nope FROM missing;' },
    ];
    expect(() => runMigrations(db, { migrations: bad })).toThrow(expect.objectContaining({ code: 'MIGRATION_FAILED' }));
    expect(readSchemaVersion(db)).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('person','extra')").get()).toEqual({
      n: 0,
    });
    db.close();
  });

  it('requires a backupDir to upgrade an existing schema', () => {
    const s = setup();
    const db = openDatabase(s.path, s.key);
    runMigrations(db, { migrations: MIGRATIONS.slice(0, 1) });
    expect(() => runMigrations(db)).toThrow(expect.objectContaining({ code: 'BACKUP_FAILED' }));
    expect(readSchemaVersion(db)).toBe(1);
    db.close();
  });
});
