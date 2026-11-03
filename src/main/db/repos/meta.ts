import type { Db } from '../open';

/** Key/value metadata (schema_version, audit head, ...). */
export class MetaRepo {
  constructor(private readonly db: Db) {}

  get(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? r.value : null;
  }
  set(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }
  delete(key: string): void {
    this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
  }
  schemaVersion(): number {
    return Number(this.get('schema_version') ?? 0);
  }
}
