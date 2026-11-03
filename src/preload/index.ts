/**
 * Sandboxed preload. Exposes ONLY `window.vss`, built from the channel allowlist in shared/ipc/channels.ts.
 * No Node APIs, no raw ipcRenderer, no zod (validation happens in main).
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { eventChannel, METHODS, NAMESPACES } from '../shared/ipc/channels';
import { EVENT_NAMES } from '../shared/ipc/contract';
import type { VssApi, VssEventMap, VssEventName } from '../shared/ipc/contract';

function buildApi(): VssApi {
  const api: Record<string, unknown> = {};
  for (const ns of NAMESPACES) {
    const group: Record<string, (arg?: unknown) => Promise<unknown>> = {};
    for (const method of METHODS[ns]) {
      const channel = `vss:${ns}.${method}`;
      group[method] = (arg?: unknown) => ipcRenderer.invoke(channel, arg);
    }
    api[ns] = Object.freeze(group);
  }
  api['on'] = <E extends VssEventName>(event: E, listener: (payload: VssEventMap[E]) => void): (() => void) => {
    if (!(EVENT_NAMES as readonly string[]).includes(event) || typeof listener !== 'function') {
      throw new TypeError('Unknown event');
    }
    const channel = eventChannel(event);
    const wrapped = (_e: IpcRendererEvent, payload: VssEventMap[E]): void => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  };
  return Object.freeze(api) as unknown as VssApi;
}

contextBridge.exposeInMainWorld('vss', buildApi());
