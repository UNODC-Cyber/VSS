import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addDays, deriveStatus } from '@shared/domain/status';
import type { StatusRecord } from '@shared/domain/status';

const ASOF = '2026-06-01';
const dayOffset = fc.integer({ min: -800, max: 800 });
const recordArb = fc.record({
  id: fc.uuid(),
  unitId: fc.constant(null),
  disposition: fc.constantFrom('approved', 'non-approved', 'email-cleared') as fc.Arbitrary<
    StatusRecord['disposition']
  >,
  certDate: fc.constant('2026-01-01'),
  expiresAt: fc.option(
    dayOffset.map((d) => addDays(ASOF, d)),
    { nil: null },
  ),
  recordedAt: fc
    .integer({ min: 0, max: 1000 })
    .map((n) => new Date(Date.UTC(2026, 0, 1) + n * 3_600_000).toISOString()),
});

describe('deriveStatus properties', () => {
  it('is order independent', () => {
    fc.assert(
      fc.property(fc.array(recordArb, { maxLength: 6 }), fc.boolean(), (records, pending) => {
        const a = deriveStatus({ records, pending, asOf: ASOF, expiringWithinDays: 60 });
        const b = deriveStatus({ records: [...records].reverse(), pending, asOf: ASOF, expiringWithinDays: 60 });
        // Equal timestamps with different ids tie-break on id, which is order independent too.
        expect(b).toBe(a);
      }),
    );
  });
  it('never reports approved or unknown while a pending request exists', () => {
    fc.assert(
      fc.property(fc.array(recordArb, { maxLength: 6 }), (records) => {
        const s = deriveStatus({ records, pending: true, asOf: ASOF, expiringWithinDays: 60 });
        expect(['approved', 'unknown']).not.toContain(s);
      }),
    );
  });
  it('a refusal as the latest record always wins', () => {
    fc.assert(
      fc.property(fc.array(recordArb, { maxLength: 5 }), fc.boolean(), (records, pending) => {
        const refusal: StatusRecord = {
          id: 'zz',
          unitId: null,
          disposition: 'non-approved',
          certDate: null,
          expiresAt: null,
          recordedAt: '2030-01-01T00:00:00.000Z',
        };
        expect(deriveStatus({ records: [...records, refusal], pending, asOf: ASOF, expiringWithinDays: 60 })).toBe(
          'non-approved',
        );
      }),
    );
  });
});
