/** Shared helpers for the offline release tools. Never logs, stores or transmits private seeds. */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import {
  decodeBase64Strict,
  ed25519PublicFromSeed,
  encodeBase64,
  keyIdOf,
  mldsa65PublicFromSeed,
  SEED_BYTES,
} from '../../src/main/update/crypto';
import type { UpdateKeySet } from '../../src/main/update/verify';

export const SEED_FILE_KIND = 'vss-update-signing-seeds';

export interface SigningSeeds {
  keyId: string;
  ed25519Seed: Uint8Array;
  mldsa65Seed: Uint8Array;
}

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

/** Minimal `--flag value` / `--switch` parser. */
export function parseArgs(argv: readonly string[], switches: readonly string[] = []): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) throw new ToolError(`Unexpected argument: ${a}`);
    const name = a.slice(2);
    if (switches.includes(name)) {
      out.set(name, 'true');
      continue;
    }
    const v = argv[i + 1];
    if (v === undefined || (v.startsWith('--') && v !== '-')) throw new ToolError(`Missing value for --${name}`);
    out.set(name, v);
    i++;
  }
  return out;
}

/** Nearest existing ancestor (resolving symlinks), so not-yet-created paths are checked against real locations. */
function realAncestor(p: string): string {
  let cur = resolve(p);
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) return cur;
    cur = up;
  }
  try {
    return realpathSync(cur);
  } catch {
    return cur;
  }
}

/** Returns the git work tree root containing `p` (a `.git` dir or file in an ancestor), or null. */
export function findGitWorkTree(p: string): string | null {
  let cur = realAncestor(p);
  const { root } = parse(cur);
  for (;;) {
    if (existsSync(join(cur, '.git'))) return cur;
    if (cur === root) return null;
    cur = dirname(cur);
  }
}

/** Private seeds must never be written inside a git work tree (this repo or any other). */
export function assertOutsideRepo(outPath: string, extraForbiddenRoots: readonly string[] = []): void {
  const tree = findGitWorkTree(dirname(resolve(outPath)));
  if (tree) throw new ToolError(`Refusing to write private key material inside a git work tree (${tree}).`);
  const real = realAncestor(outPath);
  for (const r of extraForbiddenRoots) {
    const rel = relative(realAncestor(r), real);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      throw new ToolError(`Refusing to write private key material inside ${r}.`);
    }
  }
}

export function publicKeySetFromSeeds(seeds: { ed25519Seed: Uint8Array; mldsa65Seed: Uint8Array }): UpdateKeySet {
  const ed = ed25519PublicFromSeed(seeds.ed25519Seed);
  const pq = mldsa65PublicFromSeed(seeds.mldsa65Seed);
  return { id: keyIdOf(ed, pq), ed25519: encodeBase64(ed), mldsa65: encodeBase64(pq) };
}

export function serializeSeeds(seeds: SigningSeeds): string {
  return `${JSON.stringify(
    {
      formatVersion: 1,
      kind: SEED_FILE_KIND,
      keyId: seeds.keyId,
      ed25519Seed: encodeBase64(seeds.ed25519Seed),
      mldsa65Seed: encodeBase64(seeds.mldsa65Seed),
    },
    null,
    2,
  )}\n`;
}

export function parseSeeds(text: string): SigningSeeds {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new ToolError('Seed file is not valid JSON');
  }
  const o = v as Record<string, unknown>;
  if (typeof v !== 'object' || v === null || o.kind !== SEED_FILE_KIND || o.formatVersion !== 1) {
    throw new ToolError('Not a VSS signing seed file');
  }
  const ed = typeof o.ed25519Seed === 'string' ? decodeBase64Strict(o.ed25519Seed) : null;
  const pq = typeof o.mldsa65Seed === 'string' ? decodeBase64Strict(o.mldsa65Seed) : null;
  if (!ed || !pq || ed.length !== SEED_BYTES || pq.length !== SEED_BYTES) throw new ToolError('Malformed seeds');
  const seeds = { keyId: String(o.keyId ?? ''), ed25519Seed: ed, mldsa65Seed: pq };
  const derived = publicKeySetFromSeeds(seeds);
  if (seeds.keyId !== derived.id) throw new ToolError('Seed file keyId does not match its seeds');
  return seeds;
}

/** Reads seeds from a file path, or from stdin when the path is "-". Environment variables are never consulted. */
export async function readSeeds(source: string, stdin: NodeJS.ReadableStream = process.stdin): Promise<SigningSeeds> {
  if (source === '-') {
    const chunks: Buffer[] = [];
    for await (const c of stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
    return parseSeeds(Buffer.concat(chunks).toString('utf8'));
  }
  return parseSeeds(readFileSync(resolve(source), 'utf8'));
}

export function wipeSeeds(seeds: SigningSeeds): void {
  seeds.ed25519Seed.fill(0);
  seeds.mldsa65Seed.fill(0);
}

export function formatKeySetTs(slot: string, k: UpdateKeySet): string {
  return [
    `  ${slot}: {`,
    `    id: '${k.id}',`,
    `    ed25519: '${k.ed25519}',`,
    `    mldsa65:`,
    `      '${k.mldsa65}',`,
    `  },`,
  ].join('\n');
}
