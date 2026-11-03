/**
 * Backup envelope: chunked XChaCha20-Poly1305 (@noble/ciphers) under a key derived from a passphrase with Argon2id.
 *
 * Layout (all integers big-endian):
 *   0  magic     8  'VSSBKUP\0'
 *   8  version   1  0x01
 *   9  m (KiB)   4  Argon2id memory
 *  13  t         1  Argon2id iterations
 *  14  p         1  Argon2id parallelism
 *  15  salt     32
 *  47  nprefix  19  random nonce prefix
 *  66  chunk     4  plaintext chunk size (4 KiB .. 16 MiB)
 *  70  length    8  total plaintext length
 *  78  chunks: ceil(length / chunk) segments (at least one), each = ciphertext || 16-byte tag
 *
 * key   = HKDF-SHA-512(Argon2id(passphrase, salt, m/t/p), salt, 'vss-backup-v1')
 * nonce = nprefix || u32(chunk index) || u8(1 for the final chunk else 0)
 * AAD   = the 78 header bytes (binds params, length and chunk size; the final flag + index stop truncation/reordering)
 *
 * The streaming functions keep memory at O(chunk size); the byte-array functions hold input + output (two copies).
 */
import { randomBytes } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { open, rename, rm } from 'node:fs/promises';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { CryptoError } from './errors';
import { DEFAULT_KDF, derivePasswordKey, hkdfSha512, isValidKdfParams } from './kdf';
import type { Argon2idParams } from './kdf';
import { zeroize } from './zeroize';

export const BACKUP_MAGIC = Buffer.from('VSSBKUP\0', 'latin1');
export const BACKUP_VERSION = 1;
export const BACKUP_HEADER_BYTES = 78;
export const TAG_BYTES = 16;
export const DEFAULT_CHUNK = 1024 * 1024;
const MIN_CHUNK = 4 * 1024;
const MAX_CHUNK = 16 * 1024 * 1024;
const SALT_BYTES = 32;
const PREFIX_BYTES = 19;
const INFO = 'vss-backup-v1';

/** Random-access byte source. `read` fills `buf` from `position` and returns the number of bytes read. */
export interface ByteSource {
  readonly length: number;
  read(buf: Uint8Array, position: number): Promise<number>;
}
/** Sequential byte sink. */
export interface ByteSink {
  write(chunk: Uint8Array): Promise<void>;
}

export interface SealOptions {
  kdf?: Argon2idParams;
  chunkSize?: number;
}

interface ParsedHeader {
  kdf: Argon2idParams;
  salt: Buffer;
  prefix: Buffer;
  chunk: number;
  length: number;
  raw: Buffer;
}

const chunkCount = (length: number, chunk: number) => Math.max(1, Math.ceil(length / chunk));

/** Total envelope size for a plaintext of `length` bytes. */
export function sealedLength(length: number, chunkSize = DEFAULT_CHUNK): number {
  return BACKUP_HEADER_BYTES + length + chunkCount(length, chunkSize) * TAG_BYTES;
}

function buildHeader(kdf: Argon2idParams, chunk: number, length: number): ParsedHeader {
  const raw = Buffer.alloc(BACKUP_HEADER_BYTES);
  const salt = randomBytes(SALT_BYTES);
  const prefix = randomBytes(PREFIX_BYTES);
  BACKUP_MAGIC.copy(raw, 0);
  raw.writeUInt8(BACKUP_VERSION, 8);
  raw.writeUInt32BE(kdf.m, 9);
  raw.writeUInt8(kdf.t, 13);
  raw.writeUInt8(kdf.p, 14);
  salt.copy(raw, 15);
  prefix.copy(raw, 47);
  raw.writeUInt32BE(chunk, 66);
  raw.writeBigUInt64BE(BigInt(length), 70);
  return { kdf, salt, prefix, chunk, length, raw };
}

