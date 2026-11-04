// Property tests of the pure request lifecycle (docs/PLAN-ALPHA.md section 6, lane D).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  canClose,
  canReopen,
  canTransition,
  isFinished,
  isManualTarget,
  LIFECYCLE_TRANSITIONS,
  REQUEST_STATUSES,
  statusAfterRecompute,
  statusAfterReopen,
} from '../../src/shared/domain/lifecycle';
import type { ExportDecision, RequestStatus } from '../../src/shared/domain/types';

const status = fc.constantFrom<RequestStatus>(...REQUEST_STATUSES);
const decision = fc.constantFrom<ExportDecision>('include', 'exclude', 'manual-include', 'manual-exclude');
const personIds = ['p1', 'p2', 'p3', 'p4'];
const item = fc.record({
  exportDecision: decision,
  personId: fc.option(fc.constantFrom(...personIds), { nil: null }),
});
const recorded = fc.subarray(personIds).map((a) => new Set(a));

describe('lifecycle transition table', () => {
  it('has a row for every status and never lists a status as its own successor', () => {
    expect(Object.keys(LIFECYCLE_TRANSITIONS).sort()).toEqual([...REQUEST_STATUSES].sort());
    for (const s of REQUEST_STATUSES) expect(LIFECYCLE_TRANSITIONS[s]).not.toContain(s);
  });

  it('only Responded (derived) or Closed (reopen) lead to Finished, only Finished leads to Closed', () => {
    fc.assert(
      fc.property(status, status, (from, to) => {
        if (to === 'finished' && canTransition(from, to)) expect(['responded', 'closed']).toContain(from); // closed: reopen
        if (to === 'closed' && canTransition(from, to)) expect(from).toBe('finished');
        if (from === 'closed' && canTransition(from, to)) expect(['finished', 'responded']).toContain(to);
      }),
    );
  });

  it('Finished and Closed are never manual targets; close/reopen preconditions match the table', () => {
    expect(isManualTarget('finished')).toBe(false);
    expect(isManualTarget('closed')).toBe(false);
    for (const s of REQUEST_STATUSES) {
      expect(canClose(s)).toBe(canTransition(s, 'closed'));
      expect(canReopen(s)).toBe(s === 'closed');
    }
  });
});

describe('isFinished / recompute', () => {
  it('an empty request is never finished', () => {
    fc.assert(
      fc.property(recorded, (r) => {
        expect(isFinished([], r)).toBe(false);
      }),
    );
  });

  it('is monotone: more records never un-finish a request; excluding an item never un-finishes it', () => {
    fc.assert(
      fc.property(fc.array(item, { minLength: 1, maxLength: 8 }), recorded, recorded, (items, a, b) => {
        const union = new Set([...a, ...b]);
        if (isFinished(items, a)) expect(isFinished(items, union)).toBe(true);
        const excluded = items.map((i) => ({ ...i, exportDecision: 'exclude' as const }));
        expect(isFinished(excluded, new Set())).toBe(true);
      }),
    );
  });

  it('an included item without a linked person or without a record keeps the request open', () => {
    fc.assert(
      fc.property(fc.array(item, { minLength: 1, maxLength: 8 }), recorded, (items, r) => {
        const open = items.some(
          (i) =>
            i.exportDecision !== 'exclude' &&
            i.exportDecision !== 'manual-exclude' &&
            !(i.personId !== null && r.has(i.personId)),
        );
        expect(isFinished(items, r)).toBe(!open);
      }),
    );
  });

  it('recompute only ever moves responded <-> finished, and the result is a legal transition', () => {
    fc.assert(
      fc.property(status, fc.boolean(), (s, fin) => {
        const next = statusAfterRecompute(s, fin);
        if (next !== s) {
          expect([s, next].sort()).toEqual(['finished', 'responded']);
          expect(canTransition(s, next)).toBe(true);
        }
        expect(statusAfterRecompute(next, fin)).toBe(next); // idempotent
      }),
    );
  });

  it('reopen returns to finished or responded, both legal from closed', () => {
    for (const fin of [true, false]) expect(canTransition('closed', statusAfterReopen(fin))).toBe(true);
  });
});
