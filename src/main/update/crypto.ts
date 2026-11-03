/**
 * Hybrid signature primitives for release manifests: Ed25519 (node:crypto) AND ML-DSA-65 (FIPS 204, @noble/post-quantum).
 * Private material is a 32-byte seed per algorithm; only the release tools ever hold seeds. The app only verifies.
 */
import { createHash, createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';

export const ED25519_PUBLIC_KEY_BYTES = 32;
export const ED25519_SIGNATURE_BYTES = 64;
export const MLDSA65_PUBLIC_KEY_BYTES = ml_dsa65.lengths.publicKey ?? 1952;
export const MLDSA65_SIGNATURE_BYTES = ml_dsa65.lengths.signature ?? 3309;
export const SEED_BYTES = 32;

/** FIPS 204 context strings: domain-separate manifest signatures from key-rotation statements. */
export const MLDSA_CONTEXT_MANIFEST = new TextEncoder().encode('VSS release manifest v1');
export const MLDSA_CONTEXT_ROTATION = new TextEncoder().encode('VSS key rotation v1');

const ED_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Strict base64 (RFC 4648 section 4, padded). Surrounding ASCII whitespace is tolerated. Returns null if invalid. */
export function decodeBase64Strict(input: string | Uint8Array): Uint8Array | null {
  const text = (typeof input === 'string' ? input : Buffer.from(input).toString('latin1')).trim();
  if (text.length === 0 || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  const bytes = Buffer.from(text, 'base64');
  if (bytes.toString('base64') !== text) return null;
  return new Uint8Array(bytes);
}

export const encodeBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

export const sha512Hex = (bytes: Uint8Array): string => createHash('sha512').update(bytes).digest('hex');

export function ed25519PublicFromSeed(seed: Uint8Array): Uint8Array {
  if (seed.length !== SEED_BYTES) throw new Error('Ed25519 seed must be 32 bytes');
  const priv = createPrivateKey({ key: Buffer.concat([ED_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(priv).export({ format: 'der', type: 'spki' });
  return new Uint8Array(spki.subarray(ED_SPKI_PREFIX.length));
}

export function ed25519Sign(seed: Uint8Array, message: Uint8Array): Uint8Array {
  if (seed.length !== SEED_BYTES) throw new Error('Ed25519 seed must be 32 bytes');
  const priv = createPrivateKey({ key: Buffer.concat([ED_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  return new Uint8Array(nodeSign(null, message, priv));
}

export function ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== ED25519_PUBLIC_KEY_BYTES || signature.length !== ED25519_SIGNATURE_BYTES) return false;
  try {
    const pub = createPublicKey({ key: Buffer.concat([ED_SPKI_PREFIX, publicKey]), format: 'der', type: 'spki' });
    return nodeVerify(null, message, pub, signature);
  } catch {
    return false;
  }
}

export function mldsa65PublicFromSeed(seed: Uint8Array): Uint8Array {
  if (seed.length !== SEED_BYTES) throw new Error('ML-DSA-65 seed must be 32 bytes');
  const { publicKey, secretKey } = ml_dsa65.keygen(seed);
  secretKey.fill(0);
  return publicKey;
}

export function mldsa65Sign(seed: Uint8Array, message: Uint8Array, context: Uint8Array): Uint8Array {
  if (seed.length !== SEED_BYTES) throw new Error('ML-DSA-65 seed must be 32 bytes');
  const { secretKey } = ml_dsa65.keygen(seed);
  try {
    return ml_dsa65.sign(message, secretKey, { context });
  } finally {
    secretKey.fill(0);
  }
}

export function mldsa65Verify(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
  context: Uint8Array,
): boolean {
  if (publicKey.length !== MLDSA65_PUBLIC_KEY_BYTES || signature.length !== MLDSA65_SIGNATURE_BYTES) return false;
  try {
    return ml_dsa65.verify(signature, message, publicKey, { context });
  } catch {
    return false;
  }
}

/** Short fingerprint of a hybrid key pair: first 16 hex chars of SHA-256(ed25519Pub || mldsa65Pub). */
export function keyIdOf(ed25519Public: Uint8Array, mldsa65Public: Uint8Array): string {
  return createHash('sha256').update(ed25519Public).update(mldsa65Public).digest('hex').slice(0, 16);
}