function parseHeader(raw: Buffer, totalLength: number): ParsedHeader {
  if (raw.length !== BACKUP_HEADER_BYTES) throw new CryptoError('BACKUP_INVALID');
  if (!raw.subarray(0, 8).equals(BACKUP_MAGIC) || raw.readUInt8(8) !== BACKUP_VERSION) {
    throw new CryptoError('BACKUP_INVALID');
  }
  const kdf: Argon2idParams = {
    alg: 'argon2id',
    v: 19,
    m: raw.readUInt32BE(9),
    t: raw.readUInt8(13),
    p: raw.readUInt8(14),
  };
  // Bounds checked BEFORE any derivation so a crafted file cannot demand gigabytes of memory.
  if (!isValidKdfParams(kdf)) throw new CryptoError('BACKUP_INVALID');
  const chunk = raw.readUInt32BE(66);
  if (chunk < MIN_CHUNK || chunk > MAX_CHUNK) throw new CryptoError('BACKUP_INVALID');
  const big = raw.readBigUInt64BE(70);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new CryptoError('BACKUP_INVALID');
  const length = Number(big);
  if (sealedLength(length, chunk) !== totalLength) throw new CryptoError('BACKUP_INVALID');
  return {
    kdf,
    salt: Buffer.from(raw.subarray(15, 47)),
    prefix: Buffer.from(raw.subarray(47, 66)),
    chunk,
    length,
    raw: Buffer.from(raw),
  };
}

function nonce(prefix: Uint8Array, index: number, final: boolean): Uint8Array {
  const n = new Uint8Array(24);
  n.set(prefix, 0);
  new DataView(n.buffer).setUint32(PREFIX_BYTES, index, false);
  n[23] = final ? 1 : 0;
  return n;
}

async function deriveKey(passphrase: string, h: ParsedHeader): Promise<Buffer> {
  if (typeof passphrase !== 'string' || passphrase.length === 0) throw new CryptoError('BAD_REQUEST');
  const ikm = await derivePasswordKey(passphrase, h.salt, h.kdf);
  try {
    return hkdfSha512(ikm, h.salt, INFO, 32);
  } finally {
    zeroize(ikm);
  }
}

async function readExact(src: ByteSource, buf: Uint8Array, pos: number): Promise<void> {
  let off = 0;
  while (off < buf.length) {
    const n = await src.read(buf.subarray(off), pos + off);
    if (n <= 0) throw new CryptoError('BACKUP_INVALID');
    off += n;
  }
}

/** Stream-encrypt `src` into `sink`. Returns the number of envelope bytes written. */
export async function sealStream(
  src: ByteSource,
  sink: ByteSink,
  passphrase: string,
  opts: SealOptions = {},
): Promise<number> {
  const kdf = opts.kdf ?? DEFAULT_KDF;
  const chunk = opts.chunkSize ?? DEFAULT_CHUNK;
  if (!isValidKdfParams(kdf) || !Number.isInteger(chunk) || chunk < MIN_CHUNK || chunk > MAX_CHUNK) {
    throw new CryptoError('BAD_REQUEST');
  }
  const h = buildHeader(kdf, chunk, src.length);
  const key = await deriveKey(passphrase, h);
  const plain = Buffer.alloc(Math.min(chunk, Math.max(src.length, 0)));
  const out = Buffer.alloc(plain.length + TAG_BYTES);
  try {
    await sink.write(h.raw);
    let written = h.raw.length;
    const n = chunkCount(src.length, chunk);
    for (let i = 0; i < n; i++) {
      const pos = i * chunk;
      const len = Math.min(chunk, src.length - pos);
      const p = plain.subarray(0, len);
      await readExact(src, p, pos);
      const o = out.subarray(0, len + TAG_BYTES);
      xchacha20poly1305(key, nonce(h.prefix, i, i === n - 1), h.raw).encrypt(p, o);
      await sink.write(o);
      written += o.length;
    }
    return written;
  } finally {
    zeroize(key, plain);
  }
}

/**
 * Stream-decrypt `src` into `sink`. Each chunk is authenticated before it is written, but earlier chunks have been
 * written when a later one fails: the sink must discard its output if this throws (BACKUP_INVALID).
 */
