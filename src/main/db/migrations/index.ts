/** Ordered schema migrations. Files are bundled as raw strings (Vite `?raw`), so no runtime file I/O is needed. */
import m001 from './001_init.sql?raw';
import m002 from './002_provenance.sql?raw';
import m003 from './003_templates.sql?raw';
import m004 from './004_purge.sql?raw';
// Alpha 1 slots (docs/PLAN-ALPHA.md): each lane fills ONLY its own .sql file; this list never needs editing.
import m005 from './005_requestors.sql?raw'; // lane B
import m006 from './006_request_lifecycle.sql?raw'; // lane D
import m007 from './007_response_disposition.sql?raw'; // lane C
import m008 from './008_review_edits.sql?raw'; // lane K

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Every migration file, in order, including the empty Alpha 1 placeholders. */
export const MIGRATION_SLOTS: readonly Migration[] = [
  { version: 1, name: '001_init', sql: m001 },
  { version: 2, name: '002_provenance', sql: m002 },
  { version: 3, name: '003_templates', sql: m003 },
  { version: 4, name: '004_purge', sql: m004 },
  { version: 5, name: '005_requestors', sql: m005 },
  { version: 6, name: '006_request_lifecycle', sql: m006 },
  { version: 7, name: '007_response_disposition', sql: m007 },
  { version: 8, name: '008_review_edits', sql: m008 },
];

/** True when a migration file holds no statement (only `--` comments and whitespace): a reserved slot. */
export function isPlaceholderSql(sql: string): boolean {
  return (
    sql
      .split(/\r?\n/)
      .map((l) => l.replace(/--.*$/, '').trim())
      .join('') === ''
  );
}

/**
 * The migrations this build applies: every slot up to the highest one that holds SQL. Empty slots below it run as
 * no-ops so versions stay contiguous; empty slots above it are not registered, so the schema version only moves
 * when a lane actually ships SQL. Lanes merge in any order, so a developer database migrated between two lane
 * merges can miss a lower slot filled later: recreate such dev vaults (no released vault exists at those versions).
 */
export function activeMigrations(slots: readonly Migration[]): Migration[] {
  let last = 0;
  slots.forEach((m, i) => {
    if (!isPlaceholderSql(m.sql)) last = i + 1;
  });
  return slots.slice(0, last).map((m) => (isPlaceholderSql(m.sql) ? { ...m, sql: '-- reserved slot (empty)' } : m));
}

export const MIGRATIONS: readonly Migration[] = activeMigrations(MIGRATION_SLOTS);

/** Highest schema version this build understands. */
export const APP_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
