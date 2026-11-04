/**
 * Contract completeness (docs/PLAN-ALPHA.md section 2, lane A0): every IPC method in METHODS has a channel, request
 * and response schemas, a main-process handler and a mock implementation, and every new Alpha 1 method answers
 * (NOT_SUPPORTED until its lane lands) instead of being missing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALL_CHANNELS, channelName, METHODS, NAMESPACES } from '@shared/ipc/channels';
import type { Namespace } from '@shared/ipc/channels';
import { EVENT_NAMES } from '@shared/ipc/contract';
import { eventSchemas, ipcSchemas, schemasForChannel } from '@shared/ipc/schemas';
import { APP_SCHEMA_VERSION } from '../../src/main/db/migrations';
import { createMockApi } from '../../src/renderer/src/mock/mockApi';
import { MOCK_EXTENSIONS } from '../../src/renderer/src/mock/ext';
import { makeApp, PW } from './app/helpers';
import type { TestApp } from './app/helpers';

vi.setConfig({ testTimeout: 60_000 });

/** Namespaces main deliberately leaves to the registry default (NOT_SUPPORTED): peer mode is post-MVP. */
const NO_MAIN_HANDLER: readonly Namespace[] = ['peer'];

const ID = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
/** Valid requests for the Alpha 1 methods whose lane has not landed (they must answer NOT_SUPPORTED). */
const LANE_STUBS: [Namespace, string, unknown][] = [
  ['requests', 'close', { id: ID, note: 'done' }],
  ['requests', 'reopen', { id: ID, reason: 'reopened for a correction' }],
  ['persons', 'suggest', { forSubject: { kind: 'review-item', id: ID } }],
  ['review', 'manualValidate', { id: ID, target: { kind: 'new-person' }, reason: 'valid answer' }],
  ['review', 'editSubject', { id: ID, subject: { kind: 'person', personId: ID, patch: {} }, reason: 'typo' }],
  ['email', 'renderTemplate', { template: 'reminder', requestId: ID }],
  ['email', 'previewTemplate', { template: 'reminder', subject: 'S', body: 'B' }],
  ['app', 'openFeedback', undefined],
];

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

describe('contract completeness', () => {
  it('every method has a channel and request/response schemas', () => {
    for (const ns of NAMESPACES) {
      for (const m of METHODS[ns] as readonly string[]) {
        const ch = channelName(ns, m as never);
        expect(ALL_CHANNELS, ch).toContain(ch);
        const s = schemasForChannel(ch);
        expect(s?.req, `${ch} req`).toBeDefined();
        expect(s?.res, `${ch} res`).toBeDefined();
      }
      expect(Object.keys((ipcSchemas as Record<string, object>)[ns]!).sort()).toEqual([...METHODS[ns]].sort());
    }
    expect(Object.keys(eventSchemas).sort()).toEqual([...EVENT_NAMES].sort());
  });

  it('every method has a main-process handler (peer.* excepted by design)', async () => {
    t = await makeApp();
    const handlers = t.app.handlers as Record<string, Record<string, unknown> | undefined>;
    for (const ns of NAMESPACES) {
      if (NO_MAIN_HANDLER.includes(ns)) continue;
      for (const m of METHODS[ns] as readonly string[]) expect(typeof handlers[ns]?.[m], `${ns}.${m}`).toBe('function');
    }
  });

  it('every method is implemented by the mock (base + lane extension modules)', () => {
    const ctl = createMockApi({ state: 'unlocked', idleTimer: false });
    try {
      const api = ctl.api as unknown as Record<string, Record<string, unknown>>;
      for (const ns of NAMESPACES)
        for (const m of METHODS[ns] as readonly string[])
          expect(typeof api[ns]?.[m], `mock ${ns}.${m}`).toBe('function');
      expect(typeof ctl.api.on).toBe('function');
      expect(MOCK_EXTENSIONS.length).toBeGreaterThanOrEqual(7);
    } finally {
      ctl.dispose();
    }
  });

  it('lane slots answer NOT_SUPPORTED in main and in the mock, with schema-valid requests', async () => {
    t = await makeApp();
    await t.call('vault', 'create', { password: PW, displayName: 'Test office' });
    const ctl = createMockApi({ state: 'unlocked', idleTimer: false });
    try {
      for (const [ns, m, arg] of LANE_STUBS) {
        const s = schemasForChannel(channelName(ns, m as never))!;
        expect(s.req.safeParse(arg).success, `${ns}.${m} request`).toBe(true);
        expect(await t.call(ns, m, arg), `main ${ns}.${m}`).toMatchObject({
          ok: false,
          error: { code: 'NOT_SUPPORTED' },
        });
        const fn = (ctl.api as unknown as Record<string, Record<string, (a: unknown) => Promise<unknown>>>)[ns]![m]!;
        expect(await fn(arg), `mock ${ns}.${m}`).toMatchObject({ ok: false, error: { code: 'NOT_SUPPORTED' } });
      }
    } finally {
      ctl.dispose();
    }
  });

  it('app.info and discardPreview work today, and their answers validate', async () => {
    t = await makeApp({ appInfo: { version: '0.2.0-alpha.1' } });
    const info = await t.call('app', 'info');
    expect(info.ok).toBe(true);
    expect(ipcSchemas.app.info.res.safeParse(info.value).success).toBe(true);
    expect(info.value).toMatchObject({ version: '0.2.0-alpha.1', channel: 'dev', schemaVersion: APP_SCHEMA_VERSION });
    await t.call('vault', 'create', { password: PW, displayName: 'Test office' });
    for (const ns of ['requests', 'responses'] as const)
      expect(await t.call(ns, 'discardPreview', { previewId: 'unknown-preview' })).toMatchObject({
        ok: true,
        value: { ok: true },
      });
    const review = await t.call('review', 'list', { offset: 0, limit: 10 });
    expect(ipcSchemas.review.list.res.safeParse(review.value).success).toBe(true);
    const dash = await t.call('stats', 'dashboard', {});
    expect(dash.ok && ipcSchemas.stats.dashboard.res.safeParse(dash.value).success).toBe(true);
    expect(dash.value.requestsByStatus).toMatchObject({ received: 0, finished: 0, closed: 0 });
  });

  it('crash recovery emits the code-only event', async () => {
    t = await makeApp();
    t.app.crashRecovered('E_TEST');
    expect(t.rec.events).toContainEqual({ event: 'app:crash-recovered', payload: { code: 'E_TEST' } });
    expect(eventSchemas['app:crash-recovered'].safeParse({ code: 'E_TEST' }).success).toBe(true);
  });
});
