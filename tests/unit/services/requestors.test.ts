// Requestor service: dedupe through the request flows, global edits, merge, audit hygiene. Synthetic data only.
import type { Requestor } from '@shared/domain/types';
import { afterEach, describe, expect, it } from 'vitest';
import { AUDIT_DETAIL_KEYS } from '../../../src/main/services/audit';
import { errCode, harness, manualItem, manualRequest, unwrap } from './helpers';
import type { Harness } from './helpers';

let h: Harness;
afterEach(() => h?.cleanup());

const ROBIN = { name: 'Robin Placeholder', email: 'robin@example.invalid', organisation: 'Org One' };

async function manual(h: Harness, requestor: Requestor) {
  return unwrap(await h.svc.requests.createManual(manualRequest([manualItem()], { requestor })));
}
const requestorsAudit = (h: Harness) =>
  h.fx.db
    .prepare("SELECT type, subject_id, details_json FROM audit WHERE type LIKE 'requestor.%' ORDER BY seq")
    .all() as { type: string; subject_id: string; details_json: string }[];

describe('requestors through the request flows', () => {
  it('two requests with the same e-mail share one record', async () => {
    h = harness();
    const a = await manual(h, ROBIN);
    const b = await manual(h, { ...ROBIN, name: 'R. Placeholder', organisation: null });
    expect(h.count('requestor')).toBe(1);
    const ra = unwrap(await h.svc.requests.get({ id: a.id })).requestor;
    const rb = unwrap(await h.svc.requests.get({ id: b.id })).requestor;
    expect(ra.id).toBeTruthy();
    expect(rb.id).toBe(ra.id);
    // No id given: the saved values are not overwritten, the request keeps what was typed.
    expect(rb.name).toBe('R. Placeholder');
    const saved = unwrap(await h.svc.requestors.get({ id: ra.id! }));
    expect(saved).toMatchObject({ name: 'Robin Placeholder', organisation: 'Org One', requestCount: 2 });
  });

  it('without an e-mail, the same name + organisation is one record; another organisation is another', async () => {
    h = harness();
    await manual(h, { name: 'Sam Example', email: null, organisation: 'Org One' });
    await manual(h, { name: ' sam example ', email: null, organisation: 'ORG ONE' });
    await manual(h, { name: 'Sam Example', email: null, organisation: 'Org Two' });
    expect(h.count('requestor')).toBe(2);
  });

  it('editing with the saved id updates the global record and the requests that follow it', async () => {
    h = harness();
    const a = await manual(h, ROBIN);
    const idA = unwrap(await h.svc.requests.get({ id: a.id })).requestor.id!;
    const b = await manual(h, { ...ROBIN, id: idA });
    unwrap(
      await h.svc.requests.update({
        id: b.id,
        patch: { requestor: { id: idA, name: ROBIN.name, email: ROBIN.email, organisation: 'Org Two' } },
      }),
    );
    expect(unwrap(await h.svc.requestors.get({ id: idA })).organisation).toBe('Org Two');
    // The first request showed the saved values, so it follows.
    expect(unwrap(await h.svc.requests.get({ id: a.id })).requestor.organisation).toBe('Org Two');
    const updates = requestorsAudit(h).filter((e) => e.type === 'requestor.update');
    expect(updates).toHaveLength(1);
    expect(JSON.parse(updates[0]!.details_json)).toEqual({ fields: 'organisation', count: 2 });
  });

  it('"only this request" (no id, same e-mail) keeps the saved record unchanged', async () => {
    h = harness();
    const a = await manual(h, ROBIN);
    const idA = unwrap(await h.svc.requests.get({ id: a.id })).requestor.id!;
    const b = await manual(h, { ...ROBIN, organisation: 'One-off Org' });
    expect(unwrap(await h.svc.requestors.get({ id: idA })).organisation).toBe('Org One');
    expect(unwrap(await h.svc.requests.get({ id: b.id })).requestor.organisation).toBe('One-off Org');
    // A later global edit does not clobber the one-off value.
    unwrap(
      await h.svc.requestors.upsert({
        requestor: { id: idA, name: ROBIN.name, email: ROBIN.email, organisation: 'Org Three' },
      }),
    );
    expect(unwrap(await h.svc.requests.get({ id: b.id })).requestor.organisation).toBe('One-off Org');
    expect(unwrap(await h.svc.requests.get({ id: a.id })).requestor.organisation).toBe('Org Three');
  });

  it('a failed request save rolls the requestor back too', async () => {
    h = harness();
    h.fault.step = 'requests.createManual';
    const r = await h.svc.requests.createManual(manualRequest([manualItem()], { requestor: ROBIN }));
    expect(r.ok).toBe(false);
    expect(h.count('requestor')).toBe(0);
    expect(requestorsAudit(h)).toEqual([]);
  });
});

