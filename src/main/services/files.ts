/**
 * Native file dialogs and helpers (main process only). The renderer never gets to name a path itself.
 *
 * Security review F-02: files.pickOpen / files.pickSave do not hand the chosen path back. They return an opaque,
 * random token bound to (path, kind, mode). Every handler that reads or writes a user file takes such a token and
 * resolves it here; anything else (a raw path, a token of another kind or mode, an expired or used token) is
 * refused. Rules:
 * - save tokens are single-use and resolve to exactly the file the user chose; the extension must be one the
 *   dialog offered for that kind;
 * - folder tokens (backup folder) are single-use;
 * - open tokens grant read access to that one file until the vault locks or 30 minutes pass (the response import
 *   re-reads the same file when the user picks another request to match against); they never allow a write;
 * - files.reveal accepts a token or a path main itself wrote in this session.
 * All grants are dropped when the vault locks.
 */
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import type {
  Ack,
  FileKind,
  FilePickOpenRequest,
  FilePickResult,
  FilePickSaveRequest,
  FileRevealRequest,
  FileSaveStoredRequest,
  Result,
} from '@shared/ipc/contract';
import { err, ok } from '@shared/ipc/result';
import type { StoredFileRepo } from '../db/repos';

export interface FileFilter {
  name: string;
  extensions: string[];
}

export const FILE_FILTERS: Record<FileKind, FileFilter[]> = {
  'request-xlsx': [{ name: 'Excel workbook', extensions: ['xlsx', 'xlsm'] }],
  'response-xlsx': [{ name: 'Excel workbook', extensions: ['xlsx', 'xlsm'] }],
  vault: [{ name: 'VSS vault', extensions: ['json'] }],
  backup: [{ name: 'VSS backup', extensions: ['vssbak'] }],
  eml: [{ name: 'Email draft', extensions: ['eml'] }],
  csv: [{ name: 'CSV file', extensions: ['csv'] }],
  audit: [{ name: 'Audit log (JSON lines)', extensions: ['jsonl', 'json'] }],
  directory: [],
  any: [{ name: 'All files', extensions: ['*'] }],
};

