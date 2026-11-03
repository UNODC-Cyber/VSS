import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Argon2idParams } from '../../../src/main/crypto/kdf';

/** Cheapest parameters the policy accepts (64 MiB, t=1): fast enough for unit tests. */
export const FAST_KDF: Argon2idParams = { alg: 'argon2id', v: 19, m: 64 * 1024, t: 1, p: 1 };

/** Synthetic test password (not a real credential). */
export const PW = 'correct horse battery staple 1';

/** True when slow crypto tests (default Argon2id params, 200 MB envelope) should be skipped. */
export const SKIP_SLOW = process.env.VSS_SKIP_SLOW_CRYPTO === '1';

const dirs: string[] = [];
export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'vss-crypto-'));
  dirs.push(d);
  return d;
}
export function cleanupTempDirs(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}
export function writeJson(path: string, v: unknown): void {
  writeFileSync(path, JSON.stringify(v, null, 2));
}

/** Flip one bit of a canonical base64 string, keeping it canonical. */
export function flipB64(s: string, byte = 0): string {
  const b = Buffer.from(s, 'base64');
  b[byte] = (b[byte] ?? 0) ^ 0x01;
  return b.toString('base64');
}
