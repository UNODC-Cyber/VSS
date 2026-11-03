/// <reference types="vite/client" />
import type { VssApi } from '@shared/ipc/contract';

declare global {
  interface Window {
    /** Typed bridge exposed by the preload script. */
    vss: VssApi;
  }
}
export {};
