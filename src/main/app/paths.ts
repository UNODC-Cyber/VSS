/** Where VSS keeps its data. No Electron import: unit-testable. */
import { basename, dirname, join } from 'node:path';

export interface PathEnv {
  VSS_DATA_DIR?: string | undefined;
  LOCALAPPDATA?: string | undefined;
}

export interface AppPaths {
  /** Directory holding vault.json and vss.db. */
  dataDir: string;
  /** Chromium profile (cache, local storage); kept next to the vault so a portable/test run is self-contained. */
  sessionDir: string;
  /** Default folder for pre-migration DB backups. */
  migrationBackupDir: string;
  /** true when VSS_DATA_DIR overrides the default (tests / portable use). */
  overridden: boolean;
}

/**
 * Default: `%LOCALAPPDATA%\VSS\vault`. `VSS_DATA_DIR` (absolute path) overrides it for tests and portable use.
 * `fallbackBase` is used when LOCALAPPDATA is unset (non-Windows dev runs).
 */
export function resolveAppPaths(env: PathEnv, fallbackBase: string): AppPaths {
  const override = env.VSS_DATA_DIR?.trim();
  if (override) {
    const dataDir = override;
    return {
      dataDir,
      sessionDir: join(dirname(dataDir), `${basename(dataDir)}-session`),
      migrationBackupDir: join(dirname(dataDir), `${basename(dataDir)}-migration-backups`),
      overridden: true,
    };
  }
  const base = join(env.LOCALAPPDATA?.trim() || fallbackBase, 'VSS');
  return {
    dataDir: join(base, 'vault'),
    sessionDir: join(base, 'session'),
    migrationBackupDir: join(base, 'migration-backups'),
    overridden: false,
  };
}
