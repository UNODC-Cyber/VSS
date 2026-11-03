/**
 * AES-256-GCM helpers (node:crypto). 96-bit IV, 128-bit tag appended to the ciphertext.
 */
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { CryptoError } from './errors';

export const GCM_IV_BYTES = 12;
export const GCM_TAG_BYTES = 16;

export function aesGcmSeal(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Buffer {
  if (key.length !== 32 || iv.length !== GCM_IV_BYTES) throw new CryptoError('BAD_REQUEST');
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: GCM_TAG_BYTES });
  c.setAAD(aad);
  const body = c.update(plaintext);
  const fin = c.final();
  const tag = c.getAuthTag();
  const out = Buffer.alloc(body.length + fin.length + tag.length);
  body.copy(out, 0);
  fin.copy(out, body.length);
  tag.copy(out, body.length + fin.length);
  body.fill(0);
  return out;
}

/** Returns null on authentication failure (never throws a distinguishing error). */
export function aesGcmOpen(key: Uint8Array, iv: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Buffer | null {
  if (key.length !== 32 || iv.length !== GCM_IV_BYTES || sealed.length < GCM_TAG_BYTES) return null;
  let body: Buffer | null = null;
  try {
    const d = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: GCM_TAG_BYTES });
    d.setAAD(aad);
    d.setAuthTag(sealed.subarray(sealed.length - GCM_TAG_BYTES));
    body = d.update(sealed.subarray(0, sealed.length - GCM_TAG_BYTES));
    d.final(); // throws on tag mismatch
    const out = Buffer.alloc(body.length);
    body.copy(out);
    return out;
  } catch {
    return null;
  } finally {
    // Wipe the (possibly unauthenticated) intermediate plaintext in every case.
    body?.fill(0);
  }
}
