/**
 * Lane C service tests: the structure-based response parser through the real import service (encrypted temp DB).
 * Disposition-unclear rows create no record until resolved; a request workbook is refused plainly; an implicit section
 * and a missing batch id import; migration 007 backfills disp_class. Synthetic fixtures only.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RequestSummary } from '@shared/ipc/contract';
import { runMigrations } from '../../../src/main/db/migrate';
import { MIGRATIONS } from '../../../src/main/db/migrations';
import { openDatabase } from '../../../src/main/db/open';
import { buildResponseWorkbook } from '../../../tools/fixtures/response-builder';
import { newKey } from '../db/helpers';
import { commitHeader, errCode, fixtureBytes, harness, once, unwrap } from './helpers';
import type { Harness } from './helpers';

let h: Harness;
let dir = '';
afterEach(() => {
  h?.cleanup();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

async function sentRequest(h: Harness, name = 'req-001-basic'): Promise<RequestSummary> {
  const p = unwrap(await h.svc.requests.importFile(`${name}.xlsx`, fixtureBytes(`requests/${name}.xlsx`)));
  const s = await once(h, () => h.svc.requests.importCommit(commitHeader(p.previewId)));
  await once(h, () => h.svc.requests.export({ requestId: s.id, mode: 'filter-original', destPath: `/o/${s.id}.xlsx` }));
  await once(h, () => h.svc.requests.markSentToDc({ id: s.id, at: '2026-11-05T08:00:00.000Z' }));
  return s;
}

describe('disposition-unclear rows', () => {
  it('a "Pending" row creates no record until a person sets the disposition', async () => {
    h = harness();
    const s = await sentRequest(h);
    const pv = unwrap(
      await h.svc.responses.importFile('r7.xlsx', fixtureBytes('responses/resp-007-disp-variants.xlsx'), s.id),
    );
    expect(pv.canCommit).toBe(true);
    expect(pv.issues.filter((i) => i.code === 'DISP_UNRECOGNISED')).toHaveLength(1);
    expect(pv.rows.map((r) => r.dispClass)).toEqual([
      'approved',
      'approved',
      'approved',
      'approved',
      'unknown',
      'non-approved',
      'non-approved',
      'non-approved',
    ]);
    const pending = pv.rows.find((r) => r.disp === 'Pending')!;
    expect(pending.decision).toBe('auto'); // who the row is stays a separate question
    const out = await once(h, () => h.svc.responses.importCommit({ previewId: pv.previewId, requestId: s.id }));
    expect(h.fx.repos.vetting.listByResponseRow(pending.rowId)).toEqual([]);
    const others = pv.rows.filter((r) => r.rowId !== pending.rowId && r.section.endsWith('individual'));
    for (const r of others) expect(h.fx.repos.vetting.listByResponseRow(r.rowId)).toHaveLength(1);
    const unclear = h.fx.repos.reviews.openForSubject(pending.rowId).filter((r) => r.kind === 'disposition-unclear');
    expect(unclear).toHaveLength(1);
    expect(out.reviewItemsCreated).toBeGreaterThanOrEqual(1);
    expect(out.response.approvedCount + out.response.nonApprovedCount).toBe(pv.rows.length - 1);

    // A wrong review kind cannot set a disposition; the right one does, once.
    const item = unclear[0]!;
    await once(h, () =>
      h.svc.review.resolve({ id: item.id, resolution: { action: 'set-disposition', disposition: 'approved' } }),
    );
    const recs = h.fx.repos.vetting.listByResponseRow(pending.rowId);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ disposition: 'approved', certDate: '2026-10-20', source: 'dc-file' });
    expect(h.fx.repos.responses.getRow(pending.rowId)).toMatchObject({
      dispClass: 'approved',
      section: 'approved-individual',
    });
    expect(h.fx.repos.reviews.get(item.id)?.state).toBe('resolved');
    const ev = h.audit.list({ offset: 0, limit: 50 }).items.find((e) => e.type === 'review.resolve')!;
    expect(ev.details).toMatchObject({ kind: 'disposition-unclear', action: 'set-disposition', result: 'resolved' });
    expect(h.audit.verifyChain().ok).toBe(true);
  });

  it('set-disposition is refused for other review kinds', async () => {
    h = harness();
    const s = await sentRequest(h);
    const pv = unwrap(
      await h.svc.responses.importFile('r7.xlsx', fixtureBytes('responses/resp-007-disp-variants.xlsx'), s.id),
    );
    await once(h, () => h.svc.responses.importCommit({ previewId: pv.previewId, requestId: s.id }));
    const other = h.fx.repos.reviews
      .list({ offset: 0, limit: 50, state: 'open' })
      .items.find((r) => r.kind !== 'disposition-unclear');
    if (other)
      expect(
        errCode(
          await h.svc.review.resolve({
            id: other.id,
            resolution: { action: 'set-disposition', disposition: 'non-approved' },
          }),
        ),
      ).toBe('BAD_REQUEST');
  });
});

describe('structure variants through the service', () => {
  it('every response fixture previews and commits; only the request workbook is refused', async () => {
    h = harness();
    for (let n = 1; n <= 11; n++) {
      const id = readdirSync(new URL('../../../fixtures/responses/', import.meta.url)).find(
        (f) => f.startsWith(`resp-${String(n).padStart(3, '0')}-`) && f.endsWith('.xlsx'),
      )!;
      const pv = unwrap(await h.svc.responses.importFile(id, fixtureBytes(`responses/${id}`)));
      if (n === 11) {
        expect(pv.canCommit, id).toBe(false);
        continue;
      }
      expect(pv.errorCount, id).toBe(0);
      expect(pv.canCommit, id).toBe(true);
      await once(h, () => h.svc.responses.importCommit({ previewId: pv.previewId, requestId: null }));
    }
    expect(h.count('response')).toBe(10);
  });

  it('a request workbook in the response importer: friendly message, cannot commit', async () => {
    h = harness();
    const pv = unwrap(
      await h.svc.responses.importFile('x.xlsx', fixtureBytes('responses/resp-011-request-workbook.xlsx')),
    );
    expect(pv).toMatchObject({ fileKindGuess: 'investc-request', canCommit: false, rows: [], batchId: null });
    expect(pv.issues).toEqual([
      expect.objectContaining({
        code: 'LOOKS_LIKE_REQUEST',
        severity: 'error',
        message: 'This looks like a vetting request workbook, not a DC response. Use Requests > Import request for it.',
      }),
    ]);
    expect(errCode(await h.svc.responses.importCommit({ previewId: pv.previewId, requestId: null }))).toBe(
      'FILE_INVALID',
    );
  });

  it('implicit first section and renamed sheet import, and the section source is stored', async () => {
    h = harness();
    const s = await sentRequest(h);
    for (const f of ['resp-006-no-first-label', 'resp-010-renamed-sheet-hidden-extra']) {
      const pv = unwrap(await h.svc.responses.importFile(`${f}.xlsx`, fixtureBytes(`responses/${f}.xlsx`), s.id));
      expect(pv.canCommit, f).toBe(true);
      expect(pv.errorCount, f).toBe(0);
      const out = await once(h, () => h.svc.responses.importCommit({ previewId: pv.previewId, requestId: s.id }));
      const rows = h.fx.repos.responses.listRows(out.response.id);
      expect(rows).toHaveLength(pv.rows.length);
      if (f === 'resp-006-no-first-label') {
        expect(rows.filter((r) => r.sectionSource === 'implicit').map((r) => r.section)).toEqual([
          'approved-unit',
          'approved-unit',
        ]);
      } else expect(rows.every((r) => r.rowRef.startsWith('Results!'))).toBe(true);
    }
  });

  it('a file without batch id warns and takes the batch id the user gives at commit', async () => {
    h = harness();
    const { bytes } = buildResponseWorkbook({
      line1: 'Final Results as of 10/22/2026',
      line2: 'Post: Example City',
      line3: null,
      line4: 'Assistance: Example Workshop',
      sections: [
        {
          label: 'Approved Individuals:',
          rows: [
            {
              disp: 'Approve',
              name: 'Zqexample, Zqperson',
              dob: '1/2/1990',
              pob: ' -  - ATLANTIS',
              unitType: 'Police',
              unitName: 'Synthetic Unit',
              cert: '10/20/2026',
              expires: '10/20/2027',
            },
          ],
        },
      ],
    });
    const pv = unwrap(await h.svc.responses.importFile('nobatch.xlsx', bytes));
    expect(pv.batchId).toBeNull();
    expect(pv.issues.find((i) => i.code === 'META_LABEL_MISSING' && i.field === 'Batch ID:')?.severity).toBe('warning');
    expect(pv.canCommit).toBe(true);
    const out = await once(h, () =>
      h.svc.responses.importCommit({ previewId: pv.previewId, requestId: null, batchIdOverride: 'SYNTH-0000000077' }),
    );
    expect(h.fx.repos.responses.getHeader(out.response.id)?.batchId).toBe('SYNTH-0000000077');
  });

  it('mixed-script names import without errors and keep their Thai given names', async () => {
    h = harness();
    const s = await sentRequest(h);
    const pv = unwrap(
      await h.svc.responses.importFile('r8.xlsx', fixtureBytes('responses/resp-008-mixed-script-names.xlsx'), s.id),
    );
    expect(pv.errorCount).toBe(0);
    expect(pv.issues.filter((i) => i.code === 'NAME_MIXED_SCRIPT').every((i) => i.severity === 'info')).toBe(true);
    const out = await once(h, () => h.svc.responses.importCommit({ previewId: pv.previewId, requestId: s.id }));
    const rows = h.fx.repos.responses.listRows(out.response.id).filter((r) => r.section === 'approved-individual');
    expect(rows.every((r) => r.name.script === 'Mixed')).toBe(true);
    // The Thai tokens are kept apart from the Latin core of the key.
    expect(rows.every((r) => r.nameKey.coreTokens.every((t) => !/\p{Script=Thai}/u.test(t)))).toBe(true);
  });
});

describe('migration 007', () => {
  it('adds disp_class / section_source and backfills disp_class from the section', () => {
    dir = mkdtempSync(join(tmpdir(), 'vss-m007-'));
    const db = openDatabase(join(dir, 'vss.db'), newKey());
    runMigrations(db, { migrations: MIGRATIONS.slice(0, 6) });
    db.prepare("INSERT INTO response(id, batch_id) VALUES ('RESP', 'SYNTH-0000000001')").run();
    const ins = db.prepare('INSERT INTO response_row(id, response_id, section) VALUES (?, ?, ?)');
    ins.run('A', 'RESP', 'approved-individual');
    ins.run('B', 'RESP', 'nonapproved-unit');
    ins.run('C', 'RESP', null);
    runMigrations(db, { backupDir: join(dir, 'b') });
    const got = db.prepare('SELECT id, disp_class, section_source FROM response_row ORDER BY id').all();
    expect(got).toEqual([
      { id: 'A', disp_class: 'approved', section_source: 'label' },
      { id: 'B', disp_class: 'non-approved', section_source: 'label' },
      { id: 'C', disp_class: 'unknown', section_source: 'label' },
    ]);
    expect(() => db.prepare("UPDATE response_row SET disp_class = 'maybe' WHERE id = 'A'").run()).toThrow();
    db.close();
  });
});
