/**
 * Best-effort zeroisation of key material. JavaScript strings are immutable and cannot be wiped, so secrets are kept
 * in Buffers/Uint8Arrays wherever possible and overwritten as soon as they are no longer needed.
 */

export type Wipeable = Uint8Array | null | undefined;

/** Overwrite every given buffer with zeros. Null/undefined entries are ignored. */
export function zeroize(...bufs: Wipeable[]): void {
  for (const b of bufs) if (b) b.fill(0);
}

/** True when every byte of `b` is zero. */
export function isZeroed(b: Uint8Array): boolean {
  for (const x of b) if (x !== 0) return false;
  return true;
}

/** Copy `src` into a fresh, non-pooled Buffer (Buffer.from may slice the shared pool, which cannot be wiped safely). */
export function secureCopy(src: Uint8Array): Buffer {
  const out = Buffer.alloc(src.length);
  out.set(src);
  return out;
}

/** UTF-8 encode a password (NFC-normalised) into a fresh, non-pooled Buffer. The caller must zeroize it. */
export function passwordBytes(password: string): Buffer {
  const normalised = password.normalize('NFC');
  const out = Buffer.alloc(Buffer.byteLength(normalised, 'utf8'));
  out.write(normalised, 0, 'utf8');
  return out;
}

/** Run `fn` with the given buffers and zeroize them afterwards, also on error. */
export async function withWiped<T>(bufs: Wipeable[], fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } finally {
    zeroize(...bufs);
  }
}