describe('requestors service', () => {
  it('upsert dedupes, fills blanks only, and rejects a taken e-mail on edit', async () => {
    h = harness();
    const a = unwrap(
      await h.svc.requestors.upsert({ requestor: { name: 'Robin', email: 'r@example.invalid', organisation: null } }),
    );
    const again = unwrap(
      await h.svc.requestors.upsert({
        requestor: { name: 'Different', email: 'R@example.invalid', organisation: 'Org One', phone: '+000 0000' },
      }),
    );
    expect(again.id).toBe(a.id);
    expect(again).toMatchObject({ name: 'Robin', organisation: 'Org One', phone: '+000 0000' });
    const other = unwrap(
      await h.svc.requestors.upsert({ requestor: { name: 'Sam', email: 's@example.invalid', organisation: null } }),
    );
    const clash = await h.svc.requestors.upsert({
      requestor: { id: other.id, name: 'Sam', email: 'r@example.invalid', organisation: null },
    });
    expect(errCode(clash)).toBe('CONFLICT');
    expect(
      errCode(
        await h.svc.requestors.upsert({
          requestor: { id: '0'.repeat(26), name: 'X', email: null, organisation: null },
        }),
      ),
    ).toBe('NOT_FOUND');
  });

  it('search, list and merge', async () => {
    h = harness();
    const a = await manual(h, ROBIN);
    const b = await manual(h, { name: 'Robin P', email: 'rp@example.invalid', organisation: null });
    const ida = unwrap(await h.svc.requests.get({ id: a.id })).requestor.id!;
    const idb = unwrap(await h.svc.requests.get({ id: b.id })).requestor.id!;
    expect(unwrap(await h.svc.requestors.search({ text: 'rp@exa' })).map((x) => x.id)).toEqual([idb]);
    expect(unwrap(await h.svc.requestors.search({ text: 'robin' }))).toHaveLength(2);
    expect(unwrap(await h.svc.requestors.list({ offset: 0, limit: 10 })).total).toBe(2);
    expect(errCode(await h.svc.requestors.merge({ survivorId: ida, mergedId: ida }))).toBe('BAD_REQUEST');
    const merged = unwrap(await h.svc.requestors.merge({ survivorId: ida, mergedId: idb }));
    expect(merged.requestCount).toBe(2);
    expect(unwrap(await h.svc.requests.get({ id: b.id })).requestor.id).toBe(ida);
    expect(errCode(await h.svc.requestors.get({ id: idb }))).toBe('NOT_FOUND');
  });

  it('audit events carry only ids, field names and counts', async () => {
    h = harness();
    const a = await manual(h, ROBIN);
    const id = unwrap(await h.svc.requests.get({ id: a.id })).requestor.id!;
    await h.svc.requestors.upsert({
      requestor: { id, name: ROBIN.name, email: 'new@example.invalid', organisation: 'Org Two' },
    });
    const b = await manual(h, { name: 'Sam Example', email: null, organisation: null });
    const idb = unwrap(await h.svc.requests.get({ id: b.id })).requestor.id!;
    await h.svc.requestors.merge({ survivorId: id, mergedId: idb });
    const events = requestorsAudit(h);
    expect(events.map((e) => e.type)).toEqual([
      'requestor.create',
      'requestor.update',
      'requestor.create',
      'requestor.merge',
    ]);
    for (const e of events) {
      for (const [k, v] of Object.entries(JSON.parse(e.details_json) as Record<string, unknown>)) {
        expect(AUDIT_DETAIL_KEYS.has(k), k).toBe(true);
        expect(String(v)).not.toMatch(/example|robin|sam|@/i);
      }
    }
  });
});
