/**
 * Re-verifies a release directory against the public keys embedded in src/main/update/keys.ts. Anyone can run it.
 *   node tools/release/run.mjs verify-release --dir <assets> [--expect-version x.y.z] [--allow-missing]
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { UPDATE_KEYS } from '../../src/main/update/keys';
import {
  checkManifestFreshness,
  MANIFEST_FILE,
  SIG_ED25519_FILE,
  SIG_MLDSA65_FILE,
  verifyFileHash,
  verifyManifest,
} from '../../src/main/update/verify';
import type { ReleaseManifest, TrustedUpdateKeys } from '../../src/main/update/verify';
import { parseArgs, ToolError } from './lib';
import { hashFile } from './sign-manifest';

export interface VerifyReport {
  ok: boolean;
  keyId: string | null;
  manifest: ReleaseManifest | null;
  problems: string[];
}

const readOpt = (p: string): Uint8Array | null => (existsSync(p) ? new Uint8Array(readFileSync(p)) : null);

export async function verifyReleaseDir(
  dir: string,
  opts: { keys?: TrustedUpdateKeys; expectVersion?: string; allowMissing?: boolean } = {},
): Promise<VerifyReport> {
  const problems: string[] = [];
  const bytes = readOpt(join(dir, MANIFEST_FILE));
  if (!bytes) return { ok: false, keyId: null, manifest: null, problems: [`${MANIFEST_FILE} not found`] };
  const res = verifyManifest(
    bytes,
    readOpt(join(dir, SIG_ED25519_FILE)),
    readOpt(join(dir, SIG_MLDSA65_FILE)),
    opts.keys ?? UPDATE_KEYS,
  );
  if (!res.ok) return { ok: false, keyId: null, manifest: null, problems: [`${res.reason}: ${res.message}`] };
  const { manifest, keyId } = res.value;
  const fresh = checkManifestFreshness(manifest, Date.now());
  if (!fresh.ok) problems.push(`${fresh.reason}: ${manifest.notBefore} .. ${manifest.notAfter}`);
  if (opts.expectVersion && manifest.version !== opts.expectVersion) {
    problems.push(`manifest version ${manifest.version} != expected ${opts.expectVersion}`);
  }
  for (const entry of manifest.files) {
    const p = join(dir, entry.name);
    if (!existsSync(p)) {
      if (!opts.allowMissing) problems.push(`${entry.name}: missing`);
      continue;
    }
    const v = verifyFileHash(entry, await hashFile(p));
    if (!v.ok) problems.push(`${entry.name}: ${v.reason}`);
  }
  return { ok: problems.length === 0, keyId, manifest, problems };
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, ['allow-missing']);
  const dir = args.get('dir');
  if (!dir) throw new ToolError('Usage: verify-release --dir <assets> [--expect-version x.y.z] [--allow-missing]');
  const expectVersion = args.get('expect-version');
  const r = await verifyReleaseDir(resolve(dir), {
    allowMissing: args.get('allow-missing') === 'true',
    ...(expectVersion ? { expectVersion } : {}),
  });
  if (r.ok) {
    process.stdout.write(`OK: ${r.manifest?.version} signed by ${r.keyId}; ${r.manifest?.files.length} file(s) verified.\n`);
    return 0;
  }
  for (const p of r.problems) process.stderr.write(`FAIL: ${p}\n`);
  return 1;
}
