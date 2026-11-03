import { existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BACKUP_NAME, generateRecoveryPassphrase, LOCK_NAME, validateConfig } from '../../../src/main/services/backup';
import { makeApp, PW } from './helpers';
import type { TestApp } from './helpers';

vi.setConfig({ testTimeout: 60_000 });

const apps: TestApp[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const a of apps.splice(0)) a.cleanup();
});
async function app(extra = {}): Promise<TestApp> {
  const a = await makeApp(extra);
  apps.push(a);
  return a;
}
const PASS = 'synthetic backup passphrase 1';

describe('config validation', () => {
  it('rejects relative dirs, the vault dir, silly retention and short passphrases', () => {
    const ok = { dir: 'C:\\Backups', keep: 5, onLock: false, everyHours: null, passphrase: PASS };
    expect(validateConfig(ok, 'C:\\data\\vault')).toBeNull();
    expect(validateConfig({ ...ok, dir: 'rel' }, 'C:\\data\\vault')).toMatch(/absolute/);
    expect(validateConfig({ ...ok, dir: 'C:\\data\\vault\\' }, 'C:\\data\\vault')).toMatch(/vault folder/);
    expect(validateConfig({ ...ok, keep: 0 }, 'C:\\data\\vault')).toMatch(/Keep/);
    expect(validateConfig({ ...ok, everyHours: 0 }, 'C:\\data\\vault')).toMatch(/Interval/);
    expect(validateConfig({ ...ok, passphrase: 'short' }, 'C:\\data\\vault')).toMatch(/passphrase/);
  });
});

