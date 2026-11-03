import { describe, expect, it } from 'vitest';
import { createLogger, sanitizeFields } from '../../../src/main/app/logger';
import { resolveAppPaths } from '../../../src/main/app/paths';

describe('logger', () => {
  it('drops everything outside the field allowlist and non-primitives', () => {
    const out = sanitizeFields({
      code: 'VAULT_LOCKED',
      count: 3,
      ok: true,
      name: 'Ada TESTPERSON',
      body: { dob: '1980-01-02' },
      path: 'C:\\Users\\someone\\vault',
      reason: ['x'],
    });
    expect(out).toEqual({ code: 'VAULT_LOCKED', count: 3, ok: true });
  });

  it('strips path separators and control characters from allowed strings and truncates', () => {
    const out = sanitizeFields({ reason: 'a/b\\c\r\nd'.padEnd(500, 'x') });
    expect(out['reason']).toMatch(/^a_b_c {2}dx+$/);
    expect(String(out['reason']).length).toBe(80);
  });

  it('writes one JSON line per event and respects the level', () => {
    const lines: string[] = [];
    const log = createLogger({
      sink: { write: (l) => void lines.push(l) },
      level: 'warn',
      now: () => new Date('2026-11-03T00:00:00Z'),
    });
    log.info('ignored');
    log.error('renderer.gone', { reason: 'crashed', secret: 'nope' });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      t: '2026-11-03T00:00:00.000Z',
      level: 'error',
      event: 'renderer.gone',
      reason: 'crashed',
    });
  });

  it('a throwing sink never breaks the caller', () => {
    const log = createLogger({
      sink: {
        write: () => {
          throw new Error('disk');
        },
      },
    });
    expect(() => log.error('x')).not.toThrow();
  });
});

describe('resolveAppPaths', () => {
  it('defaults to %LOCALAPPDATA%\\VSS\\vault', () => {
    const p = resolveAppPaths({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'C:\\fallback');
    expect(p.dataDir.replace(/\//g, '\\')).toBe('C:\\Users\\u\\AppData\\Local\\VSS\\vault');
    expect(p.overridden).toBe(false);
  });
  it('VSS_DATA_DIR overrides everything and keeps session data beside it', () => {
    const p = resolveAppPaths({ VSS_DATA_DIR: '/tmp/x/vault', LOCALAPPDATA: 'C:\\L' }, '/fallback');
    expect(p.dataDir).toBe('/tmp/x/vault');
    expect(p.sessionDir.replace(/\\/g, '/')).toBe('/tmp/x/vault-session');
    expect(p.overridden).toBe(true);
  });
  it('falls back when LOCALAPPDATA is unset', () => {
    expect(resolveAppPaths({}, '/base').dataDir.replace(/\\/g, '/')).toBe('/base/VSS/vault');
  });
});
