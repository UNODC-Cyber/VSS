import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import type { FileKind, Result, VssApi, VssEventMap, VssEventName } from '@shared/ipc/contract';
import { composeApp } from '../../../src/main/app/compose';
import type { AppPorts, AppRoute, ComposeOptions, ComposedApp } from '../../../src/main/app/compose';
import type { AppPaths } from '../../../src/main/app/paths';
import { _resetAllLockoutsForTests } from '../../../src/main/crypto/lockout';
import type { ClipboardPort } from '../../../src/main/services/clipboard';
import type { FilesPort } from '../../../src/main/services/files';
import type { UpdateServiceFactory, UpdateServiceLike } from '../../../src/main/services/updates-wiring';
import { FAST_KDF } from '../crypto/helpers';

export const PW = 'correct horse battery staple 1';
export const PW2 = 'another synthetic passphrase 22';

export class FakeClipboard implements ClipboardPort {
  text = '';
  sensitive: boolean | null = null;
  async write(text: string, sensitive: boolean): Promise<void> {
    this.text = text;
    this.sensitive = sensitive;
  }
  async readText(): Promise<string> {
    return this.text;
  }
  async clear(): Promise<void> {
    this.text = '';
  }
}

export interface Recorder {
  events: { event: VssEventName; payload: unknown }[];
  routes: AppRoute[];
  rendererCleared: number;
  opened: string[];
  clipboard: FakeClipboard;
  files: { openResult: string | null; saveResult: string | null };
  idle: { seconds: number };
}

export function makePorts(): { ports: AppPorts; rec: Recorder } {
  const rec: Recorder = {
    events: [],
    routes: [],
    rendererCleared: 0,
    opened: [],
    clipboard: new FakeClipboard(),
    files: { openResult: null, saveResult: null },
    idle: { seconds: 0 },
  };
  const filesPort: FilesPort = {
    async showOpenDialog() {
      return rec.files.openResult === null
        ? { canceled: true, filePaths: [] }
        : { canceled: false, filePaths: [rec.files.openResult] };
    },
    async showSaveDialog() {
      return rec.files.saveResult === null ? { canceled: true } : { canceled: false, filePath: rec.files.saveResult };
    },
    showItemInFolder() {},
  };
  const ports: AppPorts = {
    files: filesPort,
    clipboard: rec.clipboard,
    openExternal: async (url) => void rec.opened.push(url),
    emit: <E extends VssEventName>(event: E, payload: VssEventMap[E]) => void rec.events.push({ event, payload }),
    navigate: (r) => void rec.routes.push(r),
    clearRendererState: async () => void rec.rendererCleared++,
    systemIdleSeconds: () => rec.idle.seconds,
    power: null,
  };
  return { ports, rec };
}

export interface FakeUpdates {
  unlockedCalls: number;
  factory: UpdateServiceFactory;
}
export function fakeUpdates(): FakeUpdates {
  const f: FakeUpdates = {
    unlockedCalls: 0,
    factory: async () => {
      const svc: UpdateServiceLike = {
        handlers: () => ({
          state: async () => ({ ok: false, error: { code: 'NOT_SUPPORTED', message: 'fake' } }),
          check: async () => ({ ok: false, error: { code: 'NOT_SUPPORTED', message: 'fake' } }),
          download: async () => ({ ok: false, error: { code: 'NOT_SUPPORTED', message: 'fake' } }),
          install: async () => ({ ok: false, error: { code: 'NOT_SUPPORTED', message: 'fake' } }),
        }),
        onUnlocked: async () => void f.unlockedCalls++,
      };
      return svc;
    },
  };
  return f;
}

/** Loosely typed result for assertions. */
export interface AnyResult {
  ok: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any;
  error: { code: string; message: string };
}

export interface TestApp {
  app: ComposedApp;
  rec: Recorder;
  paths: AppPaths;
  root: string;
  updates: FakeUpdates;
  call(ns: Exclude<keyof VssApi, 'on'>, method: string, arg?: unknown): Promise<AnyResult>;
  /** Simulate the user choosing `path` in the open (or folder) dialog; returns the token main hands out (F-02). */
  pickOpen(path: string, kind: FileKind): Promise<string>;
  /** Simulate the user choosing `path` in the save dialog; returns the token. */
  pickSave(path: string, kind: FileKind): Promise<string>;
  cleanup(): void;
}

export async function makeApp(extra: Partial<ComposeOptions> = {}): Promise<TestApp> {
  _resetAllLockoutsForTests();
  const root = mkdtempSync(join(tmpdir(), 'vss-app-'));
  const dataDir = join(root, 'vault');
  const paths: AppPaths = {
    dataDir,
    sessionDir: join(root, 'session'),
    migrationBackupDir: join(root, 'mig'),
    overridden: true,
  };
  const { ports, rec } = makePorts();
  const updates = fakeUpdates();
  const app = await composeApp({
    paths,
    ports,
    updates: updates.factory,
    kdf: FAST_KDF,
    backupKdf: FAST_KDF,
    lockTickMs: 1000,
    ...extra,
  });
  const call: TestApp['call'] = async (ns, method, arg) => {
    const h = (app.handlers as Record<string, Record<string, unknown> | undefined>)[ns]?.[method] as
      ((a: unknown, e: IpcMainInvokeEvent) => Promise<Result<unknown>>) | undefined;
    if (!h) return { ok: false, error: { code: 'NOT_SUPPORTED', message: 'no handler' } } as never;
    return (await h(arg, {} as IpcMainInvokeEvent)) as never;
  };
  const pickOpen: TestApp['pickOpen'] = async (path, kind) => {
    rec.files.openResult = path;
    const r = await call('files', 'pickOpen', { kind });
    rec.files.openResult = null;
    if (!r.ok || typeof r.value.path !== 'string') throw new Error(`pickOpen failed: ${r.error?.code}`);
    return r.value.path as string;
  };
  const pickSave: TestApp['pickSave'] = async (path, kind) => {
    rec.files.saveResult = path;
    const r = await call('files', 'pickSave', { kind, suggestedName: 'x' });
    rec.files.saveResult = null;
    if (!r.ok || typeof r.value.path !== 'string') throw new Error(`pickSave failed: ${r.error?.code}`);
    return r.value.path as string;
  };
  return {
    app,
    rec,
    paths,
    root,
    updates,
    call,
    pickOpen,
    pickSave,
    cleanup: () => {
      app.lock.dispose();
      try {
        app.vault.forceLock();
      } catch {
        // already locked
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