describe('BackupService', () => {
  it('writes an encrypted backup, keeps only the N newest, and never leaves partials or locks', async () => {
    const t = await app();
    await t.call('vault', 'create', { password: PW, displayName: 'x' });
    const dir = join(t.root, 'backups');
    expect(t.app.backup.configure({ dir, keep: 2, onLock: false, everyHours: null, passphrase: PASS }).ok).toBe(true);
    let now = Date.UTC(2026, 10, 3, 10, 0, 0);
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    for (let i = 0; i < 3; i++) {
      const r = await t.app.backup.runNow();
      expect(r.ok).toBe(true);
      now += 5_000;
    }
    vi.restoreAllMocks();
    const names = await readdir(dir);
    expect(names.filter((n) => BACKUP_NAME.test(n))).toHaveLength(2);
    expect(names.filter((n) => n.endsWith('.partial') || n === LOCK_NAME)).toEqual([]);
    const list = await t.app.backup.list();
    expect(list.map((f) => f.name)).toEqual([...list.map((f) => f.name)].sort().reverse());
    // the file is ciphertext: no SQLite header, no JSON header text
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(join(dir, list[0]!.name));
    expect(raw.subarray(0, 15).toString('latin1')).not.toContain('SQLite');
    expect(raw.includes(Buffer.from('vss-vault'))).toBe(false);
    expect(t.app.backup.config()).toEqual({ dir, keep: 2, onLock: false, everyHours: null, hasPassphrase: true });
  });

  it('ignores a stale lock file (old, or dead pid) but respects a live one', async () => {
    const t = await app();
    await t.call('vault', 'create', { password: PW, displayName: 'x' });
    const dir = join(t.root, 'backups');
    mkdirSync(dir, { recursive: true });
    t.app.backup.configure({ dir, keep: 3, onLock: false, everyHours: null, passphrase: PASS });
    // garbage lock => stale
    writeFileSync(join(dir, LOCK_NAME), 'not json');
    expect((await t.app.backup.runNow()).ok).toBe(true);
    // lock from a long-dead moment => stale
    writeFileSync(join(dir, LOCK_NAME), JSON.stringify({ pid: process.pid + 99999, at: Date.now() - 3_600_000 }));
    expect((await t.app.backup.runNow()).ok).toBe(true);
    // fresh lock held by another live process => refuse
    writeFileSync(join(dir, LOCK_NAME), JSON.stringify({ pid: process.ppid || 1, at: Date.now() }));
    const r = await t.app.backup.runNow();
    expect(r).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(existsSync(join(dir, LOCK_NAME))).toBe(true); // we did not delete somebody else's lock
  });

  it('sweeps old .partial files but keeps recent ones', async () => {
    const t = await app();
    await t.call('vault', 'create', { password: PW, displayName: 'x' });
    const dir = join(t.root, 'backups');
    mkdirSync(dir, { recursive: true });
    const old = join(dir, 'vss-backup-20200101-000000.vssbak.partial');
    const fresh = join(dir, 'vss-backup-20990101-000000.vssbak.partial');
    writeFileSync(old, 'x');
    writeFileSync(fresh, 'x');
    const longAgo = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(old, longAgo, longAgo);
    t.app.backup.configure({ dir, keep: 3, onLock: false, everyHours: null, passphrase: PASS });
    await t.app.backup.runNow();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('runIfDue honours the interval', async () => {
    const t = await app();
    await t.call('vault', 'create', { password: PW, displayName: 'x' });
    const dir = join(t.root, 'backups');
    t.app.backup.configure({ dir, keep: 5, onLock: false, everyHours: 6, passphrase: PASS });
    expect((await t.app.backup.runIfDue())?.ok).toBe(true);
    expect(await t.app.backup.runIfDue()).toBeNull();
  });

  it('on-lock backup runs behind the lock screen before the keys are disposed', async () => {
    const t = await app();
    await t.call('vault', 'create', { password: PW, displayName: 'x' });
    const dir = join(t.root, 'backups');
    t.app.backup.configure({ dir, keep: 5, onLock: true, everyHours: null, passphrase: PASS });
    await t.call('vault', 'lock');
    expect(t.rec.routes.at(0)).toBe('lock');
    expect((await readdir(dir)).filter((n) => BACKUP_NAME.test(n))).toHaveLength(1);
    expect(t.app.db.isOpen).toBe(false);
  });

  it('suspend / screen-lock never wait for a backup', async () => {
    const t = await app();
    await t.call('vault', 'create', { password: PW, displayName: 'x' });
    const dir = join(t.root, 'backups');
    t.app.backup.configure({ dir, keep: 5, onLock: true, everyHours: null, passphrase: PASS });
    await t.app.lock.lock('suspend');
    expect(existsSync(dir) ? (await readdir(dir)).filter((n) => BACKUP_NAME.test(n)) : []).toHaveLength(0);
    expect(t.app.db.isOpen).toBe(false);
  });

  it('restore: a backup opens in a fresh data directory with the original password', async () => {
    const a = await app();
    await a.call('vault', 'create', { password: PW, displayName: 'x' });
    const dir = join(a.root, 'backups');
    a.app.backup.configure({ dir, keep: 5, onLock: false, everyHours: null, passphrase: PASS });
    const res = await a.app.backup.runNow();
    expect(res.ok).toBe(true);
    const file = res.ok ? res.value.path : '';
    expect(statSync(file).size).toBeGreaterThan(0);

    const b = await app();
    expect(await b.app.initialRoute()).toBe('create');
    const bad = await b.app.backup.restore(file, 'wrong wrong wrong wrong');
    expect(bad).toMatchObject({ ok: false, error: { code: 'BACKUP_INVALID' } });
    const ok = await b.app.backup.restore(file, PASS);
    expect(ok.ok && ok.value.state).toBe('locked');
    const unlocked = await b.call('vault', 'unlock', { password: PW });
    expect(unlocked.ok).toBe(true);
    expect((await b.call('audit', 'verify')).value.ok).toBe(true);
    // restoring over an existing vault is refused
    expect(await b.app.backup.restore(file, PASS)).toMatchObject({ ok: false, error: { code: 'VAULT_EXISTS' } });
  });
});

describe('recovery passphrase', () => {
  it('is 160 bits of Crockford base32 in 8 groups and differs every time', () => {
    const a = generateRecoveryPassphrase();
    const b = generateRecoveryPassphrase();
    expect(a).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(a).not.toBe(b);
    expect(generateRecoveryPassphrase(() => new Uint8Array(20))).toBe('0000-0000-0000-0000-0000-0000-0000-0000');
    expect(generateRecoveryPassphrase(() => new Uint8Array(20).fill(255))).toBe(
      'ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ',
    );
  });
});
