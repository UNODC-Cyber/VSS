/**
 * Builds and signs release-manifest.json for a directory of release assets (run OFFLINE by the key holder).
 *   node tools/release/run.mjs sign-manifest --dir <assets> --version <x.y.z> --seeds <seed-file|-> [--date YYYY-MM-DD]
 *        [--allow-unembedded-key]
 * Seeds are read from a file path or stdin ("-"), never from environment variables or the repository.
 */
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalBytes } from '../../src/main/update/canonical';
import { ed25519Sign, encodeBase64, MLDSA_CONTEXT_MANIFEST, mldsa65Sign } from '../../src/main/update/crypto';
import { UPDATE_KEYS } from '../../src/main/update/keys';
import {
  MANIFEST_FILE,
  SIG_ED25519_FILE,
  SIG_MLDSA65_FILE,
  MAX_VALIDITY_DAYS,
  validateManifest,
  verifyManifest,
} from '../../src/main/update/verify';
import type { ReleaseManifest, TrustedUpdateKeys } from '../../src/main/update/verify';
import { parseArgs, publicKeySetFromSeeds, readSeeds, ToolError, wipeSeeds } from './lib';
import type { SigningSeeds } from './lib';

const OUTPUT_FILES = new Set([MANIFEST_FILE, SIG_ED25519_FILE, SIG_MLDSA65_FILE]);

export async function hashFile(path: string): Promise<{ sha512Hex: string; size: number }> {
  const h = createHash('sha512');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const b = chunk as Buffer;
    size += b.length;
    h.update(b);
  }
  return { sha512Hex: h.digest('hex'), size };
}

/** Lists the regular files of `dir` that belong in the manifest (everything except the manifest and signatures). */
export function listAssets(dir: string): string[] {
  return readdirSync(dir)
    .filter((n) => !OUTPUT_FILES.has(n) && statSync(join(dir, n)).isFile())
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Default signed validity window (days from the signing date); at most MAX_VALIDITY_DAYS. */
export const DEFAULT_VALID_DAYS = 90;

const plusDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);

export async function buildManifest(
  dir: string,
  version: string,
  date: string,
  validDays = DEFAULT_VALID_DAYS,
): Promise<ReleaseManifest> {
  if (!Number.isInteger(validDays) || validDays < 1 || validDays > MAX_VALIDITY_DAYS) {
    throw new ToolError(`--valid-days must be 1..${MAX_VALIDITY_DAYS}`);
  }
  const files = [];
  for (const name of listAssets(dir)) {
    const { sha512Hex, size } = await hashFile(join(dir, name));
    files.push({ name, sha512: sha512Hex, size });
  }
  const manifest: ReleaseManifest = {
    formatVersion: 2,
    version,
    date,
    notBefore: date,
    notAfter: plusDays(date, validDays),
    files,
  };
  const invalid = validateManifest(manifest);
  if (invalid) throw new ToolError(`Cannot build manifest: ${invalid}`);
  return manifest;
}

export interface SignResult {
  manifest: ReleaseManifest;
  keyId: string;
  embedded: boolean;
}

/** Signs and writes the three output files, then re-verifies them with the derived public key. */
export async function signRelease(
  dir: string,
  version: string,
  date: string,
  seeds: SigningSeeds,
  opts: { trusted?: TrustedUpdateKeys; allowUnembeddedKey?: boolean; validDays?: number } = {},
): Promise<SignResult> {
  const trusted = opts.trusted ?? UPDATE_KEYS;
  const pub = publicKeySetFromSeeds(seeds);
  const embedded = trusted.current.id === pub.id || trusted.next?.id === pub.id;
  if (!embedded && !opts.allowUnembeddedKey) {
    throw new ToolError(
      `Signing key ${pub.id} is not embedded in src/main/update/keys.ts (current/next); installed apps would reject it.`,
    );
  }
  const manifest = await buildManifest(dir, version, date, opts.validDays);
  const bytes = canonicalBytes(manifest);
  const sigEd = encodeBase64(ed25519Sign(seeds.ed25519Seed, bytes));
  const sigPq = encodeBase64(mldsa65Sign(seeds.mldsa65Seed, bytes, MLDSA_CONTEXT_MANIFEST));
  const check = verifyManifest(bytes, sigEd, sigPq, { current: pub, next: null });
  if (!check.ok) throw new ToolError(`Self-verification failed: ${check.message}`);
  writeFileSync(join(dir, MANIFEST_FILE), bytes);
  writeFileSync(join(dir, SIG_ED25519_FILE), sigEd);
  writeFileSync(join(dir, SIG_MLDSA65_FILE), sigPq);
  return { manifest, keyId: pub.id, embedded };
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, ['allow-unembedded-key']);
  const dir = args.get('dir');
  const version = args.get('version');
  const seedSource = args.get('seeds');
  if (!dir || !version || !seedSource) {
    throw new ToolError(
      'Usage: sign-manifest --dir <assets> --version <x.y.z> --seeds <file|-> [--date YYYY-MM-DD] [--valid-days N]',
    );
  }
  const date = args.get('date') ?? new Date().toISOString().slice(0, 10);
  const validDays = args.get('valid-days');
  const seeds = await readSeeds(seedSource);
  try {
    const r = await signRelease(resolve(dir), version, date, seeds, {
      allowUnembeddedKey: args.get('allow-unembedded-key') === 'true',
      ...(validDays ? { validDays: Number(validDays) } : {}),
    });
    if (!r.embedded) process.stderr.write('WARNING: signed with a key that is NOT embedded in keys.ts.\n');
    process.stdout.write(`Signed ${r.manifest.files.length} file(s) for ${version} with key ${r.keyId}.\n`);
    process.stdout.write(`Valid ${r.manifest.notBefore} .. ${r.manifest.notAfter} UTC; re-sign before it expires.\n`);
    for (const f of r.manifest.files) process.stdout.write(`  ${f.sha512}  ${f.size}  ${f.name}\n`);
    return 0;
  } finally {
    wipeSeeds(seeds);
  }
}
