import { DEFAULT_SETTINGS } from '@shared/domain/types';
import type { IsoDateTime, Settings } from '@shared/domain/types';
import type { Db } from '../open';
import { nowIso, toJson } from './util';

type Key = keyof Settings;
const KEYS = Object.keys(DEFAULT_SETTINGS) as Key[];

/** Typed settings, one row per top-level key; missing keys fall back to DEFAULT_SETTINGS (exportPolicy merged deep). */
export class SettingRepo {
  constructor(private readonly db: Db) {}

  getAll(): Settings {
    const rows = this.db.prepare('SELECT key, value_json FROM setting').all() as { key: string; value_json: string }[];
    const stored = new Map(rows.map((r) => [r.key, r.value_json]));
    const out = structuredClone(DEFAULT_SETTINGS) as Settings;
    for (const k of KEYS) {
      const raw = stored.get(k);
      if (raw === undefined) continue;
      const v: unknown = JSON.parse(raw);
      if (k === 'exportPolicy') out.exportPolicy = { ...out.exportPolicy, ...(v as Partial<Settings['exportPolicy']>) };
      else (out as unknown as Record<string, unknown>)[k] = v;
    }
    return out;
  }

  get<K extends Key>(key: K): Settings[K] {
    return this.getAll()[key];
  }

  /** Merge `patch` into the stored settings and return the result. Validation is the caller's (zod) job. */
  update(patch: Partial<Settings>, at: IsoDateTime = nowIso()): Settings {
    this.db.transaction(() => {
      const current = this.getAll();
      for (const k of Object.keys(patch) as Key[]) {
        if (!KEYS.includes(k) || patch[k] === undefined) continue;
        const v = k === 'exportPolicy' ? { ...current.exportPolicy, ...patch.exportPolicy } : patch[k];
        this.db
          .prepare(
            'INSERT INTO setting(key, value_json, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
          )
          .run(k, toJson(v), at);
      }
    });
    return this.getAll();
  }

  set<K extends Key>(key: K, value: Settings[K]): Settings {
    return this.update({ [key]: value } as Partial<Settings>);
  }
}
