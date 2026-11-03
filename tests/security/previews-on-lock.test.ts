/**
 * Security review F-14: import previews (parsed workbooks with personal data) do not survive a lock. The domain
 * services are dropped on every lock through the ServiceContext.onLock hook. Synthetic fixtures only.
 */
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDomainContribution } from '../../src/main/app/domain-wiring';
import type { ServiceContext } from '../../src/main/app/compose';
import { makeApp, PW } from '../unit/app/helpers';
import type { TestApp } from '../unit/app/helpers';
import { errCode, fixtureBytes, harness, unwrap } from '../unit/services/helpers';
import type { Harness } from '../unit/services/helpers';

vi.setConfig({ testTimeout: 60_000 });

let h: Harness | null = null;
let t: TestApp | null = null;
afterEach(() => {
  h?.cleanup();
  t?.cleanup();
  h = t = null;
});

describe('F-14 previews are dropped on lock', () => {
  it('dispose() drops request and response previews', async () => {
    h = harness();
    const rp = unwrap(await h.svc.requests.importFile('r.xlsx', fixtureBytes('requests/req-001-basic.xlsx')));
    const sp = unwrap(await h.svc.responses.importFile('a.xlsx', fixtureBytes('responses/resp-001-all-approved.xlsx')));
    h.svc.dispose();
    expect(
      errCode(
        await h.svc.requests.importCommit({
          previewId: rp.previewId,
          requestor: { name: 'Requestor Placeholder', email: null, organisation: null },
          eventName: 'E',
          eventStart: null,
          eventEnd: null,
          eventLocation: null,
          notes: '',
        }),
      ),
    ).toBe('PREVIEW_EXPIRED');
    expect(errCode(await h.svc.responses.importCommit({ previewId: sp.previewId, requestId: null }))).toBe(
      'PREVIEW_EXPIRED',
    );
  });

  it('the composition root runs the onLock hooks on every lock, and the real wiring registers one', async () => {
    let hooks = 0;
    let registered = 0;
    t = await makeApp({
      laneH: (sc: ServiceContext) =>
        createDomainContribution({
          ...sc,
          onLock: (fn) => {
            registered++;
            sc.onLock(() => {
              hooks++;
              fn();
            });
          },
        }),
    });
    expect(registered).toBe(1);
    expect((await t.call('vault', 'create', { password: PW, displayName: 'x' })).ok).toBe(true);
    const tok = await t.pickOpen(resolve('fixtures/requests/req-001-basic.xlsx'), 'request-xlsx');
    expect((await t.call('requests', 'importPreview', { path: tok })).ok).toBe(true);
    await t.call('vault', 'lock');
    expect(hooks).toBe(1);
    await t.call('vault', 'unlock', { password: PW });
    await t.call('vault', 'lock');
    expect(hooks).toBe(2);
  });
});
