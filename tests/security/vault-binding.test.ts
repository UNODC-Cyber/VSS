/**
 * Security review F-04: the vault header and its database are bound to the app data folder and to each other.
 * - vault.open / vault.restore refuse any directory other than the data folder;
 * - unlock never creates a database: a missing or empty vss.db is refused;
 * - the DB carries the header's vaultId (meta 'vault.id'); a DB bound to another vault is refused.
 * Synthetic data only; handlers are called directly (no Electron).
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VAULT_ID_META_KEY } from '../../src/main/db/controller';
import { makeApp, PW } from '../unit/app/helpers';
import type { TestApp } from '../unit/app/helpers';

vi.setConfig({ testTimeout: 60_000 });

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

async function created(): Promise<TestApp> {
  const app = await makeApp();
  const c = await app.call('vault', 'create', { password: PW, displayName: 'x' });
  expect(c.ok).toBe(true);
  return app;
}

describe('F-04 vault directory and DB binding', () => {
  it('restore into a directory other than the data folder is refused and creates nothing', async () => {
    t = await created();
    const bak = join(t.root, 'b.vssbak');
    expect((await t.app.vault.backup({ destPath: bak, passphrase: 'backup-passphrase-1' })).ok).toBe(true);
    expect((await t.call('vault', 'wipe', { password: PW, confirm: 'WIPE' })).ok).toBe(true);
    const other = join(t.root, 'elsewhere');
    const r = await t.app.vault.restore({ srcPath: bak, passphrase: 'backup-passphrase-1', destDirectory: other });
    expect(r.ok).toBe(false);
    expect(existsSync(join(other, 'vault.json'))).toBe(false);
    const un = await t.call('vault', 'unlock', { password: PW });
    expect(un.ok).toBe(false);
    expect(existsSync(join(t.paths.dataDir, 'vss.db'))).toBe(false);
  });

  it('vault.open of a foreign directory is refused', async () => {
    t = await created();
    const other = join(t.root, 'foreign');
    mkdirSync(other);
    writeFileSync(join(other, 'vault.json'), '{}');
    const r = await t.call('vault', 'open', { path: other });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('BAD_REQUEST');
    const ok = await t.call('vault', 'open', { path: join(t.paths.dataDir, 'vault.json') });
    expect(ok.ok).toBe(true);
  });

  it('a missing vss.db is refused on unlock instead of being re-created empty', async () => {
    t = await created();
    await t.call('vault', 'lock');
    const db = join(t.paths.dataDir, 'vss.db');
    for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
    const un = await t.call('vault', 'unlock', { password: PW });
    expect(un.ok).toBe(false);
    expect(un.error.code).toBe('VAULT_CORRUPT');
    expect(existsSync(db)).toBe(false);
  });

  it('an empty vss.db is refused (no silent new vault)', async () => {
    t = await created();
    await t.call('vault', 'lock');
    const db = join(t.paths.dataDir, 'vss.db');
    for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
    writeFileSync(db, '');
    const un = await t.call('vault', 'unlock', { password: PW });
    expect(un.ok).toBe(false);
    expect(t.app.db.isOpen).toBe(false);
  });

  it('the DB stores the vault id; a DB bound to another vault is refused', async () => {
    t = await created();
    const meta = () => t!.app.db.repos().meta;
    const header = (await t.call('vault', 'status')).value as { vaultPath: string };
    expect(header.vaultPath).toContain(t.paths.dataDir);
    const id = meta().get(VAULT_ID_META_KEY);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    meta().set(VAULT_ID_META_KEY, 'f'.repeat(32));
    await t.call('vault', 'lock');
    const un = await t.call('vault', 'unlock', { password: PW });
    expect(un.ok).toBe(false);
    expect(un.error.code).toBe('VAULT_TAMPERED');
  });

  it('a DB written before the binding adopts the id on the first unlock', async () => {
    t = await created();
    const id = t.app.db.repos().meta.get(VAULT_ID_META_KEY);
    t.app.db.repos().meta.delete(VAULT_ID_META_KEY);
    await t.call('vault', 'lock');
    expect((await t.call('vault', 'unlock', { password: PW })).ok).toBe(true);
    expect(t.app.db.repos().meta.get(VAULT_ID_META_KEY)).toBe(id);
  });
});
