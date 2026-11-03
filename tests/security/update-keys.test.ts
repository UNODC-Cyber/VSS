import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UPDATE_KEYS, UPDATE_KEYS_ARE_PLACEHOLDER } from '../../src/main/update/keys';
import { decodeKeySet } from '../../src/main/update/verify';

const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SKIP = new Set(['node_modules', '.git', 'out', 'dist', 'coverage', 'test-results']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (st.size < 2_000_000) out.push(p);
  }
  return out;
}

describe('update signing keys', () => {
  it('embedded key slots are well-formed public keys with matching ids', () => {
    expect(decodeKeySet(UPDATE_KEYS.current)).not.toBeNull();
    if (UPDATE_KEYS.next) expect(decodeKeySet(UPDATE_KEYS.next)).not.toBeNull();
    expect(UPDATE_KEYS.next?.id).not.toBe(UPDATE_KEYS.current.id);
  });
  it('placeholder keys are clearly marked in source', () => {
    const src = readFileSync(join(root, 'src', 'main', 'update', 'keys.ts'), 'utf8');
    if (UPDATE_KEYS_ARE_PLACEHOLDER) expect(src).toMatch(/TEST \/ PLACEHOLDER KEYS/);
  });
  it('no private signing seed file or private key is committed anywhere in the repository', () => {
    const offenders: string[] = [];
    for (const f of walk(root)) {
      const rel = relative(root, f).split(sep).join('/');
      if (rel.startsWith('tools/release/') || rel.startsWith('tests/')) continue; // tool + tests name the format only
      const text = readFileSync(f, 'latin1');
      if (/"kind"\s*:\s*"vss-update-signing-seeds"/.test(text) || /"ed25519Seed"\s*:/.test(text)) offenders.push(rel);
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
