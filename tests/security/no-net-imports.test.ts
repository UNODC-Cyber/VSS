import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = new URL('../../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ALLOWED = join('main', 'net', 'NetGate.ts');
const FORBIDDEN = [
  'net',
  'http',
  'https',
  'http2',
  'tls',
  'dgram',
  'dns',
  'ws',
  'undici',
  'axios',
  'node-fetch',
  'got',
  'electron-updater',
];
const specifier = new RegExp(
  `(?:from\\s+|import\\s*\\(\\s*|require\\s*\\(\\s*|import\\s+)['"](?:node:)?(${FORBIDDEN.join('|')})(?:/[^'"]*)?['"]`,
);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

describe('network isolation', () => {
  it('only NetGate.ts imports network modules', () => {
    const offenders: string[] = [];
    for (const file of walk(root)) {
      const rel = relative(root, file);
      if (rel === ALLOWED) continue;
      const text = readFileSync(file, 'utf8');
      if (specifier.test(text)) offenders.push(rel.split(sep).join('/'));
      if (/import\s*\{[^}]*\bnet\b[^}]*\}\s*from\s*['"]electron['"]/.test(text))
        offenders.push(`${rel} (electron net)`);
    }
    expect(offenders).toEqual([]);
  });
  it('the renderer never calls fetch, XMLHttpRequest or WebSocket', () => {
    const offenders = walk(join(root, 'renderer')).filter((f) =>
      /\b(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});

describe('local fonts and icons', () => {
  const out = join(root, '..', 'out', 'renderer');
  const built = (() => {
    try {
      return statSync(out).isDirectory();
    } catch {
      return false;
    }
  })();

  it('the renderer source loads the font from the package, not a URL', () => {
    const main = readFileSync(join(root, 'renderer', 'src', 'main.tsx'), 'utf8');
    expect(main).toMatch(/import '@fontsource-variable\/inter\/wght\.css'/);
    const css = readFileSync(join(root, 'renderer', 'src', 'styles.css'), 'utf8');
    expect(css).not.toMatch(/url\(\s*['"]?https?:/i);
    expect(css).not.toMatch(/@import\s+(url\()?\s*['"]?https?:/i);
  });

  it.runIf(built)('the built renderer references no remote font, stylesheet or icon URL', () => {
    const files: string[] = [];
    const walkOut = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walkOut(p);
        else files.push(p);
      }
    };
    walkOut(out);
    const text = files.filter((f) => /\.(css|html)$/.test(f));
    for (const f of text) {
      const s = readFileSync(f, 'utf8');
      expect(s, f).not.toMatch(/url\(\s*['"]?https?:/i);
      expect(s, f).not.toMatch(/(?:href|src)=["']https?:/i);
      expect(s, f).not.toMatch(/@import\s+(url\()?\s*['"]?https?:/i);
    }
    for (const f of files.filter((x) => /\.js$/.test(x))) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(
        /fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|use\.typekit\.net/,
      );
    }
    expect(files.some((f) => /inter-latin-wght-normal.*\.woff2$/.test(f))).toBe(true);
  });
});
