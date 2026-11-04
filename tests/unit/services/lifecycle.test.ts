// Request lifecycle service (lane D): Finished is derived, Close is gated, Reopen needs a reason. Synthetic data only.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RequestSummary } from '@shared/ipc/contract';
import { runMigrations } from '../../../src/main/db/migrate';
import { MIGRATIONS } from '../../../src/main/db/migrations';
import { openDatabase } from '../../../src/main/db/open';
import { newKey } from '../db/helpers';
import { commitHeader, errCode, fixtureBytes, harness, unwrap } from './helpers';
import type { Harness } from './helpers';

let h: Harness;
afterEach(() => h?.cleanup());

async function importAndSend(h: Harness): Promise<RequestSummary> {
  const p = unwrap(await h.svc.requests.importFile('req-001-basic.xlsx', fixtureBytes('requests/req-001-basic.xlsx')));
  const s = unwrap(await h.svc.requests.importCommit(commitHeader(p.previewId, '2026-11-20')));
  unwrap(await h.svc.requests.markSentToDc({ id: s.id, at: '2026-11-05T08:00:00.000Z' }));
  return s;
}

async function respondFully(h: Harness, id: string): Promise<void> {
  const bytes = fixtureBytes('responses/resp-001-all-approved.xlsx');
  const pv = unwrap(await h.svc.responses.importFile('resp-001.xlsx', bytes, id));
  unwrap(await h.svc.responses.importCommit({ previewId: pv.previewId, requestId: id }));
}

const eventsOf = (type: string): { actor: string; details_json: string }[] =>
  h.fx.db.prepare('SELECT actor, details_json FROM audit WHERE type = ? ORDER BY seq').all(type) as never;

describe('automatic Finished', () => {
  it('a response that answers every item makes the request Finished without user action (audited as system)', async () => {
    h = harness();
    const s = await importAndSend(h);
    await respondFully(h, s.id);
    const hd = h.fx.repos.requests.getHeader(s.id)!;
    expect(hd.status).toBe('finished');
    expect(hd.finishedAt).not.toBeNull();
    const ev = eventsOf('request.finish');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.actor).toBe('system');
    expect(JSON.parse(ev[0]!.details_json)).toMatchObject({ fromStatus: 'responded', toStatus: 'finished' });
    expect(h.audit.verifyChain().ok).toBe(true);
  });

  it('a request with unanswered items stays Responded; excluding them finishes it', async () => {
    h = harness();
    const s = await importAndSend(h);
    const items = h.fx.repos.requests.listItems(s.id);
    // Make one person unknown to the response by excluding nobody first: answer by email for all but the last item.
    const answered = items.slice(0, -1).map((i) => i.id);
    unwrap(
      await h.svc.responses.recordEmailClearance({
        requestId: s.id,
        itemIds: answered,
        disposition: 'approved',
        certDate: '2026-11-10',
        expiresAt: null,
        note: '',
      }),
    );
    expect(h.fx.repos.requests.getHeader(s.id)!.status).toBe('responded');
    unwrap(
      await h.svc.requests.setItemDecision({
        itemId: items[items.length - 1]!.id,
        decision: 'exclude',
        reason: 'withdrawn',
      }),
    );
    expect(h.fx.repos.requests.getHeader(s.id)!.status).toBe('finished');
    // including it again takes the request back to Responded
    unwrap(
      await h.svc.requests.setItemDecision({
        itemId: items[items.length - 1]!.id,
        decision: 'include',
        reason: 'back',
      }),
    );
    const hd = h.fx.repos.requests.getHeader(s.id)!;
    expect(hd.status).toBe('responded');
    expect(hd.finishedAt).toBeNull();
  });

  it('Finished and Closed cannot be set by hand', async () => {
    h = harness();
    const s = await importAndSend(h);
    expect(errCode(await h.svc.requests.setStatus({ id: s.id, status: 'finished' }))).toBe('LIFECYCLE_CONFLICT');
    expect(errCode(await h.svc.requests.setStatus({ id: s.id, status: 'closed' }))).toBe('LIFECYCLE_CONFLICT');
  });
});

