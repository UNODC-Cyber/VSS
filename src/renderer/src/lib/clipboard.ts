import { useCallback } from 'react';
import { useUi } from '../store';
import { vss } from './api';

/**
 * Every copy goes through main (`vss.clipboard.copy`) so it can use the exclude-from-history format and schedule the
 * auto-clear. The toast shows a live countdown. Resolves true when the text was copied (icon buttons show a checkmark).
 */
export function useCopy(): (text: string, label?: string) => Promise<boolean> {
  const toast = useUi((s) => s.pushToast);
  return useCallback(
    async (text: string, label?: string) => {
      const r = await vss().clipboard.copy({ field: 'plain', text });
      if (!r.ok) {
        toast({ kind: 'error', message: r.error.message });
        return false;
      }
      toast({
        kind: 'success',
        message: label ?? 'Copied',
        countdownUntil: Date.now() + r.value.clearsInSeconds * 1000,
      });
      return true;
    },
    [toast],
  );
}
