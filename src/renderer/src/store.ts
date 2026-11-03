import { create } from 'zustand';
import { DEFAULT_SETTINGS } from '@shared/domain/types';
import type { Settings } from '@shared/domain/types';
import type { PeerStatus, UpdateState, VaultStatus } from '@shared/ipc/contract';

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  message: string;
  /** epoch ms at which the clipboard is cleared; renders a live countdown. */
  countdownUntil?: number;
}

interface UiState {
  vault: VaultStatus | null;
  /** Bumped on every unlock so all data views remount with fresh state. */
  epoch: number;
  settings: Settings;
  reviewOpen: number;
  update: UpdateState | null;
  peer: PeerStatus | null;
  lockWarning: number | null;
  /** Set when the very first vault.status call fails (backend unavailable). */
  bootError: string | null;
  toasts: Toast[];
  setVault: (v: VaultStatus | null) => void;
  setSettings: (s: Settings) => void;
  setReviewOpen: (n: number) => void;
  setUpdate: (u: UpdateState | null) => void;
  setPeer: (p: PeerStatus | null) => void;
  setLockWarning: (n: number | null) => void;
  setBootError: (m: string | null) => void;
  pushToast: (t: Omit<Toast, 'id'>) => number;
  dismissToast: (id: number) => void;
  /** Drop everything that came from the vault. */
  clearData: () => void;
}

let nextToast = 1;

export const useUi = create<UiState>((set) => ({
  vault: null,
  epoch: 0,
  settings: DEFAULT_SETTINGS,
  reviewOpen: 0,
  update: null,
  peer: null,
  lockWarning: null,
  bootError: null,
  toasts: [],
  setVault: (vault) =>
    set((s) => ({
      vault,
      epoch: vault?.state === 'unlocked' && s.vault?.state !== 'unlocked' ? s.epoch + 1 : s.epoch,
    })),
  setSettings: (settings) => set({ settings }),
  setReviewOpen: (reviewOpen) => set({ reviewOpen }),
  setUpdate: (update) => set({ update }),
  setPeer: (peer) => set({ peer }),
  setLockWarning: (lockWarning) => set({ lockWarning }),
  setBootError: (bootError) => set({ bootError }),
  pushToast: (t) => {
    const id = nextToast++;
    set((s) => ({ toasts: [...s.toasts.slice(-4), { ...t, id }] }));
    return id;
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clearData: () => set({ settings: DEFAULT_SETTINGS, reviewOpen: 0, lockWarning: null, toasts: [] }),
}));
