/**
 * Schema migrations: numbered SQL, `meta.schema_version`, all pending steps in ONE transaction after unlock, an
 * automatic encrypted pre-migration backup (VACUUM INTO) when an existing schema is upgraded, and refusal to open a
 * DB written by a newer app.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DbError } from './errors';
import { MIGRATIONS } from './migrations';
import type { Migration } from './migrations';
import type { Db } from './open';

export interface MigrateOptions {
  /** Directory for the pre-migration backup; required when an existing schema (version >= 1) is upgraded. */
  backupDir?: string | null;
  migrations?: readonly Migration[];
  /** Clock for the backup file name (tests). */
  now?: () => Date;
}

export interface MigrateResult {
  from: number;
  to: number;
  applied: number[];
  backupPath: string | null;
}

/** Current schema version: 0 for an empty DB. */
export function readSchemaVersion(db: Db): number {
  const hasMeta = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='meta'").get();
  if (!hasMeta) return 0;
  const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined;
  if (!row) throw new DbError('MIGRATION_FAILED', 'meta table without schema_version');
  const v = Number(row.value);
  if (!Number.isInteger(v) || v < 1) throw new DbError('MIGRATION_FAILED', 'invalid schema_version');
  return v;
}

function validate(migrations: readonly Migration[]): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new DbError('MIGRATION_FAILED', `migration list not contiguous at ${m.name}`);
  });
}

export function runMigrations(db: Db, opts: MigrateOptions = {}): MigrateResult {
  const migrations = opts.migrations ?? MIGRATIONS;
  validate(migrations);
  const target = migrations.length;
  const from = readSchemaVersion(db);
  if (from > target) {
    throw new DbError('SCHEMA_NEWER_THAN_APP', `database schema v${from} is newer than this app (v${target})`);
  }
  if (from === target) return { from, to: target, applied: [], backupPath: null };

  let backupPath: string | null = null;
  if (from > 0) {
    if (!opts.backupDir) throw new DbError('BACKUP_FAILED', 'backupDir is required to upgrade an existing schema');
    mkdirSync(opts.backupDir, { recursive: true });
    const stamp = (opts.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-');
    backupPath = join(opts.backupDir, `vss-pre-migration-v${from}-to-v${target}-${stamp}.db`);
    db.vacuumInto(backupPath);
  }

  const applied: number[] = [];
  try {
    db.transaction(() => {
      for (const m of migrations.slice(from)) {
        db.exec(m.sql);
        db.prepare(
          "INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        ).run(String(m.version));
        applied.push(m.version);
      }
    });
  } catch (e) {
    throw new DbError('MIGRATION_FAILED', `migration from v${from} failed; database unchanged`, { cause: e });
  }
  return { from, to: target, applied, backupPath };
}
