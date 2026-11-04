/**
 * Demo seeder guard (docs/PLAN-ALPHA.md section 11): the seeder never runs in a release channel, never over an existing
 * vault, never without VSS_DEMO_SEED, and (packaged) only with the explicit alpha opt-in. A real run through the
 * composed services leaves the documented state. Synthetic data only.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDemoSeedAllowed, seedDemo } from '../../tools/demo/seed';
import { makeApp, PW } from '../unit/app/helpers';
import type { TestApp } from '../unit/app/helpers';

vi.setConfig({ testTimeout: 180_000 });

const base = { env: { VSS_DEMO_SEED: PW }, isPackaged: false, vaultExists: false };

describe('isDemoSeedAllowed', () => {
  it('allows an unpackaged build with a password and no vault', () => {
    expect(isDemoSeedAllowed(base)).toBe(PW);
  });
  it('refuses without the variable or with a too-short password', () => {
    expect(isDemoSeedAllowed({ ...base, env: {} })).toBeNull();
    expect(isDemoSeedAllowed({ ...base, env: { VSS_DEMO_SEED: 'short' } })).toBeNull();
  });
  it('refuses when a vault exists', () => {
    expect(isDemoSeedAllowed({ ...base, vaultExists: true })).toBeNull();
  });
  it('refuses the release channel, even with every opt-in', () => {
    expect(isDemoSeedAllowed({ ...base, channel: 'release' })).toBeNull();
    expect(
      isDemoSeedAllowed({ ...base, channel: 'release', env: { VSS_DEMO_SEED: PW, VSS_ALLOW_DEMO_SEED: '1' } }),
    ).toBeNull();
  });
  it('a packaged build needs VSS_ALLOW_DEMO_SEED=1', () => {
    expect(isDemoSeedAllowed({ ...base, isPackaged: true })).toBeNull();
    expect(isDemoSeedAllowed({ ...base, isPackaged: true, env: { VSS_DEMO_SEED: PW, VSS_ALLOW_DEMO_SEED: '1' } })).toBe(
      PW,
    );
    expect(isDemoSeedAllowed({ ...base, isPackaged: true, channel: 'alpha', env: { VSS_DEMO_SEED: PW } })).toBeNull();
  });
});

describe('main wiring', () => {
  it('calls seedDemo only inside the isDemoSeedAllowed branch', () => {
    const src = readFileSync(resolve('src/main/index.ts'), 'utf8');
    expect(src.match(/seedDemo\(/g)).toHaveLength(1);
    expect(src.indexOf('isDemoSeedAllowed(')).toBeLessThan(src.indexOf('seedDemo('));
    expect(src).toMatch(/if \(seedPassword\)/);
  });
});

let t: TestApp | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

describe('seedDemo (real services)', () => {
  it('imports both pairs, keeps the review cases, adds one Finished and one Closed request, and locks', async () => {
    t = await makeApp();
    await seedDemo({
      handlers: t.app.handlers,
      grants: t.app.grants,
      password: PW,
      fixturesDir: resolve('fixtures', 'demo'),
      tempDir: join(t.root, 'seed-tmp'),
    });
    expect((await t.call('vault', 'status')).value.state).toBe('locked');
    expect((await t.call('vault', 'unlock', { password: PW })).ok).toBe(true);
    const reqs = (await t.call('requests', 'list', { offset: 0, limit: 50 })).value.items as { status: string }[];
    expect(reqs).toHaveLength(4);
    const statuses = reqs.map((r) => r.status);
    expect(statuses).toContain('finished');
    expect(statuses).toContain('closed');
    const open = (await t.call('review', 'list', { offset: 0, limit: 100, state: 'open' })).value.items as {
      kind: string;
    }[];
    const kinds = new Set(open.map((i) => i.kind));
    expect(kinds.has('response-row-match')).toBe(true);
    expect(kinds.has('unanswered-request-item')).toBe(true);
    expect(kinds.has('unmatched-response-row')).toBe(true);
    expect((await t.call('templates', 'list')).value.active).not.toBeNull();
    expect((await t.call('requestors', 'list', { offset: 0, limit: 20 })).value.items.length).toBeGreaterThanOrEqual(2);
  });
});
