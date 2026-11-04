/**
 * LANE L SLOT (docs/PLAN-ALPHA.md section 15): extra clean-up of `vault.wipe`, run by compose.ts after the
 * password check and BEFORE the vault is destroyed (the backup configuration lives in the encrypted DB).
 * Until lane L lands it does nothing, so `alsoDeleteScheduledBackups` has no effect.
 */
import type { VaultWipeRequest } from '@shared/ipc/contract';

export interface WipeExtrasContext {
  /** The configured automatic-backup folder, or null when none is configured (or the vault is locked). */
  backupDir: string | null;
}

/** Must never throw for missing files and never touch files VSS did not write. */
export async function wipeExtras(req: VaultWipeRequest, ctx: WipeExtrasContext): Promise<void> {
  void req;
  void ctx;
}