/** The dialog/shell functions the service needs (Electron adapters live in app/electron-ports.ts). */
export interface FilesPort {
  /** `directory: true` picks a folder instead of a file. */
  showOpenDialog(opts: {
    title: string;
    filters: FileFilter[];
    directory?: boolean;
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
  showSaveDialog(opts: {
    title: string;
    defaultPath: string;
    filters: FileFilter[];
  }): Promise<{ canceled: boolean; filePath?: string | undefined }>;
  showItemInFolder(path: string): void;
}

// ---------------------------------------------------------------------------------------------------------------
// Path grants
// ---------------------------------------------------------------------------------------------------------------

export type GrantMode = 'open' | 'save' | 'directory';
export const TOKEN_PREFIX = 'vss-file:';
const TOKEN_RE = /^vss-file:[0-9a-f]{32}$/;
export const GRANT_TTL_MS = 30 * 60_000;
const MAX_GRANTS = 64;

interface Grant {
  path: string;
  kind: FileKind;
  mode: GrantMode;
  expiresAt: number;
}

export class PathGrantError extends Error {
  readonly code = 'BAD_REQUEST' as const;
  constructor() {
    super('Choose the file again');
    this.name = 'PathGrantError';
  }
}

export const isPathToken = (s: unknown): s is string => typeof s === 'string' && TOKEN_RE.test(s);

const extOk = (path: string, kind: FileKind): boolean => {
  const exts = FILE_FILTERS[kind].flatMap((f) => f.extensions);
  if (exts.length === 0 || exts.includes('*')) return true;
  return exts.includes(extname(path).slice(1).toLowerCase());
};

export class PathGrants {
  readonly #grants = new Map<string, Grant>();
  readonly #written = new Set<string>();
  readonly #now: () => number;
  #epoch = 0;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Issue a token for a dialog result. Throws PathGrantError for a relative path or a wrong extension. */
  issue(path: string, kind: FileKind, mode: GrantMode): string {
    if (!isAbsolute(path)) throw new PathGrantError();
    if (mode !== 'directory' && !extOk(path, kind)) throw new PathGrantError();
    this.#gc();
    while (this.#grants.size >= MAX_GRANTS) this.#grants.delete(this.#grants.keys().next().value!);
    const token = `${TOKEN_PREFIX}${randomBytes(16).toString('hex')}`;
    this.#grants.set(token, { path: resolve(path), kind, mode, expiresAt: this.#now() + GRANT_TTL_MS });
    return token;
  }

  /**
   * The path behind `token` if it was issued for `mode` and one of `kinds`. Save and folder tokens are consumed;
   * open tokens stay valid until they expire or `clear()`.
   */
  resolve(token: unknown, mode: GrantMode, kinds: readonly FileKind[]): string {
    if (!isPathToken(token)) throw new PathGrantError();
    const g = this.#grants.get(token);
    if (!g || g.expiresAt < this.#now() || g.mode !== mode || !kinds.includes(g.kind)) throw new PathGrantError();
    if (mode !== 'open') this.#grants.delete(token);
    return g.path;
  }

  /** Remember a path main wrote (export, eml, csv, audit) so files.reveal may show it. */
  noteWritten(path: string): void {
    this.#written.add(resolve(path));
  }

  /** Path for files.reveal: a live token of any kind/mode (not consumed), or a path main wrote. */
  revealable(pathOrToken: string): string {
    if (isPathToken(pathOrToken)) {
      const g = this.#grants.get(pathOrToken);
      if (!g || g.expiresAt < this.#now()) throw new PathGrantError();
      return g.path;
    }
    if (isAbsolute(pathOrToken) && this.#written.has(resolve(pathOrToken))) return resolve(pathOrToken);
    throw new PathGrantError();
  }

  /** Drop every grant (on lock). */
  clear(): void {
    this.#grants.clear();
    this.#written.clear();
    this.#epoch++;
  }

  /** Changes on every clear(): a dialog that was open across a lock must not issue a grant afterwards. */
  get epoch(): number {
    return this.#epoch;
  }

  get size(): number {
    return this.#grants.size;
  }

  #gc(): void {
    const t = this.#now();
    for (const [k, g] of this.#grants) if (g.expiresAt < t) this.#grants.delete(k);
  }
}

/** Run `fn` with a resolved path; a grant failure becomes BAD_REQUEST. */
export async function withGrant<T>(fn: () => Promise<Result<T>> | Result<T>): Promise<Result<T>> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PathGrantError) return err('BAD_REQUEST', e.message);
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------------

export interface FilesDeps {
  port: FilesPort;
  grants: PathGrants;
  /** Stored-file repo of the open DB; throws while locked. */
  storedFiles(): StoredFileRepo;
  /**
   * Wraps every pending native dialog (lane J): compose passes LockController.holdWhile so the idle lock does not
   * reload the window under an open modal dialog.
   */
  holdWhile?<T>(p: Promise<T>): Promise<T>;
  /** PII-free failure log (no message, no path). */
  onDialogError?(kind: 'open' | 'save'): void;
}

const NONE: FilePickResult = { path: null, displayPath: null };

export class FilesService {
  constructor(private readonly d: FilesDeps) {}

  /** Runs a dialog; a throw becomes an INTERNAL Result and a lock during the dialog discards the choice. */
  async #dialog<R>(
    kind: 'open' | 'save',
    show: () => Promise<R>,
  ): Promise<{ ok: true; value: R; stale: boolean } | { ok: false; error: Result<never> }> {
    const epoch = this.d.grants.epoch;
    try {
      const p = show();
      const value = await (this.d.holdWhile ? this.d.holdWhile(p) : p);
      return { ok: true, value, stale: this.d.grants.epoch !== epoch };
    } catch {
      this.d.onDialogError?.(kind);
      return { ok: false, error: err('INTERNAL', 'The file dialog could not be opened. Try again.') };
    }
  }

  async pickOpen(req: FilePickOpenRequest): Promise<Result<FilePickResult>> {
    const directory = req.kind === 'directory';
    const d = await this.#dialog('open', () =>
      this.d.port.showOpenDialog({
        title: req.title ?? (directory ? 'Choose folder' : 'Open file'),
        filters: FILE_FILTERS[req.kind],
        ...(directory ? { directory: true } : {}),
      }),
    );
    if (!d.ok) return d.error;
    const r = d.value;
    // The vault locked while the dialog was open: the choice belongs to the previous session.
    if (d.stale) return ok(NONE);
    const chosen = r.canceled ? null : (r.filePaths[0] ?? null);
    if (chosen === null) return ok(NONE);
    return withGrant(() =>
      ok({ path: this.d.grants.issue(chosen, req.kind, directory ? 'directory' : 'open'), displayPath: chosen }),
    );
  }

  async pickSave(req: FilePickSaveRequest): Promise<Result<FilePickResult>> {
    if (req.kind === 'directory') return err('BAD_REQUEST', 'Use pickOpen to choose a folder');
    const d = await this.#dialog('save', () =>
      this.d.port.showSaveDialog({
        title: req.title ?? 'Save file',
        defaultPath: req.suggestedName,
        filters: FILE_FILTERS[req.kind],
      }),
    );
    if (!d.ok) return d.error;
    if (d.stale) return ok(NONE);
    const r = d.value;
    const chosen = r.canceled ? null : (r.filePath ?? null);
    if (chosen === null) return ok(NONE);
    if (!extOk(chosen, req.kind)) return err('BAD_REQUEST', 'That file type cannot be saved here');
    return withGrant(() => ok({ path: this.d.grants.issue(chosen, req.kind, 'save'), displayPath: chosen }));
  }

  async reveal(req: FileRevealRequest): Promise<Result<Ack>> {
    return withGrant(() => {
      this.d.port.showItemInFolder(this.d.grants.revealable(req.path));
      return ok({ ok: true as const });
    });
  }

  async saveStored(req: FileSaveStoredRequest): Promise<Result<Ack>> {
    return withGrant(async () => {
      const dest = this.d.grants.resolve(req.destPath, 'save', ['request-xlsx', 'response-xlsx']);
      const repo = this.d.storedFiles();
      if (repo.isPurged(req.fileId)) return err('NOT_FOUND', 'This file was removed when a person was purged');
      const content = repo.content(req.fileId);
      if (!content) return err('NOT_FOUND', 'Stored file not found');
      if (!repo.verify(req.fileId)) return err('VAULT_CORRUPT', 'Stored file failed its integrity check');
      await writeFile(dest, content);
      this.d.grants.noteWritten(dest);
      return ok({ ok: true as const });
    });
  }
}
