import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

describe('hardening configuration', () => {
  const win = read('src/main/bootstrap/window.ts');
  it('window uses sandbox, context isolation, no node integration', () => {
    expect(win).toMatch(/sandbox:\s*true/);
    expect(win).toMatch(/contextIsolation:\s*true/);
    expect(win).toMatch(/nodeIntegration:\s*false/);
    expect(win).toMatch(/webviewTag:\s*false/);
  });
  it('crashReporter is never started', () => {
    for (const f of ['src/main/index.ts', 'src/main/bootstrap/security.ts', 'src/main/bootstrap/window.ts']) {
      expect(read(f)).not.toMatch(/crashReporter\s*\.\s*start/);
    }
  });
  it('CSP is strict', async () => {
    const src = read('src/main/bootstrap/security.ts');
    expect(src).toContain("default-src 'none'");
    expect(src).toContain("connect-src 'none'");
    expect(src).not.toContain('unsafe-inline');
    expect(src).not.toContain('unsafe-eval');
  });
  it('renderer HTML has no inline script or style', () => {
    const html = read('src/renderer/index.html');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });
  it('electron-builder: per-user NSIS, no elevation, GitHub provider', () => {
    const y = read('electron-builder.yml');
    expect(y).toMatch(/perMachine:\s*false/);
    expect(y).toMatch(/oneClick:\s*true/);
    expect(y).toMatch(/allowElevation:\s*false/);
    expect(y).toMatch(/owner:\s*UNODC-Cyber/);
    expect(y).toMatch(/repo:\s*VSS/);
    expect(y).toMatch(/runAsNode:\s*false/);
    expect(y).toMatch(/enableEmbeddedAsarIntegrityValidation:\s*true/);
    expect(y).toMatch(/onlyLoadAppFromAsar:\s*true/);
  });
  it('npm scripts are disabled', () => {
    expect(read('.npmrc')).toMatch(/ignore-scripts=true/);
  });
});
