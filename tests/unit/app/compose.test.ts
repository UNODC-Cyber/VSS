import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/domain/types';
import type { Settings } from '@shared/domain/types';
import { ipcSchemas } from '@shared/ipc/schemas';
import { makeApp, PW, PW2 } from './helpers';
import type { TestApp } from './helpers';

vi.setConfig({ testTimeout: 60_000 });

let t: TestApp | null = null;
afterEach(() => {
  vi.useRealTimers();
  t?.cleanup();
  t = null;
});

const create = (x: TestApp) => x.call('vault', 'create', { password: PW, displayName: 'Test office' });
const reauth = (password: string) => ({ password });
const withSettings = (patch: Partial<Settings>): Settings => ({ ...structuredClone(DEFAULT_SETTINGS), ...patch });

describe('compose: vault lifecycle', () => {
  it('first run: create vault in the configured data dir, unlock events, audit chain starts', async () => {
    t = await makeApp();
    expect(await t.app.initialRoute()).toBe('create');
    const r = await create(t);
    expect(r.ok && r.value.state).toBe('unlocked');
    expect(existsSync(join(t.paths.dataDir, 'vault.json'))).toBe(true);
    expect(existsSync(join(t.paths.dataDir, 'vss.db'))).toBe(true);
    expect(t.rec.events.map((e) => e.event)).toContain('vault:unlocked');
    const a = await t.call('audit', 'list', { offset: 0, limit: 10 });
    expect(a.ok && a.value.items.map((e: { type: string }) => e.type)).toEqual(['vault.create']);
    expect((await t.call('audit', 'verify')).value).toMatchObject({ ok: true, checked: 1 });
  });

  it('the renderer cannot choose where the vault is created', async () => {
    t = await makeApp();
    await t.call('vault', 'create', { directory: join(t.root, 'elsewhere'), password: PW, displayName: 'x' });
    expect(existsSync(join(t.root, 'elsewhere'))).toBe(false);
    expect(existsSync(join(t.paths.dataDir, 'vault.json'))).toBe(true);
  });

  it('existing vault => initial route unlock; wrong then right password', async () => {
    t = await makeApp();
    await create(t);
    await t.call('vault', 'lock');
    expect(await t.app.initialRoute()).toBe('unlock');
    const bad = await t.call('vault', 'unlock', { password: 'wrong wrong wrong wrong' });
    expect(bad).toMatchObject({ ok: false, error: { code: 'BAD_CREDENTIALS' } });
    const good = await t.call('vault', 'unlock', { password: PW });
    expect(good.ok && good.value.state).toBe('unlocked');
    const types = (await t.call('audit', 'list', { offset: 0, limit: 10 })).value.items.map(
      (e: { type: string }) => e.type,
    );
    expect(types).toEqual(['vault.unlock', 'vault.lock', 'vault.create']);
  });

  it('lock sequence: DB closed, clipboard cleared, renderer wiped, event sent, route changed', async () => {
    t = await makeApp();
    await create(t);
    await t.call('clipboard', 'copy', { field: 'plain', text: 'synthetic sensitive text' });
    expect(t.rec.clipboard.text).toBe('synthetic sensitive text');
    expect(t.rec.clipboard.sensitive).toBe(true);
    const r = await t.call('vault', 'lock');
    expect(r.ok && r.value.state).toBe('locked');
    await vi.waitFor(() => expect(t!.rec.events.some((e) => e.event === 'vault:locked')).toBe(true));
    expect(t.app.db.isOpen).toBe(false);
    expect(t.app.vault.keyMaterial).toBeNull();
    expect(t.rec.clipboard.text).toBe('');
    expect(t.rec.rendererCleared).toBeGreaterThan(0);
    expect(t.rec.routes.at(-1)).toBe('lock');
    expect(t.rec.events.find((e) => e.event === 'vault:locked')?.payload).toEqual({ reason: 'manual' });
    // everything that needs the DB now answers VAULT_LOCKED
    expect(await t.call('settings', 'get')).toMatchObject({ ok: false, error: { code: 'VAULT_LOCKED' } });
    expect(await t.call('audit', 'list', { offset: 0, limit: 5 })).toMatchObject({
      ok: false,
      error: { code: 'VAULT_LOCKED' },
    });
    expect(await t.call('clipboard', 'copy', { field: 'plain', text: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'VAULT_LOCKED' },
    });
  });

  it('idle lock fires after settings.autoLockMinutes and reports reason idle', async () => {
    t = await makeApp();
    await create(t);
    const up = await t.call('settings', 'update', {
      settings: withSettings({ autoLockMinutes: 1 }),
      reauth: reauth(PW),
    });
    expect(up.ok).toBe(true);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    t.app.lock.arm();
    await vi.advanceTimersByTimeAsync(61_000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(t!.app.db.isOpen).toBe(false));
    await vi.waitFor(() => expect(t!.rec.events.some((e) => e.event === 'vault:locked')).toBe(true));
    expect(t.rec.events.find((e) => e.event === 'vault:locked')?.payload).toEqual({ reason: 'idle' });
    expect(t.rec.events.some((e) => e.event === 'vault:lock-warning')).toBe(true);
  });
});

