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
