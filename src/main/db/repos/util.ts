import { monotonicFactory } from 'ulid';
import type { IsoDateTime, Ulid } from '@shared/domain/types';
import type { Page, PageQuery } from '@shared/ipc/contract';

const mono = monotonicFactory();
/** New ULID (monotonic within a millisecond). */
export const newId = (): Ulid => mono();
export const nowIso = (): IsoDateTime => new Date().toISOString();

export function toJson(v: unknown): string {
  return JSON.stringify(v);
}
export function fromJson<T>(s: string | null | undefined, fallback: T): T {
  if (s === null || s === undefined || s === '') return fallback;
  return JSON.parse(s) as T;
}
export const bool = (n: number | null | undefined): boolean => n === 1;
export const b2i = (b: boolean): number => (b ? 1 : 0);

export function page<T>(items: T[], total: number, q: PageQuery): Page<T> {
  return { items, total, offset: q.offset, limit: q.limit };
}

/** `?,?,?` for an IN list. */
export const qs = (n: number): string => Array.from({ length: n }, () => '?').join(',');

/** Run `fn` over ids in chunks that stay below SQLite's bound-parameter limit. */
export function chunked<T>(ids: readonly string[], fn: (chunk: string[]) => T[], size = 500): T[] {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += size) out.push(...fn(ids.slice(i, i + size)));
  return out;
}
