/** Security review F-17: wipe also removes the encrypted pre-migration copies (cheap part of the finding). */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeApp, PW } from '../unit/app/helpers';

vi.setConfig({ testTimeout: 60_000 });

describe('F-17 wipe leftovers', () => {
  it('vault.wipe deletes the migration-backups folder as well', async () => {
    const t = await makeApp();
    try {
      expect((await t.call('vault', 'create', { password: PW, displayName: 'x' })).ok).toBe(true);
      mkdirSync(t.paths.migrationBackupDir, { recursive: true });
      const copy = join(t.paths.migrationBackupDir, 'vss-pre-migration-v1-to-v3-synthetic.db');
      writeFileSync(copy, 'encrypted copy (synthetic)');
      expect((await t.call('vault', 'wipe', { password: PW, confirm: 'WIPE' })).ok).toBe(true);
      expect(existsSync(copy)).toBe(false);
      expect(existsSync(join(t.paths.dataDir, 'vault.json'))).toBe(false);
    } finally {
      t.cleanup();
    }
  });
});
