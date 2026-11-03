/**
 * Lane J gaps, closed with the security review fixes:
 * 1. two backups in the same second get distinct names (the second no longer replaces the first), and listing /
 *    pruning order them by time then sequence;
 * 2. regenerating the recovery passphrase keeps older backups restorable with the NEWEST passphrase, through the
 *    passphrase keyring written next to the backups (older generations sealed under the current one).
 * Real vault + encrypted DB through the handler table; synthetic data only.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BACKUP_NAME, KEYRING_NAME, readKeyring } from '../../src/main/services/backup';
import { makeApp, PW } from '../unit/app/helpers';
import type { TestApp } from '../unit/app/helpers';

vi.setConfig({ testTimeout: 120_000 });

const apps: TestApp[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const a of apps.splice(0)) a.cleanup();
});
async function unlocked(): Promise<TestApp> {
  const a = await makeApp();
  apps.push(a);
  expect((await a.call('vault', 'create', { password: PW, displayName: 'x' })).ok).toBe(true);
  return a;
}
async function configure(t: TestApp, dir: string, regenerate = false): Promise<string> {
  const cfg = { dir: await t.pickOpen(dir, 'directory'), keep: 10, onLock: false, everyHours: null };
  const r = await t.call('backup', 'configure', {
    config: cfg,
    reauth: { password: PW },
    ...(regenerate ? { regeneratePassphrase: true } : {}),
  });
  expect(r.ok).toBe(true);
  return r.value.newPassphrase as string;
}

describe('backup file names: same-second runs', () => {
  it('a second backup in the same second gets its own name; newest first; nothing is replaced', async () => {
    const t = await unlocked();
    const dir = join(t.root, 'backups');
    mkdirSync(dir);
    await configure(t, dir);
    const fixed = Date.UTC(2026, 10, 3, 10, 0, 0);
    vi.spyOn(Date, 'now').mockImplementation(() => fixed);
    const paths: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await t.app.backup.runNow();
      expect(r.ok).toBe(true);
      if (r.ok) paths.push(r.value.path);
    }
    vi.restoreAllMocks();
    expect(new Set(paths).size).toBe(3);
    const names = readdirSync(dir).filter((n) => BACKUP_NAME.test(n));
    expect(names.sort()).toEqual([
      'vss-backup-20261103-100000-2.vssbak',
      'vss-backup-20261103-100000-3.vssbak',
      'vss-backup-20261103-100000.vssbak',
    ]);
    const listed = (await t.app.backup.list()).map((f) => f.name);
    expect(listed).toEqual([
      'vss-backup-20261103-100000-3.vssbak',
      'vss-backup-20261103-100000-2.vssbak',
      'vss-backup-20261103-100000.vssbak',
    ]);
    const dropped = await t.app.backup.prune(dir, 2);
    expect(dropped).toEqual(['vss-backup-20261103-100000.vssbak']); // the oldest goes
  });
});

describe('recovery passphrase regeneration keeps older backups restorable', () => {
  it('a backup made under the first passphrase restores with the newest one (keyring), not with a wrong one', async () => {
    const t = await unlocked();
    const dir = join(t.root, 'backups');
    mkdirSync(dir);
    const p1 = await configure(t, dir);
    t.app.db.repos().meta.set('synthetic.marker', 'generation-1');
    const b1 = await t.app.backup.runNow();
    expect(b1.ok).toBe(true);
    const p2 = await configure(t, dir, true);
    const p3 = await configure(t, dir, true);
    expect(new Set([p1, p2, p3]).size).toBe(3);
    const b3 = await t.app.backup.runNow();
    expect(b3.ok).toBe(true);
    expect(existsSync(join(dir, KEYRING_NAME))).toBe(true);
    expect(await readKeyring(join(dir, KEYRING_NAME), p3)).toEqual([p2, p1]);
    expect(await readKeyring(join(dir, KEYRING_NAME), p1)).toEqual([]); // sealed under the newest only
    expect(JSON.stringify(await t.call('backup', 'list'))).not.toContain(p1);

    // Another computer: only the newest passphrase is known.
    const t2 = await makeApp();
    apps.push(t2);
    const src = await t2.pickOpen(b1.ok ? b1.value.path : '', 'backup');
    expect((await t2.call('backup', 'restore', { srcPath: src, passphrase: 'not the passphrase at all' })).ok).toBe(
      false,
    );
    const r = await t2.call('backup', 'restore', { srcPath: src, passphrase: p3 });
    expect(r.ok).toBe(true);
    expect((await t2.call('vault', 'unlock', { password: PW })).ok).toBe(true);
    expect(t2.app.db.repos().meta.get('synthetic.marker')).toBe('generation-1');
  });

  it('without the keyring an old backup still needs its own passphrase', async () => {
    const t = await unlocked();
    const dir = join(t.root, 'backups');
    mkdirSync(dir);
    const p1 = await configure(t, dir);
    const b1 = await t.app.backup.runNow();
    const p2 = await configure(t, dir, true);
    await t.app.backup.runNow();
    rmSync(join(dir, KEYRING_NAME));
    const t2 = await makeApp();
    apps.push(t2);
    const src = await t2.pickOpen(b1.ok ? b1.value.path : '', 'backup');
    expect((await t2.call('backup', 'restore', { srcPath: src, passphrase: p2 })).ok).toBe(false);
    expect((await t2.call('backup', 'restore', { srcPath: src, passphrase: p1 })).ok).toBe(true);
  });
});
