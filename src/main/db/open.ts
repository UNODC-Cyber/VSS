/**
 * Encrypted SQLite (SQLite3MultipleCiphers, chacha20 page AEAD) opened with a raw 32-byte key.
 * Pragma order is load-bearing (docs/NOTES-sqlite.md): cipher, key, first statement validates the key, then the rest.
 */
import Database from 'better-sqlite3-multiple-ciphers';
import { existsSync } from 'node:fs';
import { DbError } from './errors';

export type RawDatabase = Database.Database;
export type Statement = Database.Statement;

const HEX64 = /^[0-9a-fA-F]{64}$/;

function assertKeyHex(keyHex: string): void {
  if (!HEX64.test(keyHex)) throw new DbError('BAD_KEY_FORMAT', 'database key must be 64 hex characters');
}

/** Apply cipher + raw key to a fresh connection. The pragma string is built transiently and not retained. */
export function applyKey(raw: RawDatabase, keyHex: string): void {
  assertKeyHex(keyHex);
  raw.pragma("cipher='chacha20'");
  raw.pragma(`key="x'${keyHex}'"`);
}

export interface OpenOptions {
  /** Open read-only (no pragmas that write). Default false. */
  readonly?: boolean;
  /** Refuse to create a new file. Default false. */
  mustExist?: boolean;
}

export class Db {
  private readonly cache = new Map<string, Statement>();
  private closed = false;

  constructor(
    readonly raw: RawDatabase,
    readonly path: string,
  ) {}

  get isOpen(): boolean {
    return !this.closed && this.raw.open;
  }

  /** Prepared statement, cached per connection. */
  prepare(sql: string): Statement {
    this.assertOpen();
    let st = this.cache.get(sql);
    if (!st) {
      st = this.raw.prepare(sql);
      this.cache.set(sql, st);
    }
    return st;
  }

  exec(sql: string): void {
    this.assertOpen();
    this.raw.exec(sql);
  }

  /** Run fn in a transaction (nested calls become savepoints). Any throw rolls back and is rethrown. */
  transaction<T>(fn: () => T): T {
    this.assertOpen();
    return this.raw.transaction(fn)();
  }

  get inTransaction(): boolean {
    return this.raw.inTransaction;
  }

  /** Consistent encrypted copy (same cipher and key) at `path`; the target must not exist. */
  vacuumInto(path: string): void {
    this.assertOpen();
    if (existsSync(path)) throw new DbError('BACKUP_FAILED', 'backup target already exists');
    try {
      this.raw.prepare('VACUUM INTO ?').run(path);
    } catch (e) {
      throw new DbError('BACKUP_FAILED', 'VACUUM INTO failed', { cause: e });
    }
  }

  /** Re-encrypt every page under a new raw key. The old key no longer opens the file afterwards. */
  rekey(newKeyHex: string): void {
    this.assertOpen();
    assertKeyHex(newKeyHex);
    this.checkpoint();
    this.raw.pragma(`rekey="x'${newKeyHex}'"`);
    // Prove the connection still reads with the new key.
    this.raw.prepare('SELECT count(*) AS n FROM sqlite_master').get();
  }

  checkpoint(): void {
    this.assertOpen();
    if (!this.raw.readonly) this.raw.pragma('wal_checkpoint(TRUNCATE)');
  }

  /** Checkpoint the WAL into the main file, then close. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cache.clear();
    if (!this.raw.open) return;
    try {
      if (!this.raw.readonly) this.raw.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      this.raw.close();
    }
  }

  private assertOpen(): void {
    if (this.closed || !this.raw.open) throw new DbError('NOT_OPEN', 'database is not open');
  }
}

/**
 * Open (or create) the encrypted DB. Wrong key => DbError('WRONG_KEY'); the connection is closed before throwing.
 */
export function openDatabase(path: string, keyHex: string, opts: OpenOptions = {}): Db {
  assertKeyHex(keyHex);
  if (opts.mustExist && !existsSync(path)) throw new DbError('NOT_FOUND', 'database file not found');
  const raw = new Database(path, { readonly: opts.readonly ?? false, fileMustExist: opts.mustExist ?? false });
  try {
    applyKey(raw, keyHex);
    try {
      raw.prepare('SELECT count(*) AS n FROM sqlite_master').get();
    } catch (e) {
      throw new DbError('WRONG_KEY', 'database key rejected', { cause: e });
    }
    if (!opts.readonly) {
      raw.pragma('journal_mode = WAL');
      raw.pragma('synchronous = FULL');
    }
    raw.pragma('secure_delete = ON');
    raw.pragma('temp_store = MEMORY');
    raw.pragma('foreign_keys = ON');
    return new Db(raw, path);
  } catch (e) {
    try {
      raw.close();
    } catch {
      /* already closed */
    }
    throw e;
  }
}
