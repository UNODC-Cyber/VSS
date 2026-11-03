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
