/** Ordered schema migrations. Files are bundled as raw strings (Vite `?raw`), so no runtime file I/O is needed. */
import m001 from './001_init.sql?raw';
import m002 from './002_provenance.sql?raw';
import m003 from './003_templates.sql?raw';
import m004 from './004_purge.sql?raw';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: '001_init', sql: m001 },
  { version: 2, name: '002_provenance', sql: m002 },
  { version: 3, name: '003_templates', sql: m003 },
  { version: 4, name: '004_purge', sql: m004 },
];

/** Highest schema version this build understands. */
export const APP_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
