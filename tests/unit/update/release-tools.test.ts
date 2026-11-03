import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { generateKeys } from '../../../tools/release/gen-keys';
import { assertOutsideRepo, parseSeeds, readSeeds, serializeSeeds } from '../../../tools/release/lib';
import { signRelease } from '../../../tools/release/sign-manifest';
import { verifyReleaseDir } from '../../../tools/release/verify-release';
import { makeKey } from './helpers';

const tmp = mkdtempSync(join(tmpdir(), 'vss-release-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const repoRoot = new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

describe('gen-keys', () => {
  it('refuses to write seeds inside the repository', () => {
    expect(() => generateKeys(join(repoRoot, 'leak.json'))).toThrow(/git work tree/);
    expect(() => generateKeys(join(repoRoot, 'tools', 'release', 'deep', 'leak.json'))).toThrow();
    expect(existsSync(join(repoRoot, 'leak.json'))).toBe(false);
  });
  it('refuses paths under an explicitly forbidden root', () => {
    const forbidden = join(tmp, 'forbidden');
    expect(() => assertOutsideRepo(join(forbidden, 'x.json'), [forbidden])).toThrow();
  });
  it('writes a parseable seed file outside the repo and never overwrites', () => {
    const out = join(tmp, 'seeds.json');
    const { publicKeys } = generateKeys(out);
    const seeds = parseSeeds(readFileSync(out, 'utf8'));
    expect(seeds.keyId).toBe(publicKeys.id);
    expect(() => generateKeys(out)).toThrow();
  });
  it('rejects a seed file whose keyId does not match', () => {
    const k = makeKey();
    const text = serializeSeeds({ keyId: 'deadbeefdeadbeef', ...k.seeds });
    expect(() => parseSeeds(text)).toThrow(/keyId/);
  });
  it('reads seeds from stdin', async () => {
    const k = makeKey();
    const text = serializeSeeds({ keyId: k.pub.id, ...k.seeds });
    const s = await readSeeds('-', Readable.from([Buffer.from(text)]));
    expect(s.keyId).toBe(k.pub.id);
  });
});

describe('sign-manifest + verify-release round trip', () => {
  const k = makeKey();
  const seeds = { keyId: k.pub.id, ...k.seeds };
  const trusted = { current: k.pub, next: null };
  const dir = join(tmp, 'assets');

  it('refuses a key that is not embedded unless explicitly allowed', async () => {
    const d = mkdtempSync(join(tmp, 'a-'));
    writeFileSync(join(d, 'vss-1.2.0-x64-setup.exe'), 'x');
    await expect(signRelease(d, '1.2.0', '2026-11-03', seeds)).rejects.toThrow(/not embedded/);
  });

  it('signs, verifies, and detects tampering', async () => {
    mkdirSync(dir);
    writeFileSync(join(dir, 'vss-1.2.0-x64-setup.exe'), 'installer');
    writeFileSync(join(dir, 'vss-1.2.0-x64-portable.exe'), 'portable');
    writeFileSync(join(dir, 'latest.yml'), 'version: 1.2.0\n');
    const r = await signRelease(dir, '1.2.0', '2026-11-03', seeds, { trusted });
    expect(r.manifest.files.map((f) => f.name)).toEqual([
      'latest.yml',
      'vss-1.2.0-x64-portable.exe',
      'vss-1.2.0-x64-setup.exe',
    ]);
    expect(await verifyReleaseDir(dir, { keys: trusted, expectVersion: '1.2.0' })).toMatchObject({ ok: true });
    // Against the repo's embedded (placeholder) keys this must fail.
    expect((await verifyReleaseDir(dir)).ok).toBe(false);
    writeFileSync(join(dir, 'vss-1.2.0-x64-setup.exe'), 'installer!');
    const bad = await verifyReleaseDir(dir, { keys: trusted });
    expect(bad.ok).toBe(false);
    expect(bad.problems.join()).toMatch(/SIZE_MISMATCH/);
    expect((await verifyReleaseDir(dir, { keys: trusted, expectVersion: '9.9.9' })).ok).toBe(false);
  });
});
