/**
 * Security review F-13: a DC response that was opened and re-saved (new bytes, same content) is recognised on
 * re-import and the preview warns, instead of silently doubling every vetting record. Rows whose request item
 * already has a DC answer are flagged too. Synthetic fixtures only.
 */
import { unzipSync, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { commitHeader, fixtureBytes, harness, unwrap } from '../unit/services/helpers';
import type { Harness } from '../unit/services/helpers';

let h: Harness;
afterEach(() => h?.cleanup());

/** What Excel does on "Save": same parts, new archive bytes (other compression level and timestamps). */
function resave(bytes: Uint8Array): Uint8Array {
  const parts = unzipSync(bytes);
  const out: Record<string, [Uint8Array, { level: 9; mtime: Date }]> = {};
  for (const [name, data] of Object.entries(parts)) out[name] = [data, { level: 9, mtime: new Date(2026, 10, 30) }];
  return zipSync(out);
}

async function seeded(h: Harness): Promise<string> {
  const p = unwrap(await h.svc.requests.importFile('r.xlsx', fixtureBytes('requests/req-001-basic.xlsx')));
  const s = unwrap(await h.svc.requests.importCommit(commitHeader(p.previewId)));
  unwrap(await h.svc.requests.markSentToDc({ id: s.id, at: '2026-11-05T08:00:00.000Z' }));
  const pv = unwrap(
    await h.svc.responses.importFile('a.xlsx', fixtureBytes('responses/resp-001-all-approved.xlsx'), s.id),
  );
  unwrap(await h.svc.responses.importCommit({ previewId: pv.previewId, requestId: s.id }));
  return s.id;
}

const resavedWarning = (issues: { message: string; severity: string }[]) =>
  issues.find((i) => i.message.includes('RESPONSE_RESAVED'));

describe('F-13 re-saved response detection', () => {
  it('a re-saved copy (different bytes) is recognised and the preview warns', async () => {
    h = harness();
    const requestId = await seeded(h);
    const copy = resave(fixtureBytes('responses/resp-001-all-approved.xlsx'));
    expect(Buffer.from(copy).equals(Buffer.from(fixtureBytes('responses/resp-001-all-approved.xlsx')))).toBe(false);
    const pv = unwrap(await h.svc.responses.importFile('copy.xlsx', copy, requestId));
    expect(pv.duplicateOfResponseId).toBeNull(); // not byte-identical
    const w = resavedWarning(pv.issues);
    expect(w?.severity).toBe('warning');
    expect(pv.issues.filter((i) => i.message.includes('ITEM_ALREADY_ANSWERED')).length).toBeGreaterThan(0);
  });

  it('the first import of a response gives no such warning', async () => {
    h = harness();
    const p = unwrap(await h.svc.requests.importFile('r.xlsx', fixtureBytes('requests/req-001-basic.xlsx')));
    const s = unwrap(await h.svc.requests.importCommit(commitHeader(p.previewId)));
    const pv = unwrap(
      await h.svc.responses.importFile('a.xlsx', fixtureBytes('responses/resp-001-all-approved.xlsx'), s.id),
    );
    expect(resavedWarning(pv.issues)).toBeUndefined();
    expect(pv.issues.some((i) => i.message.includes('ITEM_ALREADY_ANSWERED'))).toBe(false);
  });
});
