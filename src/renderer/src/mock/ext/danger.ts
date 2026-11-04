/**
 * LANE L mock (docs/PLAN-ALPHA.md section 15): the Settings danger zone (delete database) and R16 window position.
 * Same behaviour as the real backend: the password is re-checked and a wrong one counts towards the unlock
 * back-off (RATE_LIMITED while locked out); success resets the in-memory database to the first-run state.
 */
import type { VaultStatus } from '@shared/ipc/contract';
import { emptyDb } from '../db';
import { mockFail, mockOk } from './types';
import type { MockExtension } from './types';

const NO_VAULT: VaultStatus = {
  state: 'no-vault',
  vaultPath: null,
  slots: [],
  autoLockInSeconds: null,
  failedAttempts: 0,
  lockedOutUntil: null,
};

export const dangerMock: MockExtension = ({ db, emit }) => ({
  vault: {
    wipe: (req) => {
      if (!db.vault.exists) return Promise.resolve(mockFail('VAULT_NOT_FOUND', 'No vault found.'));
      if (req.confirm !== 'WIPE') return Promise.resolve(mockFail('BAD_REQUEST', 'Confirmation is missing.'));
      if (db.vault.lockedOutUntil && db.vault.lockedOutUntil > new Date().toISOString())
        return Promise.resolve(mockFail('RATE_LIMITED', 'Too many attempts. Try again later.'));
      if (req.password !== db.vault.password) {
        db.vault.failed += 1;
        if (db.vault.failed >= 5) db.vault.lockedOutUntil = new Date(Date.now() + 30_000).toISOString();
        return Promise.resolve(mockFail('BAD_CREDENTIALS', 'Wrong password.'));
      }
      Object.assign(db, emptyDb());
      emit('vault:locked', { reason: 'manual' });
      return Promise.resolve(mockOk({ ...NO_VAULT }));
    },
  },
  app: {
    resetWindowState: () => Promise.resolve(mockOk({ ok: true as const })),
  },
});
