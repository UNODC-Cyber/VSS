/**
 * Guard: the counterpart's blank request workbook (or anything derived from it) must never come back.
 *
 * 1. Every .xlsx below fixtures/ and src/ consists only of parts our own writers produce
 *    (tools/fixtures/investc-workbook.ts and tools/fixtures/response-builder.ts).
 * 2. No file is named like the removed template, its embedded module or the tools that built them, and no source
 *    file embeds a zip / xlsx as base64.
 * 3. None of a handful of distinctive phrases of the removed instruction sheet appears in any file of the
 *    repository (text files and the text inside every .xlsx). The phrases are stored only as SHA-256 hashes of their
 *    normalised word sequence (NFKC, lower case, letters and digits only, single spaces): never the phrases.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readZip } from '../../src/main/formats/ooxml/zip.ts';
import { GENERATED_PARTS } from '../../tools/fixtures/investc-workbook.ts';
import { buildResponseWorkbook } from '../../tools/fixtures/response-builder.ts';

const ROOT = new URL('../../', import.meta.url);
const rootPath = fileURLToPath(ROOT);
const SKIP_DIRS = new Set([
  'node_modules',
  'out',
  'dist',
  'release',
  '.git',
  'coverage',
  'test-results',
  'playwright-report',
  'bin',
  'obj',
]);
const TEXT =
  /\.(ts|tsx|js|mjs|cjs|json|md|yml|yaml|sql|html|css|cs|csproj|txt|xml|gitignore|gitattributes|npmrc)$|^[^.]+$/i;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...walk(p));
    } else out.push(p);
  }
  return out;
}
const files = walk(rootPath).map((p) => relative(rootPath, p).split('\\').join('/'));

/** Distinctive phrases of the removed instruction sheet, hashed (words: token count, first: sha256 of word 1). */
const BANNED: readonly { words: number; first: string; sha256: string }[] = [
  { words: 11, first: 'fc83ec582b335dd0', sha256: '4d97bc4db2ae9efad7cb9c08b663617a35c78ead0aa43f7476e4aa344d6f1b1a' },
  { words: 14, first: '1eb79602411ef02c', sha256: '5676e2ba4fabfd3bdb06c4f2ade5e6cc0d3d3f24c5179065a304faf0be91c6e3' },
  { words: 10, first: '56ccc4dcfc96534b', sha256: '5ac5ec5b4b57c6420784c658db79fd7683f713e771c73ec931d2ce127ead02c8' },
  { words: 7, first: '73899bb69e4f41dc', sha256: '8be371c66ccb093a1ae82d2263ba04761adf87bdd629a4e5965c5ad4630a215d' },
  { words: 7, first: '210760fba8185013', sha256: '63562ba00b9ae1378eaab7ed469ae2d46ca4c217a2ba7761e9fb34802f3dff40' },
  { words: 14, first: '935f68319d4f227e', sha256: 'ba16fff4716b3eb6a635acea2613829e7a81679a9f2248314409882c8628374a' },
  { words: 13, first: '56ccc4dcfc96534b', sha256: 'ee793dd251ca4dc36de6b767ae659f20543edb4fff451ef137868c0ef7ca5395' },
  { words: 11, first: 'fa51fd49abf67705', sha256: 'ad5acee04a14530688b2d32ab51e872222a70ca45b5f73cd45087a3fc8a1a097' },
  { words: 9, first: 'f4bf9f7fcbedaba0', sha256: '885f8d53ec2c7d2517f9520efd26d388f67c5fefb5b69bf42de28050b133d62e' },
  { words: 12, first: 'd6a7cd2a7371b1a1', sha256: '259a53871bbe8c2b6986672dad13185f04e832912b3259a4f9e10342038c0852' },
];

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const tokens = (s: string): string[] =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];

/** Hashes of the banned phrases found in `text`. */
export function bannedPhraseHits(text: string, banned = BANNED): string[] {
  const t = tokens(text);
  const firsts = new Set(banned.map((b) => b.first));
  const hits = new Set<string>();
  for (let i = 0; i < t.length; i++) {
    if (!firsts.has(sha(t[i] as string).slice(0, 16))) continue;
    for (const b of banned) {
      if (i + b.words > t.length) continue;
      if (sha(t.slice(i, i + b.words).join(' ')) === b.sha256) hits.add(b.sha256);
    }
  }
  return [...hits];
}

/** Text of a file for the phrase scan: UTF-8 for text files, every decompressed part for .xlsx. */
function scanText(rel: string): string | null {
  const abs = join(rootPath, rel);
  if (/\.xlsx$/i.test(rel)) {
    const pkg = readZip(new Uint8Array(readFileSync(abs)));
    return pkg.order.map((n) => Buffer.from(pkg.parts.get(n) as Uint8Array).toString('utf8')).join('\n');
  }
  const base = rel.split('/').pop() as string;
  return TEXT.test(base) ? readFileSync(abs, 'utf8') : null;
}

describe('no third-party template in the repository', () => {
  it('every xlsx under fixtures/ and src/ holds only parts our generators write', () => {
    const allowed = new Set([
      ...GENERATED_PARTS,
      ...readZip(buildResponseWorkbook({ line1: '', line2: '', line3: '', line4: '', sections: [] }).bytes).order,
    ]);
    const xlsx = files.filter((f) => /^(fixtures|src)\//.test(f) && /\.xlsx$/i.test(f));
    expect(xlsx.length).toBeGreaterThanOrEqual(13);
    const bad = xlsx.flatMap((f) =>
      readZip(new Uint8Array(readFileSync(join(rootPath, f))))
        .order.filter((p) => !allowed.has(p))
        .map((p) => `${f}: ${p}`),
    );
    expect(bad).toEqual([]);
  });

  it('nothing is named like the removed template, its embedded module or the tools that built them', () => {
    const banned =
      /investc-blank|export-template|embed-template|build-template|blank-template|(^|\/)fixtures\/templates\//i;
    expect(files.filter((f) => banned.test(f))).toEqual([]);
  });

  it('no source file embeds a zip or xlsx as base64', () => {
    const src = files.filter((f) => /^(src|tools)\//.test(f) && /\.(ts|tsx|js|mjs|cjs|json)$/.test(f));
    expect(src.filter((f) => /UEsDB[A-Za-z0-9+/]{200,}/.test(readFileSync(join(rootPath, f), 'utf8')))).toEqual([]);
  });

  it('the phrase detector works (self-test with a made-up phrase)', () => {
    const probe = 'guard probe phrase for the template check';
    const t = tokens(probe);
    const entry = { words: t.length, first: sha(t[0] as string).slice(0, 16), sha256: sha(t.join(' ')) };
    expect(bannedPhraseHits(`x "Guard probe" phrase,\nfor THE template-check! y`, [entry])).toEqual([entry.sha256]);
    expect(bannedPhraseHits('guard probe phrase for a template check', [entry])).toEqual([]);
  });

  it('no file contains a distinctive phrase of the removed instruction sheet', () => {
    const hits: string[] = [];
    for (const f of files) {
      const text = scanText(f);
      if (text === null) continue;
      for (const h of bannedPhraseHits(text)) hits.push(`${f}: ${h.slice(0, 12)}`);
    }
    expect(hits).toEqual([]);
  }, 180_000);
});