describe('compose: settings gating', () => {
  it('settings.update needs the password: wrong password changes nothing', async () => {
    t = await makeApp();
    await create(t);
    const r = await t.call('settings', 'update', {
      settings: withSettings({ clipboardClearSeconds: 99 }),
      reauth: reauth('wrong wrong wrong wrong'),
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'BAD_CREDENTIALS' } });
    expect((await t.call('settings', 'get')).value.clipboardClearSeconds).toBe(30);
  });

  it('right password persists, applies, and writes names (not values) to the audit chain', async () => {
    t = await makeApp();
    await create(t);
    const r = await t.call('settings', 'update', {
      settings: withSettings({ clipboardClearSeconds: 99, redactionMode: true }),
      reauth: reauth(PW),
    });
    expect(r.ok && r.value.clipboardClearSeconds).toBe(99);
    expect((await t.call('settings', 'get')).value).toMatchObject({ clipboardClearSeconds: 99, redactionMode: true });
    const ev = (await t.call('audit', 'list', { offset: 0, limit: 5, type: 'settings.update' })).value.items[0];
    expect(ev.details).toEqual({ fields: 'clipboardClearSeconds,redactionMode' });
    expect((await t.call('audit', 'verify')).value.ok).toBe(true);
    const copy = await t.call('clipboard', 'copy', { field: 'plain', text: 'abc' });
    expect(copy.value.clearsInSeconds).toBe(99);
  });

  it('an unchanged update is a no-op without audit noise; PRF re-auth is deferred', async () => {
    t = await makeApp();
    await create(t);
    const same = await t.call('settings', 'update', {
      settings: structuredClone(DEFAULT_SETTINGS),
      reauth: reauth(PW),
    });
    expect(same.ok).toBe(true);
    expect((await t.call('audit', 'list', { offset: 0, limit: 5, type: 'settings.update' })).value.total).toBe(0);
    const prf = await t.call('settings', 'update', {
      settings: withSettings({ autoLockMinutes: 5 }),
      reauth: { password: PW, prfOutputB64: 'AAAA' },
    });
    expect(prf).toMatchObject({ ok: false, error: { code: 'NOT_SUPPORTED' } });
  });

  it('wrong re-auth attempts count towards the unlock back-off', async () => {
    t = await makeApp();
    await create(t);
    for (let i = 0; i < 3; i++)
      await t.call('settings', 'update', {
        settings: withSettings({ autoLockMinutes: 5 }),
        reauth: reauth('wrong wrong wrong wrong'),
      });
    const st = await t.call('vault', 'status');
    expect(st.value.failedAttempts).toBeGreaterThanOrEqual(3);
  });

  it('settings schema stays the gate: payload without reauth is rejected by the registry schema', () => {
    const bad = ipcSchemas.settings.update.req.safeParse({ settings: DEFAULT_SETTINGS });
    expect(bad.success).toBe(false);
  });
});

describe('compose: updates wiring', () => {
  it('onUnlocked is called after each unlock but not on the very first create', async () => {
    t = await makeApp();
    await create(t);
    expect(t.updates.unlockedCalls).toBe(0);
    await t.call('vault', 'lock');
    await t.call('vault', 'unlock', { password: PW });
    expect(t.updates.unlockedCalls).toBe(1);
  });
});

