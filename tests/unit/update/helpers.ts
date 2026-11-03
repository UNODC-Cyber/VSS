import { randomBytes } from 'node:crypto';
import { canonicalBytes } from '../../../src/main/update/canonical';
import {
  ed25519PublicFromSeed,
  ed25519Sign,
  encodeBase64,
  keyIdOf,
  MLDSA_CONTEXT_MANIFEST,
  mldsa65PublicFromSeed,
  mldsa65Sign,
  sha512Hex,
} from '../../../src/main/update/crypto';
import type { ReleaseManifest, UpdateKeySet } from '../../../src/main/update/verify';

export interface TestKey {
  seeds: { ed25519Seed: Uint8Array; mldsa65Seed: Uint8Array };
  pub: UpdateKeySet;
}

export function makeKey(): TestKey {
  const ed25519Seed = new Uint8Array(randomBytes(32));
  const mldsa65Seed = new Uint8Array(randomBytes(32));
  const ed = ed25519PublicFromSeed(ed25519Seed);
  const pq = mldsa65PublicFromSeed(mldsa65Seed);
  return {
    seeds: { ed25519Seed, mldsa65Seed },
    pub: { id: keyIdOf(ed, pq), ed25519: encodeBase64(ed), mldsa65: encodeBase64(pq) },
  };
}

export const INSTALLER_NAME = 'vss-1.2.0-x64-setup.exe';
export const INSTALLER_BYTES = new TextEncoder().encode('synthetic installer bytes for tests');

export function makeManifest(version = '1.2.0', installer = INSTALLER_BYTES): ReleaseManifest {
  return {
    formatVersion: 2,
    version,
    date: '2026-11-03',
    notBefore: '2026-11-03',
    notAfter: '2027-01-31',
    files: [
      { name: INSTALLER_NAME.replace('1.2.0', version), sha512: sha512Hex(installer), size: installer.length },
      { name: 'latest.yml', sha512: sha512Hex(new Uint8Array([1, 2, 3])), size: 3 },
    ],
  };
}

export interface Signed {
  bytes: Uint8Array;
  sigEd: string;
  sigPq: string;
}

export function signBytes(key: TestKey, bytes: Uint8Array): Signed {
  return {
    bytes,
    sigEd: encodeBase64(ed25519Sign(key.seeds.ed25519Seed, bytes)),
    sigPq: encodeBase64(mldsa65Sign(key.seeds.mldsa65Seed, bytes, MLDSA_CONTEXT_MANIFEST)),
  };
}

export const signManifest = (key: TestKey, m: ReleaseManifest): Signed => signBytes(key, canonicalBytes(m));

/** Flips one bit of a base64 signature's decoded bytes. */
export function tamperSig(b64: string): string {
  const b = Buffer.from(b64, 'base64');
  b[0] = b[0]! ^ 0x01;
  return b.toString('base64');
}
