import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Result } from '@shared/ipc/contract';
import { _resetAllLockoutsForTests } from '../../../src/main/crypto/lockout';
import { DB_FILE, VAULT_FILE } from '../../../src/main/crypto/vault';
import { isZeroed } from '../../../src/main/crypto/zeroize';
import { DbError } from '../../../src/main/db/errors';
import type { DbController } from '../../../src/main/services/vault-service';
import { VaultService } from '../../../src/main/services/vault-service';
import { cleanupTempDirs, FAST_KDF, PW, tempDir } from './helpers';

vi.setConfig({ testTimeout: 60_000 });
afterAll(cleanupTempDirs);
beforeEach(() => _resetAllLockoutsForTests());

/** Stand-in for the WP-04 controller: the "DB" is a file whose content records the key that created it. */
class FakeDb implements DbController {
  openKey: string | null = null;
  keyByDb = new Map<string, string>();
  dir = '';
  content = randomBytes(50_000);
  open(keyHex: string) {
    const known = this.keyByDb.get(this.dir);
    if (known && known !== keyHex) throw new Error('file is not a database');
    this.keyByDb.set(this.dir, keyHex);
    if (!existsSync(join(this.dir, DB_FILE))) writeFileSync(join(this.dir, DB_FILE), this.content);
    this.openKey = keyHex;
  }
  close() {
    this.openKey = null;
  }
  rekey(newKeyHex: string) {
    if (!this.openKey) throw new Error('not open');
    this.keyByDb.set(this.dir, newKeyHex);
    this.openKey = newKeyHex;
  }
  probe(keyHex: string) {
    return this.keyByDb.get(this.dir) === keyHex;
  }
  vacuumInto(path: string) {
    if (!this.openKey) throw new Error('not open');
    copyFileSync(join(this.dir, DB_FILE), path);
  }
}

function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.value;
}
const codeOf = (r: Result<unknown>) => (r.ok ? 'OK' : r.error.code);

function setup() {
  const db = new FakeDb();
  const svc = new VaultService({ db, kdf: FAST_KDF, backupKdf: FAST_KDF });
  return { db, svc };
}

