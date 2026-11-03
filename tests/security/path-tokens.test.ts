/**
 * Security review F-02: the main process never trusts a renderer-supplied path. Every handler that reads or writes a
 * user file takes an opaque token issued by files.pickOpen / files.pickSave and bound to the chosen file, its kind
 * and its mode. A compromised renderer can no longer write a `.cmd` into the Startup folder, create directories, or
 * read files the user never picked. Handlers are called directly (no Electron); synthetic data only.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PathGrants } from '../../src/main/services/files';
import { makeApp, PW } from '../unit/app/helpers';
import type { TestApp } from '../unit/app/helpers';

vi.setConfig({ testTimeout: 60_000 });

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

const draft = {
  to: [],
  cc: [],
  subject: 'x',
  bodyText: '\r\n& echo pwned > pwned.txt\r\n',
  attachmentName: null,
  containsPersonalData: false,
};
const fx = (p: string) => resolve('fixtures', p);

async function unlocked(): Promise<TestApp> {
  const app = await makeApp();
  expect((await app.call('vault', 'create', { password: PW, displayName: 'x' })).ok).toBe(true);
  return app;
}

describe('F-02 dialog-issued path tokens', () => {
  it('a raw path is refused by every file-writing handler and nothing is written', async () => {
    t = await unlocked();
    const startup = join(t.root, 'Startup');
    mkdirSync(startup);
    const evil = join(startup, 'run.cmd');
    const calls: [string, string, Record<string, unknown>][] = [
      ['email', 'writeEml', { draft, destPath: evil }],
      ['audit', 'export', { destPath: join(t.root, 'deep', 'new', 'dirs', 'a.jsonl') }],
      ['vault', 'backup', { destPath: join(startup, 'b.vssbak'), passphrase: 'backup-passphrase-1' }],
      ['files', 'saveStored', { fileId: '01J0000000000000000000000A', destPath: evil }],
      ['stats', 'exportExpiryCsv', { withinDays: 90, password: PW, destPath: join(startup, 'x.csv') }],
      ['requests', 'export', { requestId: '01J0000000000000000000000A', mode: 'regenerate', destPath: evil }],
    ];
    for (const [ns, m, arg] of calls) {
      const r = await t.call(ns as never, m, arg);
      expect(r.ok, `${ns}.${m}`).toBe(false);
      expect(r.error.code, `${ns}.${m}`).toBe('BAD_REQUEST');
    }
    expect(existsSync(evil)).toBe(false);
    expect(existsSync(join(t.root, 'deep'))).toBe(false);
    expect(existsSync(join(startup, 'b.vssbak'))).toBe(false);
  });

  it('the save dialog refuses an extension its kind does not offer (run.cmd in an .eml dialog)', async () => {
    t = await unlocked();
    t.rec.files.saveResult = join(t.root, 'run.cmd');
    const r = await t.call('files', 'pickSave', { kind: 'eml', suggestedName: 'draft.eml' });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('BAD_REQUEST');
  });

  it('a save token writes exactly the chosen file, once; it cannot be used for another kind or for reading', async () => {
    t = await unlocked();
    const dest = join(t.root, 'draft.eml');
    const tok = await t.pickSave(dest, 'eml');
    // wrong kind / mode: refused, and the token is not consumed by the refusal of another kind
    expect((await t.call('vault', 'backup', { destPath: tok, passphrase: 'backup-passphrase-1' })).error.code).toBe(
      'BAD_REQUEST',
    );
    expect((await t.call('requests', 'importPreview', { path: tok })).error.code).toBe('BAD_REQUEST');
    const ok = await t.call('email', 'writeEml', { draft, destPath: tok });
    expect(ok.ok).toBe(true);
    expect(ok.value.path).toBe(dest);
    expect(existsSync(dest)).toBe(true);
    expect((await t.call('email', 'writeEml', { draft, destPath: tok })).error.code).toBe('BAD_REQUEST');
    // a forged token of the right shape is refused
    expect((await t.call('email', 'writeEml', { draft, destPath: `vss-file:${'0'.repeat(32)}` })).ok).toBe(false);
  });

  it('audit.export with a token for a folder that does not exist creates no directories', async () => {
    t = await unlocked();
    const deep = join(t.root, 'deep', 'new', 'a.jsonl');
    const tok = await t.pickSave(deep, 'audit');
    await expect(t.call('audit', 'export', { destPath: tok })).rejects.toThrow();
    expect(existsSync(join(t.root, 'deep'))).toBe(false);
  });

  it('an open token reads only the picked file, may be re-read (re-match) and dies on lock', async () => {
    t = await unlocked();
    expect((await t.call('requests', 'importPreview', { path: fx('requests/req-001-basic.xlsx') })).error.code).toBe(
      'BAD_REQUEST',
    );
    const tok = await t.pickOpen(fx('requests/req-001-basic.xlsx'), 'request-xlsx');
    expect((await t.call('responses', 'importPreview', { path: tok })).error.code).toBe('BAD_REQUEST'); // kind
    expect((await t.call('requests', 'importPreview', { path: tok })).ok).toBe(true);
    expect((await t.call('requests', 'importPreview', { path: tok })).ok).toBe(true);
    await t.call('vault', 'lock');
    await t.call('vault', 'unlock', { password: PW });
    expect((await t.call('requests', 'importPreview', { path: tok })).error.code).toBe('BAD_REQUEST');
  });

  it('restore needs a backup-kind open token; a folder must come from the folder dialog', async () => {
    t = await unlocked();
    const bak = join(t.root, 'b.vssbak');
    writeFileSync(bak, 'not a real backup');
    const asEml = await t.pickSave(join(t.root, 'x.eml'), 'eml');
    expect((await t.call('backup', 'restore', { srcPath: asEml, passphrase: 'x'.repeat(12) })).error.code).toBe(
      'BAD_REQUEST',
    );
    const cfg = { dir: join(t.root, 'raw-folder'), keep: 3, onLock: false, everyHours: null };
    expect((await t.call('backup', 'configure', { config: cfg, reauth: { password: PW } })).error.code).toBe(
      'BAD_REQUEST',
    );
  });

  it('PathGrants: expiry, clear, relative paths', () => {
    let now = 0;
    const g = new PathGrants(() => now);
    expect(() => g.issue('relative.xlsx', 'request-xlsx', 'open')).toThrow();
    const tok = g.issue(resolve('a.xlsx'), 'request-xlsx', 'open');
    expect(g.resolve(tok, 'open', ['request-xlsx'])).toBe(resolve('a.xlsx'));
    now = 31 * 60_000;
    expect(() => g.resolve(tok, 'open', ['request-xlsx'])).toThrow();
    const tok2 = g.issue(resolve('b.csv'), 'csv', 'save');
    g.clear();
    expect(() => g.resolve(tok2, 'save', ['csv'])).toThrow();
  });
});
