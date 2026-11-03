/**
 * NetGate: the ONLY module allowed to touch network APIs (enforced by ESLint no-restricted-imports and
 * tests/security/no-net-imports.test.ts). Disabled by default; every request must pass `assertAllowed`.
 * The updater (WP-22) and the LAN peer mode (WP-26) must obtain their transport from here.
 */
import { net, session } from 'electron';
import type { Session } from 'electron';
import type { AppUpdater } from 'electron-updater';

export class NetworkDisabledError extends Error {
  readonly code = 'NETWORK_DISABLED';
  constructor(message: string) {
    super(message);
    this.name = 'NetworkDisabledError';
  }
}

/** A request that reached an allowlisted host but failed (status, size cap, aborted stream). */
export class NetworkRequestError extends Error {
  readonly code = 'NETWORK_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'NetworkRequestError';
  }
}

/** Partition name electron-updater uses for its own requests (electron-updater/out/electronHttpExecutor.js). */
export const UPDATER_SESSION_PARTITION = 'electron-updater';

/** Hosts reachable over HTTPS when the gate is enabled (GitHub releases for update checks only). */
export const DEFAULT_ALLOWLIST: readonly string[] = [
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
];

export interface NetGateState {
  enabled: boolean;
  allowlist: readonly string[];
}

class NetGate {
  #enabled = false;
  #allowlist: readonly string[] = DEFAULT_ALLOWLIST;

  get enabled(): boolean {
    return this.#enabled;
  }
  get allowlist(): readonly string[] {
    return this.#allowlist;
  }
  state(): NetGateState {
    return { enabled: this.#enabled, allowlist: this.#allowlist };
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
  }
  setAllowlist(hosts: readonly string[]): void {
    this.#allowlist = [...hosts];
  }

  /** Throws unless the gate is enabled and the URL is https on an allowlisted host. */
  assertAllowed(rawUrl: string): URL {
    if (!this.#enabled) throw new NetworkDisabledError('Network access is disabled');
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new NetworkDisabledError('Invalid URL');
    }
    if (url.protocol !== 'https:') throw new NetworkDisabledError('Only https is permitted');
    if (url.username || url.password) throw new NetworkDisabledError('Credentials in URL are not permitted');
    // F-15: only the default https port. new URL() normalises ':443' to '', so any other value is a non-default port.
    if (url.port !== '') throw new NetworkDisabledError('Only the default https port is permitted');
    if (!this.#allowlist.includes(url.hostname.toLowerCase())) {
      throw new NetworkDisabledError('Host is not on the allowlist');
    }
    return url;
  }

  isAllowed(rawUrl: string): boolean {
    try {
      this.assertAllowed(rawUrl);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The only fetch in the app. Redirects are followed manually so each hop is re-checked against the allowlist;
   * caller headers are dropped when a redirect changes host (GitHub release downloads hop to *.githubusercontent.com).
   */
  async fetch(
    rawUrl: string,
    init: { method?: 'GET' | 'HEAD'; headers?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<Response> {
    let url = this.assertAllowed(rawUrl);
    let headers = init.headers;
    for (let hop = 0; hop < 5; hop++) {
      const res = await net.fetch(url.toString(), {
        method: init.method ?? 'GET',
        ...(headers ? { headers } : {}),
        ...(init.signal ? { signal: init.signal } : {}),
        redirect: 'manual',
        credentials: 'omit',
      });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        const next = this.assertAllowed(new URL(location, url).toString());
        if (next.host !== url.host) headers = undefined;
        await res.body?.cancel().catch(() => undefined);
        url = next;
        continue;
      }
      return res;
    }
    throw new NetworkDisabledError('Too many redirects');
  }

  /**
   * Streams a GET body into memory with a hard size cap. Requires HTTP 200. Aborts if the gate is disabled while the
   * body is still streaming.
   */
  async fetchBytes(rawUrl: string, opts: { maxBytes: number; headers?: Record<string, string> }): Promise<Uint8Array> {
    const controller = new AbortController();
    const res = await this.fetch(rawUrl, {
      method: 'GET',
      signal: controller.signal,
      ...(opts.headers ? { headers: opts.headers } : {}),
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      throw new NetworkRequestError(`Unexpected HTTP status ${res.status}`);
    }
    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      controller.abort();
      throw new NetworkRequestError('Response exceeds size limit');
    }
    if (!res.body) return new Uint8Array(0);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!this.#enabled) throw new NetworkDisabledError('Network access was disabled during the transfer');
        total += value.byteLength;
        if (total > opts.maxBytes) throw new NetworkRequestError('Response exceeds size limit');
        chunks.push(value);
      }
    } catch (e) {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      throw e;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return out;
  }

  /**
   * Routes every request of `ses` through the gate: cancelled unless the gate is enabled and the URL (each redirect hop
   * fires onBeforeRequest again) is https on the allowlist. Used for the session electron-updater makes its own
   * requests from, so its traffic obeys the same switch and allowlist as NetGate.fetch.
   */
  guardSession(ses: Pick<Session, 'webRequest'>): void {
    ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !this.isAllowed(details.url) }));
  }

  /**
   * Loads electron-updater (only this module may import it) and guards its network session. Call after app ready.
   * Returns the platform AppUpdater singleton.
   */
  async loadAutoUpdater(): Promise<AppUpdater> {
    type UpdaterModule = { autoUpdater?: AppUpdater; default?: { autoUpdater: AppUpdater } };
    const mod = (await import('electron-updater')) as unknown as UpdaterModule;
    this.guardSession(session.fromPartition(UPDATER_SESSION_PARTITION, { cache: false }));
    return mod.autoUpdater ?? mod.default!.autoUpdater;
  }
}

export const netGate = new NetGate();
