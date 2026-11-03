/**
 * Glue between the update service (src/main/update) and the rest of the app: the persistent last-check store
 * (a row in the encrypted `setting` table) and the factory type compose.ts injects.
 */
import type { Ack, Result, UpdateState } from '@shared/ipc/contract';
import type { Db } from '../db/open';
import type { LastCheckStore, UpdateServiceDeps } from '../update/service';

export const LAST_CHECK_KEY = 'updates.lastCheck';

/**
 * Stores the last completed check time in the `setting` table (key outside the Settings schema, so
 * SettingRepo.getAll ignores it). Returns null / does nothing while the vault is locked.
 */
export function settingsLastCheckStore(db: () => Db | null): LastCheckStore {
  return {
    async load() {
      try {
        const d = db();
        if (!d) return null;
        const r = d.prepare('SELECT value_json FROM setting WHERE key = ?').get(LAST_CHECK_KEY) as
          { value_json: string } | undefined;
        if (!r) return null;
        const n = Number(JSON.parse(r.value_json));
        return Number.isFinite(n) ? n : null;
      } catch {
        return null;
      }
    },
    async save(ms) {
      try {
        const d = db();
        if (!d) return;
        d.prepare(
          'INSERT INTO setting(key, value_json, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
        ).run(LAST_CHECK_KEY, JSON.stringify(ms), new Date(ms).toISOString());
      } catch {
        // a lock racing the save must not surface as an update error
      }
    },
  };
}

/** What compose.ts needs from the update service (satisfied by UpdateService). */
export interface UpdateServiceLike {
  handlers(): {
    state: () => Promise<Result<UpdateState>>;
    check: () => Promise<Result<UpdateState>>;
    download: () => Promise<Result<UpdateState>>;
    install: () => Promise<Result<Ack>>;
  };
  onUnlocked(): Promise<void>;
}

export type UpdateServiceFactory = (
  deps: Pick<UpdateServiceDeps, 'isCheckEnabled' | 'emit' | 'store'>,
) => Promise<UpdateServiceLike>;

/** Production factory (electron-updater behind NetGate). Loaded lazily so tests never import Electron. */
export const createRealUpdateService: UpdateServiceFactory = async (deps) => {
  const mod = await import('../update/electron');
  return mod.createUpdateService(deps);
};
