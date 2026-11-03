import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteDbController } from '../../../src/main/db/controller';
import { DbError, isDbError } from '../../../src/main/db/errors';
import { openDatabase } from '../../../src/main/db/open';
import { createRepos } from '../../../src/main/db/repos';
import { freshDb, newKey, personInput } from './helpers';
import type { Fixture } from './helpers';

const MARKERS = ['ZQXSYNTHETICSURNAME', 'Qvxsyntheticgiven', 'ทดสอบสมมติ', 'synthetic-id-ZZ9911'];

let fx: Fixture | null = null;
afterEach(() => {
  fx?.cleanup();
  fx = null;
});

function seed(f: Fixture): void {
  f.repos.persons.insert(
    personInput({
      canonical: { surname: MARKERS[0]!, given: [MARKERS[1]!], raw: `${MARKERS[0]}, ${MARKERS[1]}`, script: 'Latn' },
      aliases: [{ surname: MARKERS[2]!, given: [], raw: MARKERS[2]!, script: 'Thai' }],
      identifiers: [
        { type: 'passport', value: MARKERS[3]!, valueFolded: MARKERS[3]!.toLowerCase(), issuingCountry: 'Testland' },
      ],
    }),
  );
}

function fileHasAny(path: string): string[] {
  if (!existsSync(path)) return [];
  const buf = readFileSync(path);
  return MARKERS.filter(
    (m) => buf.includes(Buffer.from(m, 'utf8')) || buf.includes(Buffer.from(m.toLowerCase(), 'utf8')),
  );
}

describe('openDatabase', () => {
  it('applies WAL, FULL sync, secure_delete, temp_store MEMORY, foreign keys', () => {
    fx = freshDb();
    const p = (s: string) => fx!.db.raw.pragma(s, { simple: true });
    expect(p('journal_mode')).toBe('wal');
    expect(p('synchronous')).toBe(2);
    expect(p('secure_delete')).toBe(1);
    expect(p('temp_store')).toBe(2);
    expect(p('foreign_keys')).toBe(1);
  });

  it('DB, -wal and -shm contain no plaintext synthetic strings (open and after close)', () => {
    fx = freshDb();
    seed(fx);
    for (const suffix of ['', '-wal', '-shm']) expect(fileHasAny(fx.path + suffix), suffix || 'main').toEqual([]);
    // Sanity: the WAL actually holds data while open.
    expect(existsSync(`${fx.path}-wal`)).toBe(true);
    fx.db.close();
    for (const suffix of ['', '-wal', '-shm']) expect(fileHasAny(fx.path + suffix), suffix || 'main').toEqual([]);
  });

  it('rejects a wrong key with a typed error and keeps the file intact', () => {
    fx = freshDb();
    seed(fx);
    fx.db.close();
    let err: unknown;
    try {
      openDatabase(fx.path, newKey());
    } catch (e) {
      err = e;
    }
    expect(isDbError(err, 'WRONG_KEY')).toBe(true);
    const again = openDatabase(fx.path, fx.key);
    expect(createRepos(again).persons.count()).toBe(1);
    again.close();
  });

  it('rejects a malformed key', () => {
    expect(() => openDatabase('unused.db', 'abc')).toThrow(DbError);
    expect(() => openDatabase('unused.db', `${'g'.repeat(64)}`)).toThrow(/64 hex/);
  });

  it('vacuumInto writes an encrypted copy readable with the same key', () => {
    fx = freshDb();
    seed(fx);
    const out = join(fx.dir, 'copy.db');
    fx.db.vacuumInto(out);
    expect(fileHasAny(out)).toEqual([]);
    const c = openDatabase(out, fx.key);
    expect(createRepos(c).persons.count()).toBe(1);
    c.close();
    expect(() => fx!.db.vacuumInto(out)).toThrow(/exists/);
  });

  it('rekey: new key opens, old key is rejected', () => {
    fx = freshDb();
    seed(fx);
    const k2 = newKey();
    fx.db.rekey(k2);
    createRepos(fx.db).persons.insert(personInput());
    fx.db.close();
    expect(() => openDatabase(fx!.path, fx!.key)).toThrow(DbError);
    const d = openDatabase(fx.path, k2);
    expect(createRepos(d).persons.count()).toBe(2);
    d.close();
  });

  it('transaction rolls back on throw', () => {
    fx = freshDb();
    expect(() =>
      fx!.db.transaction(() => {
        fx!.repos.persons.insert(personInput());
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(fx.repos.persons.count()).toBe(0);
  });

  it('close checkpoints and is idempotent; use after close is NOT_OPEN', () => {
    fx = freshDb();
    seed(fx);
    fx.db.close();
    fx.db.close();
    expect(existsSync(`${fx.path}-wal`)).toBe(false);
    expect(() => fx!.db.prepare('SELECT 1')).toThrow(expect.objectContaining({ code: 'NOT_OPEN' }));
  });
});

describe('SqliteDbController', () => {
  it('open migrates, close locks, vacuumInto works, wrong key leaves it closed', () => {
    fx = freshDb();
    fx.db.close();
    let opened = 0;
    const c = new SqliteDbController({ path: fx.path, backupDir: join(fx.dir, 'bk'), onOpen: () => opened++ });
    expect(c.isOpen).toBe(false);
    expect(() => c.current()).toThrow(expect.objectContaining({ code: 'NOT_OPEN' }));
    expect(() => c.open(newKey())).toThrow(expect.objectContaining({ code: 'WRONG_KEY' }));
    expect(c.isOpen).toBe(false);
    c.open(fx.key);
    expect(opened).toBe(1);
    c.repos().persons.insert(personInput());
    c.vacuumInto(join(fx.dir, 'ctl-copy.db'));
    c.close();
    expect(c.isOpen).toBe(false);
    expect(() => c.repos()).toThrow(DbError);
    c.open(fx.key);
    expect(c.repos().persons.count()).toBe(1);
    c.close();
  });
});
