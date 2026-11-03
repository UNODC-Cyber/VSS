import type { Result, VssError, VssErrorCode } from './contract';

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = (code: VssErrorCode, message: string): Result<never> => ({ ok: false, error: { code, message } });
export const isVssError = (e: unknown): e is VssError =>
  typeof e === 'object' && e !== null && 'code' in e && 'message' in e;
