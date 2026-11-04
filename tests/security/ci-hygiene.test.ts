/** Security review F-11: CI / release workflow hygiene, checked on the workflow files themselves. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
const release = readFileSync('.github/workflows/release.yml', 'utf8');

describe('F-11 CI hygiene', () => {
  it('every action is pinned by a full commit SHA', () => {
    for (const wf of [ci, release]) {
      const uses = [...wf.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]!);
      expect(uses.length).toBeGreaterThan(0);
      for (const u of uses) expect(u, u).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it('checkout never persists credentials', () => {
    for (const wf of [ci, release]) {
      const n = (wf.match(/uses: actions\/checkout@/g) ?? []).length;
      expect((wf.match(/persist-credentials: false/g) ?? []).length).toBe(n);
    }
  });

  it('the dependency scan is blocking and uses the documented allowlist', () => {
    const osv = ci.slice(ci.indexOf('osv-scanner (package-lock.json)'));
    expect(osv.slice(0, 600)).not.toContain('continue-on-error');
    expect(osv).toContain('--config=.github/osv-scanner.toml');
    expect(readFileSync('.github/osv-scanner.toml', 'utf8')).toMatch(/\[\[IgnoredVulns\]\][\s\S]*reason/);
  });

  it('the release job checks the fuses, and the SBOM runs in a separate read-only job', () => {
    expect(release).toContain('npm run verify:fuses');
    const build = release.slice(release.indexOf('\n  build:'));
    const sbom = release.slice(release.indexOf('\n  sbom:'), release.indexOf('\n  build:'));
    expect(sbom).toContain('cyclonedx');
    expect(sbom).toContain('contents: read');
    expect(sbom).not.toContain('contents: write');
    expect(build).not.toContain('cyclonedx-npm');
  });
});

describe('R9 alpha pre-release path', () => {
  /** The text of one named workflow step, up to the next step. */
  const step = (name: string): string => {
    const i = release.indexOf('- name: ' + name);
    expect(i, name).toBeGreaterThan(-1);
    const next = release.indexOf('\n      - ', i + 10);
    return release.slice(i, next === -1 ? undefined : next);
  };

  it('prerelease comes from the tag; the placeholder-key gate is skipped for prerelease tags only', () => {
    expect(release).toContain("PRERELEASE: ${{ contains(github.ref_name, '-') }}");
    const gate = step('Refuse placeholder update-signing keys');
    expect(gate).toContain("if: env.PRERELEASE != 'true'");
    expect(gate).toContain('placeholder: true');
    expect(release.match(/Refuse placeholder/g)).toHaveLength(1);
  });

  it('the alpha build uses dist:alpha and asserts the channel in the bundle', () => {
    const build = step('Build ALPHA NSIS + portable (channel alpha, unsigned, updater disabled)');
    expect(build).toContain("if: env.PRERELEASE == 'true'");
    expect(build).toContain('npm run dist:alpha');
    expect(build).toContain('node tools/verify-channel.mjs out/main/index.js alpha');
    expect(step('Build NSIS + portable (unsigned, never published by electron-builder)')).toContain(
      "if: env.PRERELEASE != 'true'",
    );
  });

  it('a prerelease ships SHA256SUMS and SHA512SUMS but never latest.yml or a blockmap', () => {
    const collect = step('Collect assets + SHA256SUMS + SHA512SUMS (alpha, no latest.yml, no blockmap)');
    expect(collect).toContain("if: env.PRERELEASE == 'true'");
    expect(collect).toContain('SHA256SUMS');
    expect(collect).toContain('SHA512SUMS');
    expect(collect.replace(/\(alpha, no latest\.yml, no blockmap\)/, '')).not.toMatch(/latest\.yml|blockmap/);
    const stable = step('Collect assets + SHA512SUMS');
    expect(stable).toContain("if: env.PRERELEASE != 'true'");
    expect(release.replace(stable, '')).not.toMatch(/cp [^\n]*(latest\.yml|blockmap)/);
  });

  it('a prerelease is created as a draft prerelease; the stable path stays a plain draft', () => {
    const alpha = step('Upload as DRAFT PRERELEASE (alpha)');
    expect(alpha).toContain("if: env.PRERELEASE == 'true'");
    expect(alpha).toContain('--draft --prerelease');
    const stable = step('Upload as DRAFT release');
    expect(stable).toContain("if: env.PRERELEASE != 'true'");
    expect(stable).toContain('--draft');
    expect(stable).not.toContain('--prerelease');
    expect(release).not.toMatch(/gh release (create|edit)[^\n]*--(latest|publish)/);
  });

  it('dist:alpha exists and the issue template keeps its required no-personal-data checkbox', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['dist:alpha']).toContain('dist.mjs alpha');
    const tpl = readFileSync('.github/ISSUE_TEMPLATE/alpha-feedback.yml', 'utf8');
    expect(tpl).toMatch(/- label: I have not pasted names, dates of birth or any file content\.\s+required: true/);
  });
});
