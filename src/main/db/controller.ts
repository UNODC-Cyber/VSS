/**
 * DbController: the vault lane calls open(keyHex) after unwrapping the DEK and close() on lock. Structurally the
 * same interface the vault lane declares ({open, close, vacuumInto}).
 */
import { DbError } from './errors';
import { readSchemaVersion, runMigrations } from './migrate';
import type { MigrateResult } from './migrate';
import type { Migration } from './migrations';
import { openDatabase } from './open';
import type { Db } from './open';
import { createRepos } from './repos';
import type { Repos } from './repos';

/** How the vault lane opens the DB (security review F-04). */
export interface DbOpenOptions {
  /** true only for vault.create: the file must not exist yet. Otherwise the file must exist and hold a schema. */
  create: boolean;
  /** vaultId of the vault.json header; stored in meta on create and checked on every later open. */
  vaultId: string;
}

/** meta key binding the DB to its vault header. */
export const VAULT_ID_META_KEY = 'vault.id';

export interface DbController {
  open(keyHex: string, opts?: DbOpenOptions): void;
  rekey(newKeyHex: string): void;
  probe(keyHex: string): boolean;
  close(): void;
  vacuumInto(path: string): void;
}

export interface SqliteDbControllerOptions {
  /** Path of vss.db. */
  path: string;
  /** Directory for automatic pre-migration backups. */
  backupDir: string;
  migrations?: readonly Migration[];
  /** Called after open + migrations succeed (e.g. to wire services). */
  onOpen?: (db: Db, migration: MigrateResult) => void;
  /** Called just before the connection closes. */
  onClose?: () => void;
}

function bindVaultId(db: Db, vaultId: string): void {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(VAULT_ID_META_KEY) as
    { value: string } | undefined;
  if (row) {
    if (row.value !== vaultId) throw new DbError('VAULT_MISMATCH', 'database belongs to another vault');
    return;
  }
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run(VAULT_ID_META_KEY, vaultId);
}

export class SqliteDbController implements DbController {
  private db: Db | null = null;
  private reposCache: Repos | null = null;
  lastMigration: MigrateResult | null = null;

  constructor(private readonly opts: SqliteDbControllerOptions) {}

  get isOpen(): boolean {
    return this.db?.isOpen ?? false;
  }

  /**
   * Open with the raw key, then migrate. On any failure the connection is closed and the error rethrown.
   *
   * With `opts` (the vault lane always passes them): the file must already exist unless `create`; an existing file
   * must already hold a schema (an empty file is refused instead of silently starting a new vault); and the vaultId
   * stored in meta must match the header. A DB written before the binding existed adopts the id on first open.
   * Without `opts` (tests, tools) the file is created on demand and not bound.
   */
  open(keyHex: string, opts?: DbOpenOptions): void {
    if (this.db) this.close();
    const db = openDatabase(this.opts.path, keyHex, { mustExist: opts ? !opts.create : false });
    try {
      if (opts) {
        const before = readSchemaVersion(db);
        if (!opts.create && before === 0) throw new DbError('VAULT_MISMATCH', 'database holds no vault data');
        if (opts.create && before !== 0) throw new DbError('VAULT_MISMATCH', 'database already exists');
      }
      this.lastMigration = runMigrations(db, {
        backupDir: this.opts.backupDir,
        ...(this.opts.migrations ? { migrations: this.opts.migrations } : {}),
      });
      if (opts) bindVaultId(db, opts.vaultId);
    } catch (e) {
      db.close();
      throw e;
    }
    this.db = db;
    this.reposCache = createRepos(db);
    this.opts.onOpen?.(db, this.lastMigration);
  }

  close(): void {
    if (!this.db) return;
    try {
      this.opts.onClose?.();
    } finally {
      const db = this.db;
      this.db = null;
      this.reposCache = null;
      db.close();
    }
  }

  vacuumInto(path: string): void {
    this.current().vacuumInto(path);
  }

  /** Re-encrypt the open DB under `newKeyHex` (F-03 password change). */
  rekey(newKeyHex: string): void {
    this.current().rekey(newKeyHex);
  }

  /**
   * While closed: does `keyHex` open the file and does it pass `PRAGMA quick_check`? Used by the rotation recovery
   * to tell which DEK the database is under. Never creates the file.
   */
  probe(keyHex: string): boolean {
    if (this.db) return false;
    let db: Db | null = null;
    try {
      db = openDatabase(this.opts.path, keyHex, { mustExist: true });
      return db.raw.pragma('quick_check', { simple: true }) === 'ok';
    } catch {
      return false;
    } finally {
      db?.close();
    }
  }

  /** The open connection; DbError('NOT_OPEN') while locked. */
  current(): Db {
    if (!this.db || !this.db.isOpen) throw new DbError('NOT_OPEN', 'database is not open');
    return this.db;
  }

  repos(): Repos {
    this.current();
    return this.reposCache!;
  }
}
