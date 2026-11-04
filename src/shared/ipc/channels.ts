/**
 * Channel-name map `vss:<ns>.<method>` and event channels. Dependency-free so the sandboxed preload can import it.
 * `METHODS` must list exactly the methods of `VssApi` (enforced at compile time by `AssertExact` below).
 */
import type { VssApi, VssEventName } from './contract';

export const METHODS = {
  vault: [
    'status',
    'create',
    'open',
    'unlock',
    'lock',
    'changePassword',
    'enrollFido2',
    'removeSlot',
    'backup',
    'restore',
    'wipe',
    'touch',
  ],
  settings: ['get', 'update'],
  requests: [
    'list',
    'get',
    'importPreview',
    'importCommit',
    'createManual',
    'update',
    'setStatus',
    'setItemDecision',
    'linkItem',
    'exportPreview',
    'export',
    'remove',
    'close',
    'reopen',
    'discardPreview',
  ],
  requestors: ['search', 'get', 'upsert', 'merge', 'list'],
  responses: [
    'list',
    'get',
    'importPreview',
    'importCommit',
    'setRowMatch',
    'recordEmailClearance',
    'recordManual',
    'discardPreview',
  ],
  persons: ['list', 'get', 'update', 'merge', 'unmerge', 'split', 'markNotSame', 'purge', 'scanDuplicates', 'suggest'],
  units: ['list', 'get', 'update', 'addAlias', 'merge'],
  review: ['list', 'get', 'resolve', 'counts', 'manualValidate', 'editSubject'],
  email: ['draft', 'writeEml', 'mailto', 'renderTemplate', 'previewTemplate'],
  stats: ['dashboard', 'expiryWatch', 'exportExpiryCsv'],
  backup: ['configure', 'list', 'runNow', 'restore'],
  clipboard: ['copy', 'clear'],
  updates: ['state', 'check', 'download', 'install'],
  audit: ['list', 'verify', 'export'],
  peer: ['status', 'setEnabled', 'pair', 'forget', 'syncNow'],
  templates: ['list', 'import', 'setActive', 'remove'],
  files: ['pickOpen', 'pickSave', 'reveal', 'saveStored'],
  app: ['info', 'openFeedback'],
} as const;

export type Namespace = keyof typeof METHODS;
export type MethodOf<N extends Namespace> = (typeof METHODS)[N][number];
export type ChannelName = {
  [N in Namespace]: `vss:${N}.${MethodOf<N>}`;
}[Namespace];

/** Compile-time proof that METHODS and VssApi agree in both directions. */
type ApiNamespaces = Exclude<keyof VssApi, 'on'>;
type _NsMatch = [Namespace] extends [ApiNamespaces] ? ([ApiNamespaces] extends [Namespace] ? true : never) : never;
type _MethodMatch = {
  [N in Namespace]: [MethodOf<N>] extends [keyof VssApi[N]]
    ? [keyof VssApi[N]] extends [MethodOf<N>]
      ? true
      : never
    : never;
};
export const _assertContract: [_NsMatch, _MethodMatch[Namespace]] = [true, true];

export function channelName<N extends Namespace>(ns: N, method: MethodOf<N>): ChannelName {
  return `vss:${ns}.${method}` as ChannelName;
}

export const NAMESPACES = Object.keys(METHODS) as Namespace[];

/** Every invokable channel. */
export const ALL_CHANNELS: readonly ChannelName[] = NAMESPACES.flatMap((ns) =>
  (METHODS[ns] as readonly string[]).map((m) => `vss:${ns}.${m}` as ChannelName),
);

export const EVENT_CHANNEL_PREFIX = 'vss:event:';
export function eventChannel(event: VssEventName): string {
  return `${EVENT_CHANNEL_PREFIX}${event}`;
}

/** Split a channel name into [namespace, method]. */
export function parseChannel(channel: string): [Namespace, string] | null {
  const m = /^vss:([a-z]+)\.([A-Za-z0-9]+)$/.exec(channel);
  if (!m) return null;
  const ns = m[1] as Namespace;
  const method = m[2] as string;
  if (!(ns in METHODS) || !(METHODS[ns] as readonly string[]).includes(method)) return null;
  return [ns, method];
}
