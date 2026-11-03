/**
 * Generates a hybrid (Ed25519 + ML-DSA-65) update-signing key pair.
 *   node tools/release/run.mjs gen-keys --out <path-outside-any-repo> [--slot current|next]
 * Prints the PUBLIC key set (paste into src/main/update/keys.ts). Private seeds go ONLY to --out (created new, 0600).
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertOutsideRepo,
  formatKeySetTs,
  parseArgs,
  publicKeySetFromSeeds,
  serializeSeeds,
  ToolError,
  wipeSeeds,
} from './lib';
import type { SigningSeeds } from './lib';

const WARNING = `
################################################################################
#  PRIVATE UPDATE-SIGNING KEY MATERIAL WRITTEN TO:                             #
#    %OUT%
#  Anyone holding this file can ship code to every VSS installation.          #
#  - Keep it OFFLINE (encrypted removable media, two copies, separate places).#
#  - NEVER commit it, upload it, paste it into CI secrets, chat or email.     #
#  - See docs/RELEASE-RUNBOOK.md "Key ceremony".                              #
################################################################################
`;

export interface GenKeysResult {
  publicKeys: ReturnType<typeof publicKeySetFromSeeds>;
  outPath: string;
}

export function generateKeys(outPath: string, extraForbiddenRoots: readonly string[] = []): GenKeysResult {
  const out = resolve(outPath);
  assertOutsideRepo(out, extraForbiddenRoots);
  const ed25519Seed = new Uint8Array(randomBytes(32));
  const mldsa65Seed = new Uint8Array(randomBytes(32));
  const publicKeys = publicKeySetFromSeeds({ ed25519Seed, mldsa65Seed });
  const seeds: SigningSeeds = { keyId: publicKeys.id, ed25519Seed, mldsa65Seed };
  try {
    writeFileSync(out, serializeSeeds(seeds), { flag: 'wx', mode: 0o600 });
  } finally {
    wipeSeeds(seeds);
  }
  return { publicKeys, outPath: out };
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const outArg = args.get('out');
  if (!outArg) throw new ToolError('Usage: gen-keys --out <file outside any git repo> [--slot current|next]');
  const slot = args.get('slot') ?? 'current';
  if (slot !== 'current' && slot !== 'next') throw new ToolError('--slot must be current or next');
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const { publicKeys, outPath } = generateKeys(outArg, [repoRoot]);
  process.stderr.write(WARNING.replace('%OUT%', outPath));
  process.stdout.write(`// Public keys for src/main/update/keys.ts (slot: ${slot})\n${formatKeySetTs(slot, publicKeys)}\n`);
  return 0;
}
