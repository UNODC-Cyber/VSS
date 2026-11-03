import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, deriveSnapshot, deriveStatus, isRequestAwaitingResponse } from '@shared/domain/status';
import type { StatusRecord } from '@shared/domain/status';

const ASOF = '2026-06-01';
const rec = (over: Partial<StatusRecord> & { id: string }): StatusRecord => ({
  unitId: null,
  disposition: 'approved',
  certDate: '2026-01-01',
  expiresAt: '2027-01-01',
  recordedAt: '2026-01-02T00:00:00Z',
  ...over,
});
const base = { asOf: ASOF, expiringWithinDays: 60 };

describe('deriveStatus', () => {
  it('unknown with no records', () => {
    expect(deriveStatus({ ...base, records: [], pending: false })).toBe('unknown');
  });
  it('pending with no records but an outstanding request', () => {
    expect(deriveStatus({ ...base, records: [], pending: true })).toBe('pending');
  });
  it('approved when valid beyond the expiring window', () => {
    expect(deriveStatus({ ...base, records: [rec({ id: 'a' })], pending: false })).toBe('approved');
  });
  it('approved when there is no expiry date', () => {
    expect(deriveStatus({ ...base, records: [rec({ id: 'a', expiresAt: null })], pending: false })).toBe('approved');
  });
  it('expiring inside the window, inclusive of the boundary day', () => {
    const exp = addDays(ASOF, 60);
    expect(deriveStatus({ ...base, records: [rec({ id: 'a', expiresAt: exp })], pending: false })).toBe('expiring');
    const out = addDays(ASOF, 61);
    expect(deriveStatus({ ...base, records: [rec({ id: 'a', expiresAt: out })], pending: false })).toBe('approved');
  });
  it('expiring on the day itself, expired the day after', () => {
    expect(deriveStatus({ ...base, records: [rec({ id: 'a', expiresAt: ASOF })], pending: false })).toBe('expiring');
    expect(deriveStatus({ ...base, records: [rec({ id: 'a', expiresAt: addDays(ASOF, -1) })], pending: false })).toBe(
      'expired',
    );
  });
  it('expired beats pending; expiring beats pending', () => {
    expect(deriveStatus({ ...base, records: [rec({ id: 'a', expiresAt: '2026-01-01' })], pending: true })).toBe(
      'expired',
    );
    expect(deriveStatus({ ...base, records: [rec({ id: 'a', expiresAt: '2026-06-20' })], pending: true })).toBe(
      'expiring',
    );
  });
  it('pending beats approved', () => {
    expect(deriveStatus({ ...base, records: [rec({ id: 'a' })], pending: true })).toBe('pending');
  });
  it('non-approved beats everything, including pending and expired', () => {
    const r = rec({ id: 'a', disposition: 'non-approved', expiresAt: '2020-01-01' });
    expect(deriveStatus({ ...base, records: [r], pending: true })).toBe('non-approved');
  });
  it('the most recent record decides (later approval supersedes earlier refusal)', () => {
    const refused = rec({ id: 'a', disposition: 'non-approved', recordedAt: '2026-01-02T00:00:00Z' });
    const approved = rec({ id: 'b', recordedAt: '2026-03-02T00:00:00Z' });
    expect(deriveStatus({ ...base, records: [refused, approved], pending: false })).toBe('approved');
    expect(deriveStatus({ ...base, records: [approved, refused], pending: false })).toBe('approved');
    const refusedLater = rec({ id: 'c', disposition: 'non-approved', recordedAt: '2026-04-01T00:00:00Z' });
    expect(deriveStatus({ ...base, records: [approved, refusedLater], pending: false })).toBe('non-approved');
  });
  it('email-cleared counts as cleared', () => {
    const r = rec({ id: 'a', disposition: 'email-cleared', expiresAt: '2026-06-25' });
    expect(deriveStatus({ ...base, records: [r], pending: false })).toBe('expiring');
  });
  it('snapshot carries the deciding record', () => {
    const r = rec({ id: 'rid', unitId: 'u1', certDate: '2026-02-02', expiresAt: '2027-02-02' });
    expect(deriveSnapshot({ ...base, records: [r], pending: false })).toEqual({
      status: 'approved',
      certDate: '2026-02-02',
      expiresAt: '2027-02-02',
      unitId: 'u1',
      source: 'rid',
      asOf: ASOF,
    });
  });
  it('respects a custom expiring window', () => {
    const r = rec({ id: 'a', expiresAt: addDays(ASOF, 90) });
    expect(deriveStatus({ records: [r], pending: false, asOf: ASOF, expiringWithinDays: 90 })).toBe('expiring');
    expect(deriveStatus({ records: [r], pending: false, asOf: ASOF, expiringWithinDays: 89 })).toBe('approved');
  });
});

describe('helpers', () => {
  it('daysBetween and addDays are calendar based and inverse', () => {
    expect(daysBetween('2026-02-27', '2026-03-01')).toBe(2);
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(daysBetween('2026-06-01', addDays('2026-06-01', 365))).toBe(365);
  });
  it('rejects malformed dates', () => {
    expect(() => daysBetween('2026-6-1', '2026-06-02')).toThrow(RangeError);
  });
  it('awaiting-response request states', () => {
    expect(isRequestAwaitingResponse('exported')).toBe(true);
    expect(isRequestAwaitingResponse('sent-to-dc')).toBe(true);
    expect(isRequestAwaitingResponse('received')).toBe(false);
    expect(isRequestAwaitingResponse('responded')).toBe(false);
  });
});
