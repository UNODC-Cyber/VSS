/**
 * Key derivation: Argon2id (hash-wasm, RFC 9106 v1.3) for passwords and HKDF (RFC 5869) via node:crypto.
 */
import { hkdfSync } from 'node:crypto';
import { argon2id } from 'hash-wasm';
import { CryptoError } from './errors';
import { passwordBytes, secureCopy, zeroize } from './zeroize';

export interface Argon2idParams {
  alg: 'argon2id';
  /** Argon2 version; only 0x13 (19). */
  v: 19;
  /** Memory in KiB. */
  m: number;
  /** Iterations (time cost). */
  t: number;
  /** Parallelism (lanes). */
  p: number;
}

const MiB = 1024; // in KiB

/** Default: m = 256 MiB, t = 3, p = 1. */
export const DEFAULT_KDF: Readonly<Argon2idParams> = Object.freeze({
  alg: 'argon2id',
  v: 19,
  m: 256 * MiB,
  t: 3,
  p: 1,
});

/**
 * Bounds enforced for every stored parameter set, both when creating and before deriving from a file read from disk
 * (the upper bounds stop a crafted vault/backup from exhausting memory or CPU before anything is authenticated).
 *
 * Ceiling (security review F-08, 2026-11-03): m <= 512 MiB, t <= 8 and m x t <= 2 GiB-passes (`maxCost`, in
 * KiB-passes). The default (256 MiB, t = 3) uses 768 MiB-passes; the worst file VSS still accepts costs about
 * 2.6 x the default (a few seconds), instead of 1 GiB x 16 (about 40 s and 1 GiB of RAM per attempt).
 */
export const KDF_LIMITS = Object.freeze({
  minM: 64 * MiB,
  maxM: 512 * MiB,
  minT: 1,
  maxT: 8,
  minP: 1,
  maxP: 8,
  maxCost: 2048 * MiB,
});

/** m x t in KiB-passes (the work one derivation costs). */
export const kdfCost = (p: Pick<Argon2idParams, 'm' | 't'>): number => p.m * p.t;

export function isValidKdfParams(p: unknown): p is Argon2idParams {
  if (typeof p !== 'object' || p === null) return false;
  const k = p as Record<string, unknown>;
  const int = (x: unknown, lo: number, hi: number) =>
    typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi;
  return (
    k.alg === 'argon2id' &&
    k.v === 19 &&
    int(k.m, KDF_LIMITS.minM, KDF_LIMITS.maxM) &&
    int(k.t, KDF_LIMITS.minT, KDF_LIMITS.maxT) &&
    int(k.p, KDF_LIMITS.minP, KDF_LIMITS.maxP) &&
    (k.m as number) * (k.t as number) <= KDF_LIMITS.maxCost &&
    Object.keys(k).length === 5
  );
}

export function assertKdfParams(p: unknown): asserts p is Argon2idParams {
  if (!isValidKdfParams(p)) throw new CryptoError('BAD_REQUEST');
}

/**
 * Raw Argon2id without parameter policy (used by known-answer tests and by the policy-checked wrappers below).
 * Returns a fresh Buffer the caller must zeroize.
 */
export async function argon2idRaw(opts: {
  password: Uint8Array;
  salt: Uint8Array;
  m: number;
  t: number;
  p: number;
  length: number;
}): Promise<Buffer> {
  const out = await argon2id({
    password: opts.password,
    salt: opts.salt,
    memorySize: opts.m,
    iterations: opts.t,
    parallelism: opts.p,
    hashLength: opts.length,
    outputType: 'binary',
  });
  const copy = secureCopy(out);
  zeroize(out);
  return copy;
}

/** Argon2id(password) with policy-checked params; 32-byte output. The password is NFC-normalised UTF-8. */
export async function derivePasswordKey(password: string, salt: Uint8Array, params: Argon2idParams): Promise<Buffer> {
  assertKdfParams(params);
  if (salt.length < 16) throw new CryptoError('BAD_REQUEST');
  const pw = passwordBytes(password);
  try {
    return await argon2idRaw({ password: pw, salt, m: params.m, t: params.t, p: params.p, length: 32 });
  } finally {
    zeroize(pw);
  }
}

/** HKDF (extract + expand) with any node:crypto digest. Returns a fresh Buffer the caller must zeroize. */
export function hkdf(
  digest: 'sha256' | 'sha512',
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string | Uint8Array,
  length: number,
): Buffer {
  const ab = hkdfSync(digest, ikm, salt, typeof info === 'string' ? Buffer.from(info, 'utf8') : info, length);
  const view = new Uint8Array(ab);
  const out = secureCopy(view);
  view.fill(0);
  return out;
}

/** HKDF-SHA-512. */
export function hkdfSha512(ikm: Uint8Array, salt: Uint8Array, info: string, length = 32): Buffer {
  return hkdf('sha512', ikm, salt, info, length);
}

export interface AutoTuneResult {
  params: Argon2idParams;
  /** Measured duration of one derivation with `params`, in ms. */
  ms: number;
}

/**
 * Pick Argon2id parameters that take at least `targetMs` (default 700 ms) on this machine.
 * Starts from 256 MiB; if that allocation fails it halves memory down to the 64 MiB floor. Time cost starts at
 * `minT` (default 2) and grows until the target is met (capped at KDF_LIMITS.maxT). Parallelism stays 1 because
 * hash-wasm is single-threaded.
 */
export async function autoTune(
  opts: { targetMs?: number; minT?: number; startM?: number } = {},
): Promise<AutoTuneResult> {
  const targetMs = opts.targetMs ?? 700;
  const salt = Buffer.alloc(16, 0x5a);
  const pw = Buffer.from('vss-autotune', 'utf8');
  let m = opts.startM ?? DEFAULT_KDF.m;
  let t = Math.max(KDF_LIMITS.minT, opts.minT ?? 2);
  const time = async (mm: number, tt: number) => {
    const s = performance.now();
    const h = await argon2idRaw({ password: pw, salt, m: mm, t: tt, p: 1, length: 32 });
    zeroize(h);
    return performance.now() - s;
  };
  let ms: number;
  for (;;) {
    try {
      ms = await time(m, t);
      break;
    } catch {
      if (m / 2 < KDF_LIMITS.minM) throw new CryptoError('BAD_REQUEST');
      m = Math.floor(m / 2);
    }
  }
  const maxT = Math.min(KDF_LIMITS.maxT, Math.floor(KDF_LIMITS.maxCost / m));
  while (ms < targetMs && t < maxT) {
    // Time scales roughly linearly with t: jump close to the target, then verify.
    const next = Math.min(maxT, Math.max(t + 1, Math.ceil((t * targetMs) / Math.max(ms, 1))));
    t = next;
    ms = await time(m, t);
  }
  return { params: { alg: 'argon2id', v: 19, m, t, p: 1 }, ms };
}
