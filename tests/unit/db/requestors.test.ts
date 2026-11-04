// Saved requestors: repo CRUD, unique e-mail, dedupe, search, merge, and the 005 backfill from a v4 database.
// All data is synthetic.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/main/db/migrate';
import { MIGRATIONS } from '../../../src/main/db/migrations';
import { openDatabase } from '../../../src/main/db/open';
import { createRepos } from '../../../src/main/db/repos';
import { freshDb, newKey, requestInput } from './helpers';
import type { Fixture } from './helpers';

let fx: Fixture | null = null;
let dir = '';
afterEach(() => {
  fx?.cleanup();
  fx = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

const AT = '2026-05-01T08:00:00.000Z';
const fields = (over: Partial<{ name: string; email: string | null; organisation: string | null }> = {}) => ({
  name: 'Robin Placeholder',
  email: 'robin@example.invalid' as string | null,
  organisation: 'Example Org' as string | null,
  phone: null,
  notes: '',
  ...over,
});

describe('RequestorRepo', () => {
  it('inserts, reads back and counts the requests that use a record', () => {
    fx = freshDb();
    const rec = fx.repos.requestors.insert({ ...fields(), at: AT });
    expect(rec).toMatchObject({ name: 'Robin Placeholder', email: 'robin@example.invalid', requestCount: 0 });
    const req = fx.repos.requests.insert(
      requestInput({ requestor: { id: rec.id, name: rec.name, email: rec.email, organisation: rec.organisation } }),
    );
    expect(req.requestor.id).toBe(rec.id);
    expect(fx.repos.requestors.get(rec.id)?.requestCount).toBe(1);
  });

  it('refuses a second record with the same folded e-mail', () => {
    fx = freshDb();
    fx.repos.requestors.insert({ ...fields(), at: AT });
    expect(() =>
      fx!.repos.requestors.insert({ ...fields({ name: 'Other Person', email: ' ROBIN@Example.invalid ' }), at: AT }),
    ).toThrow(expect.objectContaining({ code: 'IN_USE' }));
    // Several records without an address are fine.
    fx.repos.requestors.insert({ ...fields({ name: 'A', email: null }), at: AT });
    fx.repos.requestors.insert({ ...fields({ name: 'B', email: null }), at: AT });
  });

  it('dedupes by e-mail, else by folded name + organisation', () => {
    fx = freshDb();
    const withMail = fx.repos.requestors.insert({ ...fields(), at: AT });
    const noMail = fx.repos.requestors.insert({ ...fields({ name: 'Zoë Müller', email: null }), at: AT });
    const r = fx.repos.requestors;
    expect(r.findMatch({ name: 'Anyone', email: 'ROBIN@example.invalid', organisation: null })?.id).toBe(withMail.id);
    expect(r.findMatch({ name: 'zoe muller', email: null, organisation: ' example org' })?.id).toBe(noMail.id);
    expect(r.findMatch({ name: 'Zoë Müller', email: null, organisation: 'Another Org' })).toBeNull();
    // An address nobody owns still finds the address-less record with the same name + organisation.
    expect(r.findMatch({ name: 'Zoë Müller', email: 'zoe@example.invalid', organisation: 'Example Org' })?.id).toBe(
      noMail.id,
    );
  });

  it('searches folded name and e-mail, prefix hits first, escaping LIKE wildcards', () => {
    fx = freshDb();
    const r = fx.repos.requestors;
    r.insert({ ...fields({ name: 'Anna Lindqvist', email: 'anna@example.invalid' }), at: AT });
    r.insert({ ...fields({ name: 'Joanna Example', email: 'jo@example.invalid' }), at: AT });
    r.insert({ ...fields({ name: '100% Real', email: null }), at: AT });
    expect(r.search('anna', 8).map((x) => x.name)).toEqual(['Anna Lindqvist', 'Joanna Example']);
    expect(r.search('JO@EXAMPLE', 8).map((x) => x.name)).toEqual(['Joanna Example']);
    expect(r.search('%', 8).map((x) => x.name)).toEqual(['100% Real']);
    expect(r.search('', 2)).toHaveLength(2);
    expect(r.search('nobody', 8)).toEqual([]);
    expect(r.list({ offset: 0, limit: 2 }).total).toBe(3);
  });

  it('update rewrites only the requests that still mirror the old values', () => {
    fx = freshDb();
    const rec = fx.repos.requestors.insert({ ...fields(), at: AT });
    const same = { id: rec.id, name: rec.name, email: rec.email, organisation: rec.organisation };
    const a = fx.repos.requests.insert(requestInput({ requestor: same }));
    const b = fx.repos.requests.insert(requestInput({ requestor: { ...same, organisation: 'One-off Org' } }));
    const { followed } = fx.repos.requestors.update(rec.id, { ...fields({ organisation: 'New Org' }) }, AT);
    expect(followed).toBe(1);
    expect(fx.repos.requests.getHeader(a.id)?.requestor.organisation).toBe('New Org');
    expect(fx.repos.requests.getHeader(b.id)?.requestor.organisation).toBe('One-off Org');
  });

  it('merge repoints requests, fills blanks and deletes the merged record', () => {
    fx = freshDb();
    const r = fx.repos.requestors;
    const keep = r.insert({ ...fields({ email: null, organisation: null }), at: AT });
    const gone = r.insert({ ...fields({ name: 'Robin P.' }), at: AT });
    fx.repos.requests.insert(
      requestInput({ requestor: { id: gone.id, name: gone.name, email: gone.email, organisation: null } }),
    );
    const out = r.merge(keep.id, gone.id, AT);
    expect(out.moved).toBe(1);
    expect(out.record).toMatchObject({
      id: keep.id,
      email: 'robin@example.invalid',
      organisation: 'Example Org',
      requestCount: 1,
    });
    expect(r.get(gone.id)).toBeNull();
  });

  it('is not touched by purging a person (requestors are staff)', () => {
    fx = freshDb();
    const tables = (fx.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'requestor'").get() as { sql: string })
      .sql;
    expect(tables).not.toMatch(/person/i);
  });
});

describe('migration 005 backfill', () => {
  it('creates one requestor per distinct e-mail, else per name + organisation, and links the requests', () => {
    dir = mkdtempSync(join(tmpdir(), 'vss-rq-'));
    const db = openDatabase(join(dir, 'vss.db'), newKey());
    runMigrations(db, { migrations: MIGRATIONS.slice(0, 4) });
    const ins = db.prepare(
      `INSERT INTO request(id, kind, received_at, requestor_name, requestor_email, requestor_org, event_name, status)
       VALUES (?, 'file', ?, ?, ?, ?, 'Synthetic Event', 'received')`,
    );
    ins.run(
      '01HZZZZZZZZZZZZZZZZZZZZZZ1',
      '2026-01-01T00:00:00Z',
      'Robin Placeholder',
      'robin@example.invalid',
      'Org A',
    );
    ins.run('01HZZZZZZZZZZZZZZZZZZZZZZ2', '2026-02-01T00:00:00Z', 'R. Placeholder', ' ROBIN@example.invalid', 'Org B');
    ins.run('01HZZZZZZZZZZZZZZZZZZZZZZ3', '2026-03-01T00:00:00Z', 'Sam Example', '', 'Org A');
    ins.run('01HZZZZZZZZZZZZZZZZZZZZZZ4', '2026-04-01T00:00:00Z', 'sam example', null, 'ORG A');
    ins.run('01HZZZZZZZZZZZZZZZZZZZZZZ5', '2026-05-01T00:00:00Z', 'Sam Example', null, 'Org C');
    ins.run('01HZZZZZZZZZZZZZZZZZZZZZZ6', '2026-06-01T00:00:00Z', '', null, null);
    runMigrations(db, { backupDir: join(dir, 'backups') });

    const repos = createRepos(db);
    const all = repos.requestors.list({ offset: 0, limit: 50 });
    expect(all.total).toBe(3);
    const robin = all.items.find((x) => x.email?.toLowerCase() === 'robin@example.invalid')!;
    // The latest request of the group supplies the displayed values.
    expect(robin).toMatchObject({ name: 'R. Placeholder', organisation: 'Org B', requestCount: 2 });
    expect(
      all.items
        .filter((x) => x.email === null)
        .map((x) => x.requestCount)
        .sort(),
    ).toEqual([1, 2]);
    const link = (id: string) => repos.requests.getHeader(id)?.requestor.id;
    expect(link('01HZZZZZZZZZZZZZZZZZZZZZZ1')).toBe(robin.id);
    expect(link('01HZZZZZZZZZZZZZZZZZZZZZZ2')).toBe(robin.id);
    expect(link('01HZZZZZZZZZZZZZZZZZZZZZZ3')).toBe(link('01HZZZZZZZZZZZZZZZZZZZZZZ4'));
    expect(link('01HZZZZZZZZZZZZZZZZZZZZZZ5')).not.toBe(link('01HZZZZZZZZZZZZZZZZZZZZZZ3'));
    expect(link('01HZZZZZZZZZZZZZZZZZZZZZZ6')).toBeUndefined();
    db.close();
  });
});
