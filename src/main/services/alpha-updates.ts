/** Alpha builds ship no updater: this stand-in never touches the network, NetGate or electron-updater. */
import type { UpdateState } from '@shared/ipc/contract';
import { err, ok } from '@shared/ipc/result';
import type { UpdateServiceFactory } from './updates-wiring';

export function createDisabledUpdateService(version: string): UpdateServiceFactory {
  const state: UpdateState = {
    phase: 'disabled',
    currentVersion: version,
    availableVersion: null,
    releaseNotes: null,
    downloadedBytes: 0,
    totalBytes: null,
    checkedAt: null,
    // Message key, resolved by the renderer (updates.alphaDisabled).
    message: 'updates.alphaDisabled',
  };
  return async () => ({
    handlers: () => ({
      state: async () => ok(state),
      check: async () => ok(state),
      download: async () => err('NOT_SUPPORTED', 'Updates are disabled in alpha builds'),
      install: async () => err('NOT_SUPPORTED', 'Updates are disabled in alpha builds'),
    }),
    onUnlocked: async () => undefined,
  });
}
