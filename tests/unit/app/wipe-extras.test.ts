import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wipeExtras } from '../../../src/main/services/wipe';

const REQ = { password: 'x', confirm: 'WIPE' as const, alsoDeleteScheduledBackups: true };
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vss-wipe-extras-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const touch = (name: string) => writeFileSync(join(dir, name), 'synthetic');

describe('wipeExtras', () => {
  it('deletes only the files VSS wrote in the backup folder', async () => {
    const mine = [
      'vss-backup-20261103-100000.vssbak',
      'vss-backup-20261103-100000-2.vssbak',
      'vss-backup-keyring.vsskeys',
    ];
    const others = [
      'notes.txt',
      'vss-backup-20261103-100000.vssbak.bak',
      'my-vss-backup-20261103-100000.vssbak',
      'vss-backup-latest.vssbak',
      'export.xlsx',
      '.vss-backup.lock',
    ];
    for (const n of [...mine, ...others]) touch(n);
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'vss-backup-20261103-100000.vssbak'), 'in a sub-folder');
    await wipeExtras(REQ, { backupDir: dir });
    for (const n of mine) expect(existsSync(join(dir, n)), n).toBe(false);
    for (const n of others) expect(existsSync(join(dir, n)), n).toBe(true);
    expect(existsSync(join(dir, 'sub', 'vss-backup-20261103-100000.vssbak'))).toBe(true);
  });

  it('does nothing without the flag or without a folder', async () => {
    touch('vss-backup-20261103-100000.vssbak');
    await wipeExtras({ ...REQ, alsoDeleteScheduledBackups: false }, { backupDir: dir });
    await wipeExtras({ password: 'x', confirm: 'WIPE' }, { backupDir: dir });
    await wipeExtras(REQ, { backupDir: null });
    expect(existsSync(join(dir, 'vss-backup-20261103-100000.vssbak'))).toBe(true);
  });

  it('ignores a missing folder and an empty one', async () => {
    await expect(wipeExtras(REQ, { backupDir: join(dir, 'missing') })).resolves.toBeUndefined();
    await expect(wipeExtras(REQ, { backupDir: dir })).resolves.toBeUndefined();
  });
});
