/**
 * Errors raised by the crypto layer. Messages are fixed strings: they never contain passwords, keys, salts, paths or
 * any other caller-supplied data.
 */

export type CryptoErrorCode =
  | 'BAD_CREDENTIALS'
  | 'VAULT_TAMPERED'
  | 'VAULT_CORRUPT'
  | 'VAULT_NOT_FOUND'
  | 'VAULT_EXISTS'
  | 'RATE_LIMITED'
  | 'BACKUP_INVALID'
  | 'BAD_REQUEST'
  | 'KEY_DISPOSED';

const MESSAGES: Record<CryptoErrorCode, string> = {
  BAD_CREDENTIALS: 'Unlock failed',
  VAULT_TAMPERED: 'Vault integrity check failed',
  VAULT_CORRUPT: 'Vault file is invalid',
  VAULT_NOT_FOUND: 'Vault not found',
  VAULT_EXISTS: 'A vault already exists in this location',
  RATE_LIMITED: 'Too many failed attempts; try again later',
  BACKUP_INVALID: 'Backup could not be opened',
  BAD_REQUEST: 'Invalid parameters',
  KEY_DISPOSED: 'Key material has been disposed',
};

export class CryptoError extends Error {
  readonly code: CryptoErrorCode;
  /** Only for RATE_LIMITED: epoch ms until which attempts are refused. */
  readonly retryAt: number | null;

  constructor(code: CryptoErrorCode, retryAt: number | null = null) {
    super(MESSAGES[code]);
    this.name = 'CryptoError';
    this.code = code;
    this.retryAt = retryAt;
  }
}

export const isCryptoError = (e: unknown): e is CryptoError => e instanceof CryptoError;
