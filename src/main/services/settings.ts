/**
 * Settings service (WP-19): typed get/update over the encrypted `setting` table.
 * `settings.update` is protected: the password is re-verified through the vault (counts towards the unlock
 * back-off like any attempt), and the changed setting NAMES (never values) are written to the audit chain.
 */
import { DEFAULT_SETTINGS } from '@shared/domain/types';
import type { Settings } from '@shared/domain/types';
import type { Result, SettingsUpdateRequest, VssErrorCode } from '@shared/ipc/contract';
import { err, ok } from '@shared/ipc/result';
import { isCryptoError } from '../crypto/errors';
import { isDbError } from '../db/errors';
import type { AuditLog } from './audit';
import type { SettingRepo } from '../db/repos';

export interface SettingsDeps {
  /** Repo of the open DB; throws DbError('NOT_OPEN') while locked. */
  repo(): SettingRepo;
  audit(): AuditLog;
  /** Run `fn` in one DB transaction. */
  transact<T>(fn: () => T): T;
  /** Resolves when the password is right; throws CryptoError otherwise. */
  verifyPassword(password: string): Promise<void>;
  /** Called after a successful change (lock controller, update service ...). */
  onChanged?(next: Settings, changed: string[], previous: Settings): void;
}

const CRYPTO_MAP: Partial<Record<string, [VssErrorCode, string]>> = {
  BAD_CREDENTIALS: ['BAD_CREDENTIALS', 'Password incorrect'],
  RATE_LIMITED: ['RATE_LIMITED', 'Too many failed attempts; try again later'],
  VAULT_NOT_FOUND: ['VAULT_NOT_FOUND', 'Vault not found'],
  VAULT_CORRUPT: ['VAULT_CORRUPT', 'Vault file is invalid'],
  VAULT_TAMPERED: ['VAULT_CORRUPT', 'Vault integrity check failed'],
};

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function changedKeys(prev: Settings, next: Settings): string[] {
  return (Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]).filter((k) => !same(prev[k], next[k]));
}

export class SettingsService {
  constructor(private readonly d: SettingsDeps) {}

  /** Current settings, or defaults while locked (used by internal readers such as the idle timer). */
  getOrDefault(): Settings {
    try {
      return this.d.repo().getAll();
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  get(): Result<Settings> {
    try {
      return ok(this.d.repo().getAll());
    } catch (e) {
      if (isDbError(e, 'NOT_OPEN')) return err('VAULT_LOCKED', 'Vault is locked');
      return err('INTERNAL', 'Internal error');
    }
  }

  async update(req: SettingsUpdateRequest): Promise<Result<Settings>> {
    let repo: SettingRepo;
    try {
      repo = this.d.repo();
    } catch {
      return err('VAULT_LOCKED', 'Vault is locked');
    }
    if (req.reauth.prfOutputB64 !== undefined) return err('NOT_SUPPORTED', 'Hardware keys are deferred');
    if (!req.reauth.password) return err('REAUTH_REQUIRED', 'Password re-entry is required');
    try {
      await this.d.verifyPassword(req.reauth.password);
    } catch (e) {
      if (isCryptoError(e)) {
        const m = CRYPTO_MAP[e.code];
        if (m) return err(m[0], m[1]);
      }
      return err('REAUTH_REQUIRED', 'Password re-entry failed');
    }
    try {
      repo = this.d.repo(); // the vault may have locked while Argon2 was running
      const previous = repo.getAll();
      const changed = changedKeys(previous, req.settings);
      if (changed.length === 0) return ok(previous);
      const next = this.d.transact(() => {
        const saved = repo.update(req.settings);
        this.d.audit().append({
          actor: 'user',
          type: 'settings.update',
          subjectType: 'settings',
          subjectId: null,
          details: { fields: changed.join(',') },
        });
        return saved;
      });
      this.d.onChanged?.(next, changed, previous);
      return ok(next);
    } catch (e) {
      if (isDbError(e, 'NOT_OPEN')) return err('VAULT_LOCKED', 'Vault is locked');
      return err('INTERNAL', 'Internal error');
    }
  }
}