describe('close and reopen', () => {
  it('Close needs Finished; it records the note on the row and audits ids and lengths only', async () => {
    h = harness();
    const s = await importAndSend(h);
    expect(errCode(await h.svc.lifecycle.close({ id: s.id, note: 'too early' }))).toBe('LIFECYCLE_CONFLICT');
    await respondFully(h, s.id);
    const closed = unwrap(await h.svc.lifecycle.close({ id: s.id, note: '  Reviewed with the requestor.  ' }));
    expect(closed.status).toBe('closed');
    expect(closed.closedAt).not.toBeNull();
    expect(closed.closeNote).toBe('Reviewed with the requestor.');
    const ev = eventsOf('request.close');
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0]!.details_json)).toEqual({
      requestId: s.id,
      fromStatus: 'finished',
      toStatus: 'closed',
      noteLength: 'Reviewed with the requestor.'.length,
    });
    expect(ev[0]!.details_json).not.toContain('Reviewed');
    expect(errCode(await h.svc.lifecycle.close({ id: s.id, note: '' }))).toBe('LIFECYCLE_CONFLICT');
    expect(errCode(await h.svc.requests.setStatus({ id: s.id, status: 'responded' }))).toBe('LIFECYCLE_CONFLICT');
  });

  it('Reopen needs Closed and a reason of at least 3 characters; it recomputes and counts', async () => {
    h = harness();
    const s = await importAndSend(h);
    await respondFully(h, s.id);
    expect(errCode(await h.svc.lifecycle.reopen({ id: s.id, reason: 'not closed yet' }))).toBe('LIFECYCLE_CONFLICT');
    unwrap(await h.svc.lifecycle.close({ id: s.id, note: '' }));
    expect(errCode(await h.svc.lifecycle.reopen({ id: s.id, reason: ' ab ' }))).toBe('REASON_REQUIRED');
    const re = unwrap(await h.svc.lifecycle.reopen({ id: s.id, reason: 'Late correction' }));
    expect(re.status).toBe('finished');
    expect(re.closedAt).toBeNull();
    expect(re.closeNote).toBe('');
    expect(re.reopenCount).toBe(1);
    const ev = eventsOf('request.reopen');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.details_json).not.toContain('Late');
    expect(h.fx.repos.requests.noteHistory(s.id).map((e) => e.kind)).toEqual(['close', 'reopen']);
    expect(h.audit.verifyChain().ok).toBe(true);
  });

  it('reopening after an item became unanswered falls back to Responded', async () => {
    h = harness();
    const s = await importAndSend(h);
    await respondFully(h, s.id);
    unwrap(await h.svc.lifecycle.close({ id: s.id, note: '' }));
    // an added, unanswered item while the request is closed
    h.fx.repos.requests.addItems(s.id, [
      { ...h.fx.repos.requests.listItems(s.id)[0]!, personId: null, linkState: 'unlinked', id: undefined } as never,
    ]);
    const re = unwrap(await h.svc.lifecycle.reopen({ id: s.id, reason: 'Added a person' }));
    expect(re.status).toBe('responded');
  });

  it('unknown ids answer NOT_FOUND', async () => {
    h = harness();
    expect(errCode(await h.svc.lifecycle.close({ id: '01HZZZZZZZZZZZZZZZZZZZZZZZ', note: '' }))).toBe('NOT_FOUND');
  });
});

describe('migration 006 backfill', () => {
  it('lifecycle columns exist with defaults on a fresh database', async () => {
    h = harness();
    const s = await importAndSend(h);
    const hd = h.fx.repos.requests.getHeader(s.id)!;
    expect(hd).toMatchObject({ finishedAt: null, closedAt: null, closeNote: '', reopenCount: 0 });
  });

  it('closed rows stay closed; responded rows whose items are all answered or excluded become finished', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vss-lc-'));
    const db = openDatabase(join(dir, 'vss.db'), newKey());
    try {
      runMigrations(db, { migrations: MIGRATIONS.slice(0, 5) });
      const req = db.prepare(
        "INSERT INTO request(id, kind, received_at, status, responded_at) VALUES (?, 'manual', '2026-01-01T00:00:00Z', ?, '2026-01-05T00:00:00Z')",
      );
      const item = db.prepare(
        'INSERT INTO request_item(id, request_id, observed_json, person_id, export_decision) VALUES (?, ?, ?, ?, ?)',
      );
      const person = db.prepare("INSERT INTO person(id, state) VALUES (?, 'active')");
      const rec = db.prepare('INSERT INTO vetting_record(id, person_id, request_id) VALUES (?, ?, ?)');
      for (const id of ['pa', 'pb']) person.run(id);
      req.run('r-closed', 'closed');
      req.run('r-done', 'responded'); // one answered, one excluded
      item.run('i1', 'r-done', '{}', 'pa', 'include');
      item.run('i2', 'r-done', '{}', null, 'exclude');
      rec.run('v1', 'pa', 'r-done');
      req.run('r-open', 'responded'); // one included item without a record
      item.run('i3', 'r-open', '{}', 'pb', 'include');
      req.run('r-empty', 'responded'); // no items
      runMigrations(db, { backupDir: join(dir, 'backups') });
      const rows = db.prepare('SELECT id, status, finished_at, closed_at, reopen_count FROM request ORDER BY id').all();
      expect(rows).toEqual([
        { id: 'r-closed', status: 'closed', finished_at: null, closed_at: '2026-01-05T00:00:00Z', reopen_count: 0 },
        { id: 'r-done', status: 'finished', finished_at: '2026-01-05T00:00:00Z', closed_at: null, reopen_count: 0 },
        { id: 'r-empty', status: 'responded', finished_at: null, closed_at: null, reopen_count: 0 },
        { id: 'r-open', status: 'responded', finished_at: null, closed_at: null, reopen_count: 0 },
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