describe('compose: lane H slot', () => {
  it('with an empty lane H factory those namespaces have no handler (NOT_SUPPORTED); peer is not planned', async () => {
    t = await makeApp({ laneH: () => ({}) });
    for (const [ns, m] of [
      ['requests', 'list'],
      ['responses', 'list'],
      ['persons', 'list'],
      ['units', 'list'],
      ['review', 'counts'],
      ['stats', 'dashboard'],
      ['peer', 'status'],
    ] as const) {
      expect(await t.call(ns, m, {})).toMatchObject({ ok: false, error: { code: 'NOT_SUPPORTED' } });
    }
  });

  it('merges lane H handlers and providers; this lane wins on conflicts', async () => {
    const laneH = vi.fn(() => ({
      handlers: {
        requests: { list: async () => ({ ok: true as const, value: { items: [], total: 0, offset: 0, limit: 1 } }) },
        settings: {
          get: async () => ({
            ok: false as const,
            error: { code: 'INTERNAL' as const, message: 'H must not override' },
          }),
        },
      },
      sources: {
        requestStatus: {
          snapshot: async () => ({
            eventName: 'Regional Workshop',
            asOf: '2026-11-03',
            rows: [{ name: 'Ada TESTPERSON', unit: 'Unit Alpha', status: 'Approved', validUntil: '2027-05-01' }],
          }),
        },
        personFields: { field: (_id: string, field: string) => (field === 'name' ? 'Ada TESTPERSON' : null) },
      },
    }));
    t = await makeApp({ laneH });
    expect(laneH).toHaveBeenCalledTimes(1);
    await create(t);
    expect((await t.call('requests', 'list', { offset: 0, limit: 1 })).ok).toBe(true);
    expect((await t.call('settings', 'get')).ok).toBe(true);
    const d = await t.call('email', 'draft', { template: 'clearance-notice', requestId: '01J0000000000000000000000A' });
    expect(d.value.subject).toBe('Regional Workshop \u2013 vetting status \u2013 2026-11-03');
    const c = await t.call('clipboard', 'copy', { personId: '01J0000000000000000000000B', field: 'name' });
    expect(c.ok).toBe(true);
    expect(t.rec.clipboard.text).toBe('Ada TESTPERSON');
    expect(
      await t.call('clipboard', 'copy', { personId: '01J0000000000000000000000B', field: 'passport' }),
    ).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});

describe('compose: email, files, audit export', () => {
  it('email.draft without a request source is NOT_SUPPORTED; writeEml and mailto work on a given draft', async () => {
    t = await makeApp({ laneH: () => ({}) });
    await create(t);
    expect(
      await t.call('email', 'draft', { template: 'clearance-notice', requestId: '01J0000000000000000000000A' }),
    ).toMatchObject({ ok: false, error: { code: 'NOT_SUPPORTED' } });
    const draft = {
      to: ['a@example.org'],
      cc: [],
      subject: 'Event \u2013 vetting status \u2013 2026-11-03',
      bodyText: 'Hello',
      attachmentName: null,
      containsPersonalData: false,
    };
    const dest = join(t.root, 'out.eml');
    expect((await t.call('email', 'writeEml', { draft, destPath: dest })).error.code).toBe('BAD_REQUEST'); // raw path
    const tok = await t.pickSave(dest, 'eml');
    expect((await t.call('email', 'writeEml', { draft, destPath: tok })).value).toEqual({ path: dest });
    expect((await t.call('email', 'writeEml', { draft, destPath: tok })).error.code).toBe('BAD_REQUEST'); // used
    expect(readFileSync(dest, 'utf8')).toContain('X-Unsent: 1');
    const m = await t.call('email', 'mailto', draft);
    expect(m.ok && m.value.truncated).toBe(false);
    expect(t.rec.opened).toHaveLength(1);
    expect(t.rec.opened[0]!.startsWith('mailto:')).toBe(true);
    const long = await t.call('email', 'mailto', { ...draft, bodyText: 'x'.repeat(4000) });
    expect(long.value.truncated).toBe(true);
    expect(t.rec.opened).toHaveLength(1); // nothing opened when the body did not fit
  });

  it('files dialogs return an opaque token for the picked path (shown via displayPath) or null on cancel', async () => {
    t = await makeApp();
    await create(t);
    expect((await t.call('files', 'pickOpen', { kind: 'request-xlsx' })).value).toEqual({
      path: null,
      displayPath: null,
    });
    const picked = join(t.root, 'request.xlsx');
    t.rec.files.openResult = picked;
    const o = (await t.call('files', 'pickOpen', { kind: 'request-xlsx' })).value;
    expect(o.path).toMatch(/^vss-file:[0-9a-f]{32}$/);
    expect(o.displayPath).toBe(picked);
    t.rec.files.saveResult = join(t.root, 'out.eml');
    const s = (await t.call('files', 'pickSave', { kind: 'eml', suggestedName: 'a.eml' })).value;
    expect(s.path).toMatch(/^vss-file:[0-9a-f]{32}$/);
    expect(s.path).not.toBe(o.path);
    expect((await t.call('files', 'reveal', { path: 'relative.txt' })).ok).toBe(false);
    expect((await t.call('files', 'reveal', { path: picked })).ok).toBe(false); // never written by main
    expect((await t.call('files', 'reveal', { path: o.path })).ok).toBe(true);
  });

  it('audit.export writes the whole chain as NDJSON', async () => {
    t = await makeApp();
    await create(t);
    await t.call('settings', 'update', { settings: withSettings({ autoLockMinutes: 5 }), reauth: reauth(PW) });
    const dest = join(t.root, 'audit.jsonl');
    expect((await t.call('audit', 'export', { destPath: await t.pickSave(dest, 'audit') })).ok).toBe(true);
    const lines = readFileSync(dest, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { seq: number; type: string });
    expect(lines.map((l) => l.type)).toEqual(['vault.create', 'settings.update']);
  });

  it('password change keeps working with the composed wiring', async () => {
    t = await makeApp();
    await create(t);
    expect((await t.call('vault', 'changePassword', { currentPassword: PW, newPassword: PW2 })).ok).toBe(true);
    await t.call('vault', 'lock');
    expect((await t.call('vault', 'unlock', { password: PW })).ok).toBe(false);
    expect((await t.call('vault', 'unlock', { password: PW2 })).ok).toBe(true);
  });
});

describe('compose: shutdown', () => {
  it('shutdown locks first and disposes timers', async () => {
    t = await makeApp();
    await create(t);
    await t.app.shutdown({ backup: false });
    expect(t.app.db.isOpen).toBe(false);
    expect(t.app.lock.armed).toBe(false);
  });
});
