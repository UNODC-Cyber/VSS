/**
 * Shared plumbing for the domain services (requests, responses, people, review, vetting): injected dependencies, the
 * Result boundary (nothing throws across it), one-transaction helper with a test fault hook, and small helpers.
 * Error messages are fixed English strings and never carry personal data.
 */
import { readFile, unlink, writeFile } from 'node:fs/promises';
import type { IsoDate, IsoDateTime, PersonName, Settings, Ulid, UnitType } from '@shared/domain/types';
import type { Result, VssErrorCode } from '@shared/ipc/contract';
import { err, ok } from '@shared/ipc/result';
import { isDbError, toVssErrorCode } from '../db/errors';
import type { Db } from '../db/open';
import type { Repos } from '../db/repos';
import type { AuditDetails, AuditLog } from './audit';

/** File access used by import (read) and export (write). Default: node:fs/promises. */
export interface FileIo {
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  remove?(path: string): Promise<void>;
}

/** Re-entry of the vault password for protected actions (purge, CSV export). Supplied by the vault lane. */
export type PasswordCheck = (password: string) => Promise<boolean>;

export interface ServiceDeps {
  db: Db;
  repos: Repos;
  audit: AuditLog;
  /** Injected clock (default: real time). */
  clock?: () => Date;
  /** Audit actor (default 'local-user'). */
  actor?: () => string;
  /** Current settings (default: repos.settings.getAll()). */
  settings?: () => Settings;
  files?: FileIo;
  verifyPassword?: PasswordCheck;
  /**
   * Test hook: called inside every write transaction just before it commits, with a step name such as
   * 'requests.importCommit'. A throw rolls the whole transaction back.
   */
  faultInjector?: (step: string) => void;
}

export class ServiceError extends Error {
  override readonly name = 'ServiceError';
  constructor(
    readonly code: VssErrorCode,
    message: string,
  ) {
    super(message);
  }
}
export const fail = (code: VssErrorCode, message: string): never => {
  throw new ServiceError(code, message);
};

const defaultFiles: FileIo = {
  read: async (p) => new Uint8Array(await readFile(p)),
  write: (p, b) => writeFile(p, b, { flag: 'wx' }),
  remove: (p) => unlink(p),
};

export interface Ctx {
  readonly db: Db;
  readonly repos: Repos;
  readonly files: FileIo;
  now(): Date;
  nowIso(): IsoDateTime;
  today(): IsoDate;
  actor(): string;
  settings(): Settings;
  verifyPassword(password: string): Promise<boolean>;
  /** One transaction; `step` names the fault-injection point that runs just before commit. */
  tx<T>(step: string, fn: () => T): T;
  /** Append exactly one audit event (call inside the same transaction as the change). */
  audit(type: string, subjectType: string, subjectId: Ulid | null, details?: AuditDetails): void;
}

export function makeCtx(d: ServiceDeps): Ctx {
  const now = d.clock ?? (() => new Date());
  return {
    db: d.db,
    repos: d.repos,
    files: d.files ?? defaultFiles,
    now,
    nowIso: () => now().toISOString(),
    today: () => now().toISOString().slice(0, 10),
    actor: d.actor ?? (() => 'local-user'),
    settings: d.settings ?? (() => d.repos.settings.getAll()),
    verifyPassword: async (pw) => (d.verifyPassword ? d.verifyPassword(pw) : false),
    tx<T>(step: string, fn: () => T): T {
      return d.db.transaction(() => {
        const r = fn();
        d.faultInjector?.(step);
        return r;
      });
    },
    audit(type, subjectType, subjectId, details = {}) {
      d.audit.append({
        actor: (d.actor ?? (() => 'local-user'))(),
        type,
        subjectType,
        subjectId,
        details,
        at: now().toISOString(),
      });
    },
  };
}

/** Run `fn` and map every failure onto a Result. Unknown errors become INTERNAL without their message (may hold PII). */
export async function run<T>(fn: () => T | Promise<T>): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    if (isDbError(e)) return err(toVssErrorCode(e.code), e.message);
    return err('INTERNAL', 'Internal error');
  }
}

export function displayName(n: PersonName): string {
  const given = n.given.join(' ').trim();
  const s = n.surname.trim();
  if (s === '') return given || n.raw.trim();
  return given === '' ? s : `${s}, ${given}`;
}

const UNIT_TYPES: readonly UnitType[] = ['Military', 'Other', 'Police', 'Prison'];
export function toUnitType(s: string): UnitType {
  const v = s.trim().toLowerCase();
  return UNIT_TYPES.find((t) => t.toLowerCase() === v) ?? 'Other';
}

export const blankToNull = (s: string | null | undefined): string | null =>
  s === null || s === undefined || s.trim() === '' ? null : s.trim();

/** Median of a non-empty list (mean of the two middle values for even length). */
export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
export function mean(xs: readonly number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Time-limited in-memory store for import previews (nothing is written to the DB until commit). */
export class PreviewStore<T> {
  private readonly map = new Map<string, { value: T; expiresAt: number }>();
  constructor(
    private readonly now: () => Date,
    private readonly ttlMs = 30 * 60_000,
  ) {}
  put(id: string, value: T): void {
    this.gc();
    this.map.set(id, { value, expiresAt: this.now().getTime() + this.ttlMs });
  }
  get(id: string): T {
    const e = this.map.get(id);
    if (!e || e.expiresAt < this.now().getTime()) {
      this.map.delete(id);
      return fail('PREVIEW_EXPIRED', 'Preview expired or unknown; import the file again');
    }
    return e.value;
  }
  delete(id: string): void {
    this.map.delete(id);
  }
  /** Drop every preview (on lock: parsed files and their personal data must not outlive the unlocked session). */
  clear(): void {
    this.map.clear();
  }
  private gc(): void {
    const t = this.now().getTime();
    for (const [k, v] of this.map) if (v.expiresAt < t) this.map.delete(k);
  }
}

export const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;