describe('VaultService', () => {
  it('status/create/lock/unlock lifecycle', async () => {
    const { db, svc } = setup();
    expect(value(await svc.status()).state).toBe('no-vault');
    const dir = tempDir();
    db.dir = dir;
    const st = value(await svc.create({ directory: dir, password: PW, displayName: 'Test vault' }));
    expect(st.state).toBe('unlocked');
    expect(st.slots).toHaveLength(1);
    expect(st.slots[0]?.kind).toBe('password');
    expect(db.openKey).toMatch(/^[0-9a-f]{64}$/);
    const dekRef = svc.keyMaterial?.dek;
    expect(dekRef).toBeDefined();

    expect(value(await svc.lock()).state).toBe('locked');
    expect(db.openKey).toBeNull();
    expect(isZeroed(dekRef as Buffer)).toBe(true);
    expect(svc.keyMaterial).toBeNull();

    const bad = await svc.unlock({ password: 'wrong password' });
    expect(codeOf(bad)).toBe('BAD_CREDENTIALS');
    expect(value(await svc.status()).failedAttempts).toBe(1);
    expect(value(await svc.unlock({ password: PW })).state).toBe('unlocked');
    expect(value(await svc.status()).failedAttempts).toBe(0);
  });

  it('open() accepts vault.json or its directory', async () => {
    const { db, svc } = setup();
    const dir = tempDir();
    db.dir = dir;
    value(await svc.create({ directory: dir, password: PW, displayName: 'x' }));
    const svc2 = new VaultService({ db, kdf: FAST_KDF });
    expect(value(await svc2.open({ path: join(dir, VAULT_FILE) })).state).toBe('locked');
    expect(value(await svc2.open({ path: dir })).state).toBe('locked');
    expect(codeOf(await svc2.open({ path: tempDir() }))).toBe('VAULT_NOT_FOUND');
  });

  it('FIDO2 / extra slots are deferred (NOT_SUPPORTED)', async () => {
    const { db, svc } = setup();
    const dir = tempDir();
    db.dir = dir;
    value(await svc.create({ directory: dir, password: PW, displayName: 'x' }));
    expect(codeOf(await svc.enrollFido2())).toBe('NOT_SUPPORTED');
    expect(codeOf(await svc.removeSlot())).toBe('NOT_SUPPORTED');
    await svc.lock();
    expect(codeOf(await svc.unlock({ password: PW, prfOutputB64: 'AAAA' }))).toBe('NOT_SUPPORTED');
  });

  it('changePassword requires an unlocked vault and rewraps', async () => {
    const { db, svc } = setup();
    const dir = tempDir();
    db.dir = dir;
    value(await svc.create({ directory: dir, password: PW, displayName: 'x' }));
    await svc.lock();
    expect(codeOf(await svc.changePassword({ currentPassword: PW, newPassword: 'n'.repeat(14) }))).toBe('VAULT_LOCKED');
    value(await svc.unlock({ password: PW }));
    expect(codeOf(await svc.changePassword({ currentPassword: 'bad', newPassword: 'n'.repeat(14) }))).toBe(
      'BAD_CREDENTIALS',
    );
    value(await svc.changePassword({ currentPassword: PW, newPassword: 'n'.repeat(14) }));
    await svc.lock();
    expect(codeOf(await svc.unlock({ password: PW }))).toBe('BAD_CREDENTIALS');
    expect(value(await svc.unlock({ password: 'n'.repeat(14) })).state).toBe('unlocked');
  });

  it('tampered header => VAULT_TAMPERED; DB open failure => VAULT_CORRUPT', async () => {
    const { db, svc } = setup();
    const dir = tempDir();
    db.dir = dir;
    value(await svc.create({ directory: dir, password: PW, displayName: 'x' }));
    await svc.lock();
    const p = join(dir, VAULT_FILE);
    const j = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    writeFileSync(p, JSON.stringify({ ...j, createdAt: '2000-01-01T00:00:00.000Z' }));
    const r = await svc.unlock({ password: PW });
    expect(r.ok ? null : r.error).toEqual({ code: 'VAULT_TAMPERED', message: 'Vault integrity check failed' });
    writeFileSync(p, JSON.stringify(j));
    db.keyByDb.set(dir, 'f'.repeat(64)); // DB "encrypted" with another key
    expect(codeOf(await svc.unlock({ password: PW }))).toBe('VAULT_CORRUPT');
    expect(value(await svc.status()).state).toBe('locked');
  });

  it('a DB written by a newer app => SCHEMA_NEWER_THAN_APP, vault stays locked', async () => {
    const { db, svc } = setup();
    const dir = tempDir();
    db.dir = dir;
    value(await svc.create({ directory: dir, password: PW, displayName: 'x' }));
    await svc.lock();
    db.open = () => {
      throw new DbError('SCHEMA_NEWER_THAN_APP', 'database schema v9 is newer than this app (v2)');
    };
    expect(codeOf(await svc.unlock({ password: PW }))).toBe('SCHEMA_NEWER_THAN_APP');
    expect(value(await svc.status()).state).toBe('locked');
  });

  it('backup + restore round-trip; wrong passphrase and corrupted backups are rejected', async () => {
    const { db, svc } = setup();
    const dir = tempDir();
    db.dir = dir;
    value(await svc.create({ directory: dir, password: PW, displayName: 'x' }));
    const out = join(tempDir(), 'vault.vssbak');
    const b = value(await svc.backup({ destPath: out, passphrase: 'backup passphrase 123' }));
    expect(b.bytes).toBe(readFileSync(out).length);
    expect(b.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(out).includes(db.content.subarray(0, 32))).toBe(false);

    const dest = tempDir();
    expect(codeOf(await svc.restore({ srcPath: out, passphrase: 'wrong passphrase!', destDirectory: dest }))).toBe(
      'BACKUP_INVALID',
    );
    expect(existsSync(join(dest, VAULT_FILE)) || existsSync(join(dest, DB_FILE))).toBe(false);

    const corrupt = join(tempDir(), 'c.vssbak');
    const bytes = readFileSync(out);
    bytes[bytes.length - 100] = (bytes[bytes.length - 100] ?? 0) ^ 1;
    writeFileSync(corrupt, bytes);
    expect(
      codeOf(await svc.restore({ srcPath: corrupt, passphrase: 'backup passphrase 123', destDirectory: dest })),
    ).toBe('BACKUP_INVALID');

    const st = value(await svc.restore({ srcPath: out, passphrase: 'backup passphrase 123', destDirectory: dest }));
    expect(st.state).toBe('locked');
    expect(readFileSync(join(dest, DB_FILE)).equals(db.content)).toBe(true);
    expect(readFileSync(join(dest, VAULT_FILE), 'utf8')).toBe(readFileSync(join(dir, VAULT_FILE), 'utf8'));
    db.dir = dest;
    db.keyByDb.set(dest, db.keyByDb.get(dir) as string);
    expect(value(await svc.unlock({ password: PW })).state).toBe('unlocked');
    expect(codeOf(await svc.restore({ srcPath: out, passphrase: 'backup passphrase 123', destDirectory: dest }))).toBe(
      'VAULT_EXISTS',
    );
  });

  it('backup requires an unlocked vault', async () => {
    const { svc } = setup();
    expect(codeOf(await svc.backup({ destPath: join(tempDir(), 'x'), passphrase: 'p'.repeat(12) }))).toBe(
      'VAULT_LOCKED',
    );
  });

  it('wipe re-authenticates then removes the vault files', async () => {
    const { db, svc } = setup();
    const dir = tempDir();
    db.dir = dir;
    value(await svc.create({ directory: dir, password: PW, displayName: 'x' }));
    expect(codeOf(await svc.wipe({ password: 'nope', confirm: 'WIPE' }))).toBe('BAD_CREDENTIALS');
    expect(existsSync(join(dir, VAULT_FILE))).toBe(true);
    expect(value(await svc.wipe({ password: PW, confirm: 'WIPE' })).state).toBe('no-vault');
    expect(existsSync(join(dir, VAULT_FILE)) || existsSync(join(dir, DB_FILE))).toBe(false);
  });

  it('touch only while unlocked', async () => {
    const onActivity = vi.fn();
    const db = new FakeDb();
    const svc = new VaultService({ db, kdf: FAST_KDF, onActivity });
    expect(codeOf(await svc.touch())).toBe('VAULT_LOCKED');
    db.dir = tempDir();
    value(await svc.create({ directory: db.dir, password: PW, displayName: 'x' }));
    value(await svc.touch());
    expect(onActivity).toHaveBeenCalledOnce();
  });
});
