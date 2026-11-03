/** Typed DB-layer errors. Messages never contain personal data. Map to IPC codes via `toVssErrorCode`. */
import type { VssErrorCode } from '@shared/ipc/contract';

export type DbErrorCode =
  | 'BAD_KEY_FORMAT' // key is not 64 hex chars
  | 'WRONG_KEY' // key does not decrypt the file (or file is not a database)
  | 'NOT_OPEN'
  | 'SCHEMA_NEWER_THAN_APP'
  | 'MIGRATION_FAILED'
  | 'BACKUP_FAILED'
  | 'NOT_FOUND'
  | 'IN_USE' // delete refused: still referenced
  | 'AUDIT_DETAIL_REJECTED'
  | 'VAULT_MISMATCH'; // the DB does not belong to the vault header (swapped, empty or foreign file)

export class DbError extends Error {
  override readonly name = 'DbError';
  constructor(
    readonly code: DbErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export function isDbError(e: unknown, code?: DbErrorCode): e is DbError {
  return e instanceof DbError && (code === undefined || e.code === code);
}

/** Mapping onto the shared IPC error codes. */
export function toVssErrorCode(code: DbErrorCode): VssErrorCode {
  switch (code) {
    case 'WRONG_KEY':
      return 'BAD_CREDENTIALS';
    case 'NOT_OPEN':
      return 'VAULT_LOCKED';
    case 'SCHEMA_NEWER_THAN_APP':
      return 'SCHEMA_NEWER_THAN_APP';
    case 'NOT_FOUND':
      return 'NOT_FOUND';
    case 'IN_USE':
      return 'CONFLICT';
    case 'VAULT_MISMATCH':
      return 'VAULT_TAMPERED';
    case 'BAD_KEY_FORMAT':
    case 'AUDIT_DETAIL_REJECTED':
      return 'BAD_REQUEST';
    case 'MIGRATION_FAILED':
    case 'BACKUP_FAILED':
      return 'INTERNAL';
  }
}
