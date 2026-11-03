/**
 * Unlock back-off. The failure count is kept in memory (per vault id, survives edits of vault.json during a session)
 * and persisted in the vault.json header (survives restarts; NOT covered by the header MAC because it must be
 * writable without the DEK). The effective count is the maximum of both.
 *
 * This is a UX throttle against guessing in the UI, not a security boundary (security review F-07): anyone who can
 * edit vault.json can reset the persisted counter, and offline guessing against a copied vault.json is limited only
 * by Argon2id and the password policy. Stored timestamps are clamped to now, so a far-future value cannot lock the
 * owner out.
 */

export const FREE_ATTEMPTS = 3;
export const BASE_DELAY_MS = 1000;
export const MAX_DELAY_MS = 15 * 60 * 1000;

/** Delay imposed after `failures` consecutive failures: 0 for the first FREE_ATTEMPTS-1, then 1 s, 2 s, 4 s ... 15 min. */
export function backoffDelayMs(failures: number): number {
  if (failures < FREE_ATTEMPTS) return 0;
  const exp = Math.min(failures - FREE_ATTEMPTS, 30);
  return Math.min(BASE_DELAY_MS * 2 ** exp, MAX_DELAY_MS);
}

export interface FailureState {
  count: number;
  /** Epoch ms of the last failure, or null. */
  lastAt: number | null;
}

const memory = new Map<string, FailureState>();

export function effectiveFailures(vaultId: string, persisted: FailureState): FailureState {
  const m = memory.get(vaultId);
  if (!m) return persisted;
  return {
    count: Math.max(m.count, persisted.count),
    lastAt: Math.max(m.lastAt ?? 0, persisted.lastAt ?? 0) || null,
  };
}

/**
 * Epoch ms until which attempts are refused, or null when attempts are allowed now. A last failure "in the future"
 * (clock moved back, edited file) counts as now, so the wait never exceeds MAX_DELAY_MS from now (F-07).
 */
export function lockedOutUntil(state: FailureState, now: number): number | null {
  const delay = backoffDelayMs(state.count);
  if (delay === 0 || state.lastAt === null) return null;
  const until = Math.min(state.lastAt, now) + delay;
  return until > now ? until : null;
}

export function recordFailure(vaultId: string, persisted: FailureState, now: number): FailureState {
  const cur = effectiveFailures(vaultId, persisted);
  const next = { count: cur.count + 1, lastAt: now };
  memory.set(vaultId, next);
  return next;
}

export function resetFailures(vaultId: string): void {
  memory.delete(vaultId);
}

/** Test hook: forget all in-memory counters. */
export function _resetAllLockoutsForTests(): void {
  memory.clear();
}
