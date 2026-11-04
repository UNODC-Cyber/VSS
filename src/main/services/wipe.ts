/**
 * LANE L (docs/PLAN-ALPHA.md section 15): extra clean-up of `vault.wipe`, run by compose.ts after the password check
 * and BEFORE the vault is destroyed (the backup configuration lives in the encrypted DB). Only runs when the user
 * ticked "Also delete the automatic backups".
 */
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { VaultWipeRequest } from '@shared/ipc/contract';
import { BACKUP_NAME, KEYRING_NAME } from './backup';

export interface WipeExtrasContext {
  /** The configured automatic-backup folder, or null when none is configured (or the vault is locked). */
  backupDir: string | null;
}

/**
 * Deletes VSS's own backup files (`vss-backup-YYYYMMDD-HHMMSS[-N].vssbak` and `vss-backup-keyring.vsskeys`) in the
 * configured folder. Never throws for missing files, never touches any other file or sub-folder.
 */
export async function wipeExtras(req: VaultWipeRequest, ctx: WipeExtrasContext): Promise<void> {
  if (req.alsoDeleteScheduledBackups !== true || !ctx.backupDir) return;
  let names: string[];
  try {
    names = await readdir(ctx.backupDir);
  } catch {
    return; // folder gone or unreadable: nothing to delete
  }
  for (const name of names) {
    if (!BACKUP_NAME.test(name) && name !== KEYRING_NAME) continue;
    await rm(join(ctx.backupDir, name), { force: true }).catch(() => undefined);
  }
}
