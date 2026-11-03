import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { METHODS, NAMESPACES } from '../../../src/shared/ipc/channels';
import { en } from '../../../src/renderer/src/locales/en';
import { createMockApi } from '../../../src/renderer/src/mock/mockApi';
import {
  agingBucket,
  bucketCounts,
  expiringCounts,
  meanMedian,
  requestsPerMonth,
} from '../../../src/renderer/src/lib/stats';
import { dobBoth, dobSwapped, mask } from '../../../src/renderer/src/lib/format';
import { parseHash } from '../../../src/renderer/src/lib/router';

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(f)) out.push(p);
  }
  return out;
}
const SRC = join(process.cwd(), 'src', 'renderer', 'src');

function lookup(key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), en);
}

describe('i18n', () => {
  it('every literal t() key used in the renderer exists in en.ts', () => {
    const missing: string[] = [];
    for (const file of walk(SRC)) {
      if (file.includes(`${join('locales')}`)) continue;
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\bt\(\s*'([^']+)'/g)) {
        if (typeof lookup(m[1]!) !== 'string') missing.push(`${file.replace(SRC, '')}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every dynamic key family resolves for all of its values', () => {
    const families: Record<string, string[]> = {
      status: ['unknown', 'pending', 'approved', 'expiring', 'expired', 'non-approved'],
      reqstatus: ['received', 'validated', 'exported', 'sent-to-dc', 'responded', 'closed', 'withdrawn'],
      link: ['auto', 'confirmed', 'pending-review', 'unlinked', 'new-person'],
      severity: ['error', 'warning', 'info'],
      disp: ['approved', 'non-approved', 'email-cleared'],
      source: ['dc-file', 'email', 'manual'],
      idtype: ['passport', 'national-id'],
      unittype: ['Military', 'Police', 'Prison', 'Other'],
      section: ['approved-unit', 'approved-individual', 'nonapproved-unit', 'nonapproved-individual'],
      template: ['request-to-dc', 'request-acknowledgement', 'clearance-notice', 'reminder-outstanding'],
      reviewkind: [
        'response-row-match',
        'request-item-link',
        'duplicate-persons',
        'dob-conflict',
        'unmatched-response-row',
        'unanswered-request-item',
      ],
      flagged: ['include', 'exclude', 'block'],
      respkind: ['dc-file', 'email-clearance'],
      updphase: [
        'idle',
        'disabled',
        'checking',
        'up-to-date',
        'available',
        'downloading',
        'verifying',
        'verified',
        'verify-failed',
        'error',
      ],
    };
    for (const [fam, vals] of Object.entries(families))
      for (const v of vals) expect(typeof lookup(`${fam}.${v}`), `${fam}.${v}`).toBe('string');
  });
});

describe('renderer safety', () => {
  it('has no security-key / WebAuthn code and no network calls', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8');
      if (
        /navigator\.credentials|webauthn|PublicKeyCredential|\bfetch\(|XMLHttpRequest|WebSocket|dangerouslySetInnerHTML|eval\(/i.test(
          text,
        )
      )
        offenders.push(file.replace(SRC, ''));
    }
    expect(offenders).toEqual([]);
  });

  it('the mock is only reachable through a DEV-guarded dynamic import', () => {
    const main = readFileSync(join(SRC, 'main.tsx'), 'utf8');
    expect(main).toMatch(/if \(import\.meta\.env\.DEV\)[\s\S]*await import\('\.\/mock\/install'\)/);
    for (const file of walk(SRC)) {
      if (file.includes(`${join('src', 'mock')}`) || file.endsWith('main.tsx')) continue;
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/from '\.\.?\/(\.\.\/)?mock\//);
    }
  });
});

describe('mock api', () => {
  it('implements every method of the VssApi contract', () => {
    const { api } = createMockApi({ idleTimer: false });
    for (const ns of NAMESPACES) {
      for (const m of METHODS[ns]) {
        expect(typeof (api[ns] as unknown as Record<string, unknown>)[m], `${ns}.${m}`).toBe('function');
      }
    }
    expect(typeof api.on).toBe('function');
  });

  it('seeded data contains only synthetic values', () => {
    const { db } = createMockApi({ state: 'unlocked', idleTimer: false });
    const blob = JSON.stringify([db.persons, db.requests, db.units]);
    expect(blob).not.toMatch(/@(?!example\.invalid)[a-z0-9.-]+\.[a-z]{2,}/i);
    expect(blob).toContain('Exampleland');
  });
});

describe('stats helpers', () => {
  it('buckets aging days at the documented boundaries', () => {
    expect([0, 7, 8, 14, 15, 30, 31].map(agingBucket)).toEqual(['0-7', '0-7', '8-14', '8-14', '15-30', '15-30', '>30']);
    expect(bucketCounts([1, 9, 20, 40, 41])).toEqual({ '0-7': 1, '8-14': 1, '15-30': 1, '>30': 2 });
  });
  it('computes mean and median', () => {
    expect(meanMedian([])).toEqual({ count: 0, mean: null, median: null });
    expect(meanMedian([1, 2, 9])).toEqual({ count: 3, mean: 4, median: 2 });
    expect(meanMedian([1, 2, 3, 10])).toEqual({ count: 4, mean: 4, median: 2.5 });
  });
  it('counts requests per month, oldest first', () => {
    const now = new Date(Date.UTC(2026, 10, 15));
    const rows = requestsPerMonth(
      [
        { receivedAt: '2026-11-02T00:00:00Z' },
        { receivedAt: '2026-09-30T00:00:00Z' },
        { receivedAt: '2026-11-20T00:00:00Z' },
      ] as never,
      3,
      now,
    );
    expect(rows).toEqual([
      { month: '2026-09', count: 1 },
      { month: '2026-10', count: 0 },
      { month: '2026-11', count: 2 },
    ]);
  });
  it('counts expiries inside 30/60/90 days', () => {
    const c = expiringCounts(
      [
        { expiresAt: '2026-11-10' },
        { expiresAt: '2026-12-20' },
        { expiresAt: '2027-01-20' },
        { expiresAt: '2026-10-01' },
      ],
      '2026-11-03',
    );
    expect(c).toEqual({ d30: 1, d60: 2, d90: 3 });
  });
});

describe('format + router helpers', () => {
  it('detects day/month swaps and renders both orders', () => {
    expect(dobSwapped('1985-02-10', '1985-10-02')).toBe(true);
    expect(dobSwapped('1985-02-02', '1985-02-02')).toBe(false);
    expect(dobBoth('1985-02-10')).toEqual({ dm: '10/02/1985', md: '02/10/1985' });
  });
  it('masks alphanumerics but keeps separators', () => {
    expect(mask('1985-02-10')).toBe('••••-••-••');
  });
  it('parses hash routes', () => {
    const r = parseHash('#/search?q=a%20b');
    expect(r.segments).toEqual(['search']);
    expect(r.query.get('q')).toBe('a b');
    expect(parseHash('').path).toBe('/');
  });
});
