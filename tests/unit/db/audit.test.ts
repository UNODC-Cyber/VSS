import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyKey } from '../../../src/main/db/open';
import { AuditLog, canonicalJson, GENESIS_HASH } from '../../../src/main/services/audit';
import { freshDb } from './helpers';
import type { Fixture } from './helpers';

let fx: Fixture;
let log: AuditLog;
beforeEach(() => {
  fx = freshDb();
  log = new AuditLog(fx.db);
});
afterEach(() => fx.cleanup());

function seed(n = 5): void {
  for (let i = 0; i < n; i++)
    log.append({
      actor: 'local-user',
      type: 'request.import',
      subjectType: 'request',
      subjectId: `01J0000000000000000000000${i}`,
      details: { itemCount: i, mode: 'file' },
    });
}

/** Separate raw connection that bypasses the app (simulates an attacker with the key). */
function raw(): Database.Database {
  const r = new Database(fx.path);
  applyKey(r, fx.key);
  return r;
}

describe('canonicalJson', () => {
  it('sorts keys recursively and is stable', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: true, y: 'x' }], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,{"y":"x","z":true}]},"b":1}',
    );
  });
});

describe('AuditLog', () => {
  it('appends a hash chain from genesis and verifies', () => {
    const e1 = log.append({ actor: 'local-user', type: 'vault.unlock', subjectType: 'vault', subjectId: null });
    const e2 = log.append({
      actor: 'local-user',
      type: 'settings.update',
      subjectType: 'settings',
      subjectId: null,
      details: { setting: 'autoLockMinutes' },
    });
    expect(e1).toMatchObject({ seq: 1, prevHash: GENESIS_HASH });
    expect(e2.prevHash).toBe(e1.hash);
    expect(log.verifyChain()).toEqual({ ok: true, checked: 2, brokenAtSeq: null });
    expect(new AuditLog(fx.db).verifyChain().ok).toBe(true);
  });

  it('empty log verifies', () => {
    expect(log.verifyChain()).toEqual({ ok: true, checked: 0, brokenAtSeq: null });
  });

  it('rejects non-allowlisted keys, long strings, non-primitive values', () => {
    expect(() =>
      log.append({ actor: 'a', type: 't', subjectType: 's', subjectId: null, details: { surname: 'X' } }),
    ).toThrow(expect.objectContaining({ code: 'AUDIT_DETAIL_REJECTED' }));
    expect(() =>
      log.append({ actor: 'a', type: 't', subjectType: 's', subjectId: null, details: { code: 'x'.repeat(201) } }),
    ).toThrow(/200/);
    expect(() =>
      log.append({
        actor: 'a',
        type: 't',
        subjectType: 's',
        subjectId: null,
        details: { count: { n: 1 } as unknown as number },
      }),
    ).toThrow(/primitive/);
    expect(() =>
      log.append({ actor: 'a', type: 't', subjectType: 's', subjectId: null, details: { count: Number.NaN } }),
    ).toThrow();
    expect(
      log.append({ actor: 'a', type: 't', subjectType: 's', subjectId: null, details: { code: 'x'.repeat(200) } }).seq,
    ).toBe(1);
  });

  it('list filters and pages newest first', () => {
    seed(5);
    log.append({
      actor: 'local-user',
      type: 'person.merge',
      subjectType: 'person',
      subjectId: null,
      details: { survivorId: 'a', mergedId: 'b' },
    });
    const p = log.list({ offset: 0, limit: 2 });
    expect(p.total).toBe(6);
    expect(p.items.map((e) => e.seq)).toEqual([6, 5]);
    expect(log.list({ offset: 0, limit: 10, type: 'request.import' }).total).toBe(5);
    expect(log.list({ offset: 0, limit: 10, subjectId: '01J00000000000000000000003' }).items[0]!.details).toEqual({
      itemCount: 3,
      mode: 'file',
    });
  });

  it('SQL triggers block UPDATE and DELETE through the app connection', () => {
    seed(2);
    expect(() => fx.db.exec("UPDATE audit SET actor = 'x' WHERE seq = 1")).toThrow(/append-only/);
    expect(() => fx.db.exec('DELETE FROM audit WHERE seq = 2')).toThrow(/append-only/);
  });

  it('detects an edit made through a raw connection with triggers dropped', () => {
    seed(5);
    const r = raw();
    r.exec('DROP TRIGGER audit_append_only');
    r.prepare('UPDATE audit SET details_json = ? WHERE seq = 3').run('{"itemCount":99,"mode":"file"}');
    r.close();
    expect(log.verifyChain()).toEqual({ ok: false, checked: 2, brokenAtSeq: 3 });
  });

  it('detects a re-hashed edit (chain break at the next row)', () => {
    seed(5);
    const r = raw();
    r.exec('DROP TRIGGER audit_append_only');
    // Attacker recomputes row 3's own hash but cannot fix row 4's prev_hash without rewriting the rest.
    r.prepare("UPDATE audit SET actor = 'mallory', hash = ? WHERE seq = 3").run('f'.repeat(64));
    r.close();
    const v = log.verifyChain();
    expect(v.ok).toBe(false);
    expect(v.brokenAtSeq).toBe(3);
  });

  it('detects deletion in the middle and truncation at the end', () => {
    seed(5);
    const r = raw();
    r.exec('DROP TRIGGER audit_no_delete');
    r.exec('DELETE FROM audit WHERE seq = 5');
    r.close();
    expect(log.verifyChain()).toEqual({ ok: false, checked: 4, brokenAtSeq: 5 });
    const r2 = raw();
    r2.exec('DELETE FROM audit WHERE seq = 2');
    r2.close();
    expect(log.verifyChain()).toMatchObject({ ok: false, brokenAtSeq: 3 });
  });

  it('a failed append inside an outer transaction leaves no row', () => {
    seed(1);
    expect(() =>
      fx.db.transaction(() => {
        log.append({ actor: 'a', type: 't', subjectType: 's', subjectId: null });
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(log.verifyChain()).toEqual({ ok: true, checked: 1, brokenAtSeq: null });
  });
});