export async function openStream(src: ByteSource, sink: ByteSink, passphrase: string): Promise<number> {
  if (src.length < BACKUP_HEADER_BYTES) throw new CryptoError('BACKUP_INVALID');
  const raw = Buffer.alloc(BACKUP_HEADER_BYTES);
  await readExact(src, raw, 0);
  const h = parseHeader(raw, src.length);
  const key = await deriveKey(passphrase, h);
  const sealed = Buffer.alloc(Math.min(h.chunk, h.length) + TAG_BYTES);
  const plain = Buffer.alloc(Math.min(h.chunk, h.length));
  try {
    const n = chunkCount(h.length, h.chunk);
    let pos = BACKUP_HEADER_BYTES;
    for (let i = 0; i < n; i++) {
      const len = Math.min(h.chunk, h.length - i * h.chunk);
      const s = sealed.subarray(0, len + TAG_BYTES);
      await readExact(src, s, pos);
      pos += s.length;
      const p = plain.subarray(0, len);
      try {
        xchacha20poly1305(key, nonce(h.prefix, i, i === n - 1), h.raw).decrypt(s, p);
      } catch {
        throw new CryptoError('BACKUP_INVALID');
      }
      await sink.write(p);
    }
    return h.length;
  } finally {
    zeroize(key, plain);
  }
}

const bytesSource = (b: Uint8Array): ByteSource => ({
  length: b.length,
  async read(buf, position) {
    const n = Math.min(buf.length, b.length - position);
    if (n <= 0) return 0;
    buf.set(b.subarray(position, position + n));
    return n;
  },
});

/** Encrypt a byte array (memory: input + one output buffer). */
export async function sealBackup(plain: Uint8Array, passphrase: string, opts: SealOptions = {}): Promise<Buffer> {
  const out = Buffer.alloc(sealedLength(plain.length, opts.chunkSize ?? DEFAULT_CHUNK));
  let off = 0;
  await sealStream(
    bytesSource(plain),
    { write: async (c) => void (out.set(c, off), (off += c.length)) },
    passphrase,
    opts,
  );
  return out;
}

/** Decrypt a byte array (memory: input + one output buffer). Any corruption or wrong passphrase => BACKUP_INVALID. */
export async function openBackup(sealed: Uint8Array, passphrase: string): Promise<Buffer> {
  if (sealed.length < BACKUP_HEADER_BYTES) throw new CryptoError('BACKUP_INVALID');
  const length = Number(Buffer.from(sealed.buffer, sealed.byteOffset, sealed.length).readBigUInt64BE(70));
  if (!Number.isSafeInteger(length) || length > sealed.length) throw new CryptoError('BACKUP_INVALID');
  const out = Buffer.alloc(length);
  let off = 0;
  try {
    await openStream(
      bytesSource(sealed),
      { write: async (c) => void (out.set(c, off), (off += c.length)) },
      passphrase,
    );
  } catch (e) {
    zeroize(out);
    throw e;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------------------------------------------

export function fileSource(fh: FileHandle, length: number): ByteSource {
  return {
    length,
    async read(buf, position) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, position);
      return bytesRead;
    },
  };
}

/** Concatenate sources (e.g. a small prefix buffer followed by a file). */
export function concatSources(parts: ByteSource[]): ByteSource {
  const length = parts.reduce((a, p) => a + p.length, 0);
  return {
    length,
    async read(buf, position) {
      let base = 0;
      for (const p of parts) {
        if (position < base + p.length)
          return p.read(buf.subarray(0, Math.min(buf.length, base + p.length - position)), position - base);
        base += p.length;
      }
      return 0;
    },
  };
}

export { bytesSource };

/**
 * Write an envelope to `destPath` atomically (temp file + rename). `onBytes` observes every envelope byte written
 * (e.g. to hash it). Returns the envelope size.
 */
export async function sealToFile(
  src: ByteSource,
  destPath: string,
  passphrase: string,
  opts: SealOptions & { onBytes?: (b: Uint8Array) => void } = {},
): Promise<number> {
  const tmp = `${destPath}.${randomBytes(6).toString('hex')}.tmp`;
  const fh = await open(tmp, 'wx');
  try {
    let pos = 0;
    const n = await sealStream(
      src,
      {
        async write(c) {
          opts.onBytes?.(c);
          let off = 0;
          while (off < c.length) {
            const { bytesWritten } = await fh.write(c, off, c.length - off, pos);
            off += bytesWritten;
            pos += bytesWritten;
          }
        },
      },
      passphrase,
      opts,
    );
    await fh.sync();
    await fh.close();
    await rename(tmp, destPath);
    return n;
  } catch (e) {
    await fh.close().catch(() => undefined);
    await rm(tmp, { force: true });
    throw e;
  }
}
