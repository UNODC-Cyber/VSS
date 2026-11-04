/**
 * Alpha 1 migration slots (docs/PLAN-ALPHA.md section 2): 005..008 are reserved files that lanes B, D, C and K fill.
 * An empty slot is not registered until a higher slot holds SQL, so A0 does not move the schema version.
 * Also covers SettingRepo filling defaults for keys added after a vault was created (lanes E and G1 need no migration).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/domain/types';
import { readSchemaVersion, runMigrations } from '../../../src/main/db/migrate';
import {
  activeMigrations,
  APP_SCHEMA_VERSION,
  isPlaceholderSql,
  MIGRATION_SLOTS,
  MIGRATIONS,
} from '../../../src/main/db/migrations';
import { openDatabase } from '../../../src/main/db/open';
import { freshDb, newKey } from './helpers';
import type { Fixture } from './helpers';

let fx: Fixture | null = null;
let dir = '';
afterEach(() => {
  fx?.cleanup();
  fx = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

describe('migration slots', () => {
  it('reserves 005..008 for lanes B, D, C, K as empty placeholders', () => {
    expect(MIGRATION_SLOTS.map((m) => m.name).slice(4)).toEqual([
      '005_requestors',
      '006_request_lifecycle',
      '007_response_disposition',
      '008_review_edits',
    ]);
    MIGRATION_SLOTS.forEach((m, i) => expect(m.version).toBe(i + 1));
    for (const m of MIGRATION_SLOTS.slice(0, 4)) expect(isPlaceholderSql(m.sql), m.name).toBe(false);
  });

  it('does not register trailing empty slots (schema version unchanged by A0)', () => {
    const filled = MIGRATION_SLOTS.filter((m) => !isPlaceholderSql(m.sql)).map((m) => m.version);
    expect(APP_SCHEMA_VERSION).toBe(Math.max(...filled));
    expect(MIGRATIONS.length).toBe(APP_SCHEMA_VERSION);
  });

  it('a filled higher slot registers the empty lower ones as no-ops', () => {
    const slots = [
      { version: 1, name: '001', sql: 'CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);' },
      { version: 2, name: '002', sql: '-- placeholder\n\n-- only comments\n' },
      { version: 3, name: '003', sql: 'CREATE TABLE three(a);' },
      { version: 4, name: '004', sql: '  -- empty tail\n' },
    ];
    const active = activeMigrations(slots);
    expect(active.map((m) => m.version)).toEqual([1, 2, 3]);
    expect(isPlaceholderSql(active[1]!.sql)).toBe(true);
    dir = mkdtempSync(join(tmpdir(), 'vss-slots-'));
    const db = openDatabase(join(dir, 'vss.db'), newKey());
    expect(runMigrations(db, { migrations: active }).applied).toEqual([1, 2, 3]);
    expect(readSchemaVersion(db)).toBe(3);
    db.close();
  });

  it('isPlaceholderSql treats comments and whitespace only as empty', () => {
    expect(isPlaceholderSql('')).toBe(true);
    expect(isPlaceholderSql('-- a\r\n   -- b\n')).toBe(true);
    expect(isPlaceholderSql('-- a\nALTER TABLE x ADD COLUMN y TEXT;')).toBe(false);
  });
});

describe('settings defaults for keys added later', () => {
  it('fills absent keys and missing sub-keys from DEFAULT_SETTINGS', () => {
    fx = freshDb();
    // A vault written before Alpha 1: only 0.1 keys stored, one object stored without a later sub-key.
    fx.db.prepare('DELETE FROM setting').run();
    fx.db
      .prepare(
        "INSERT INTO setting(key, value_json, updated_at) VALUES ('vettingAuthority', ?, '2026-01-01T00:00:00Z')",
      )
      .run(JSON.stringify({ to: [{ name: 'Desk', email: 'desk@example.invalid' }] }));
    const s = fx.repos.settings.getAll();
    expect(s.emailTemplates).toEqual(DEFAULT_SETTINGS.emailTemplates);
    expect(s.uiDensity).toBe('comfortable');
    expect(s.tableColumns).toEqual({});
    expect(s.vettingAuthority).toEqual({ to: [{ name: 'Desk', email: 'desk@example.invalid' }], cc: [] });
    expect(s.autoLockMinutes).toBe(DEFAULT_SETTINGS.autoLockMinutes);
  });

  it('round-trips the new keys', () => {
    fx = freshDb();
    fx.repos.settings.update({
      uiDensity: 'compact',
      tableColumns: { people: ['unit'] },
      emailTemplates: { ...DEFAULT_SETTINGS.emailTemplates, reminder: { subject: 'S', body: 'B' } },
    });
    const s = fx.repos.settings.getAll();
    expect(s.uiDensity).toBe('compact');
    expect(s.tableColumns).toEqual({ people: ['unit'] });
    expect(s.emailTemplates.reminder).toEqual({ subject: 'S', body: 'B' });
    expect(s.emailTemplates['all-clear']).toBeNull();
  });
});
