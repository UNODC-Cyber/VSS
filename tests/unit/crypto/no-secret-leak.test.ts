/** Secrets (passwords, passphrases, DEK) must never reach error messages, results or console output. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { openBackup, sealBackup } from '../../../src/main/crypto/envelope';
import { changePassword, createVault, unlock, vaultFilePath } from '../../../src/main/crypto/vault';
import { VaultService } from '../../../src/main/services/vault-service';
import { cleanupTempDirs, FAST_KDF, readJson, tempDir, writeJson } from './helpers';

vi.setConfig({ testTimeout: 60_000 });
afterAll(cleanupTempDirs);

const SECRET = 'Leak-Canary-Password-7f3a9';
const WRONG = 'Leak-Canary-Wrong-c41d2';

describe('no secret in errors or logs', () => {
  it('crypto errors, service results and console output never contain a secret', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const captured: string[] = [];
    const grab = async (p: Promise<unknown>) => {
      try {
        captured.push(JSON.stringify(await p));
      } catch (e) {
        captured.push(String(e), JSON.stringify(e), (e as Error).stack ?? '');
      }
    };
    const dir = tempDir();
    const km = await createVault({ dir, password: SECRET, kdf: FAST_KDF });
    const dekHex = km.dbKeyHex();
    const dekB64 = km.dek.toString('base64');
    km.dispose();

    await grab(unlock({ dir, password: WRONG }));
    await grab(changePassword({ dir, currentPassword: WRONG, newPassword: SECRET }));
    const j = readJson(vaultFilePath(dir));
    writeJson(vaultFilePath(dir), {
      ...j,
      createdAt: '2000-01-01T00:00:00.000Z',
      failedAttempts: 0,
      lastFailureAt: null,
    });
    await grab(unlock({ dir, password: SECRET })); // VAULT_TAMPERED after a successful unwrap
    await grab(openBackup(await sealBackup(Buffer.from(SECRET), SECRET, { kdf: FAST_KDF }), WRONG));

    const svc = new VaultService({
      db: {
        open: () => undefined,
        close: () => undefined,
        vacuumInto: () => undefined,
        rekey: () => undefined,
        probe: () => false,
      },
    });
    await grab(svc.open({ path: dir }));
    await grab(svc.unlock({ password: WRONG }));
    await grab(svc.unlock({ password: SECRET }));

    const logged = spies.flatMap((s) => s.mock.calls.map((c) => JSON.stringify(c)));
    for (const s of spies) s.mockRestore();
    const all = [...captured, ...logged].join('\n');
    expect(captured.length).toBeGreaterThan(5);
    for (const needle of [SECRET, WRONG, dekHex, dekB64]) expect(all).not.toContain(needle);
    expect(logged).toEqual([]);
  });

  it('crypto and vault-service sources contain no console/logging calls', () => {
    const root = join(__dirname, '../../../src/main');
    const files = [
      ...readdirSync(join(root, 'crypto')).map((f) => join(root, 'crypto', f)),
      join(root, 'services', 'vault-service.ts'),
    ];
    for (const f of files) expect(readFileSync(f, 'utf8')).not.toMatch(/\bconsole\.|\blog\(/);
  });
});
