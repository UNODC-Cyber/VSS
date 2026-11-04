/**
 * UI review round 2, R2O-02 / R2O-04: dates of birth are never shown as valid when they are not, and an ambiguous
 * day/month date is never silently normalised. Covers the shared classifier, the request parser rules (R-08 text
 * dates), the response parser and the matcher's use of stored dates.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { classifyDob, isCalendarIsoDate, slashDateReadings } from '../../src/shared/domain/dob';
import { parseDobText } from '../../src/main/formats/investc/dob';
import { parseUsDate } from '../../src/main/formats/dc/parse';
import { compareDob, dobFromRaw } from '../../src/main/matching/dob';

const pad = (n: number) => String(n).padStart(2, '0');
const realDate = fc
  .date({ min: new Date('1900-01-01T00:00:00Z'), max: new Date('2099-12-31T00:00:00Z'), noInvalidDate: true })
  .map((d) => ({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }));
const iso = (p: { y: number; m: number; d: number }) => `${p.y}-${pad(p.m)}-${pad(p.d)}`;
/** 'YYYY-MM-DD' strings whose month is 13..99 or whose day does not exist in that month. */
const impossibleIso = fc.oneof(
  fc
    .record({
      y: fc.integer({ min: 1900, max: 2099 }),
      m: fc.integer({ min: 13, max: 99 }),
      d: fc.integer({ min: 1, max: 28 }),
    })
    .map(iso),
  fc.record({ y: fc.integer({ min: 1900, max: 2099 }), m: fc.constantFrom(4, 6, 9, 11), d: fc.constant(31) }).map(iso),
  fc
    .record({ y: fc.integer({ min: 1900, max: 2099 }), m: fc.integer({ min: 1, max: 12 }), d: fc.constant(0) })
    .map(iso),
);

describe('isCalendarIsoDate', () => {
  it('accepts every real day and rejects impossible ones', () => {
    fc.assert(fc.property(realDate, (p) => isCalendarIsoDate(iso(p))));
    fc.assert(fc.property(impossibleIso, (s) => !isCalendarIsoDate(s)));
  });
  it('knows leap years', () => {
    expect(isCalendarIsoDate('2024-02-29')).toBe(true);
    expect(isCalendarIsoDate('2023-02-29')).toBe(false);
    expect(isCalendarIsoDate('1900-02-29')).toBe(false);
    expect(isCalendarIsoDate('1995-20-07')).toBe(false);
  });
});

describe('classifyDob never normalises', () => {
  it('an impossible stored value is "invalid" and shown exactly as stored', () => {
    expect(classifyDob('1995-20-07', '1995-20-07')).toMatchObject({ state: 'invalid', text: '1995-20-07' });
    expect(classifyDob('1995-20-07', '')).toMatchObject({ state: 'invalid', text: '1995-20-07' });
    fc.assert(
      fc.property(impossibleIso, (s) => {
        const v = classifyDob(s, s);
        return v.state === 'invalid' && v.text === s;
      }),
    );
  });

  it('unparsed text is "invalid" and the text is shown as written', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim() !== ''),
        (raw) => {
          const v = classifyDob(null, raw);
          return v.state === 'invalid' && v.text === raw.trim();
        },
      ),
    );
  });

  it('never reports "ok" for anything that is not a real calendar date', () => {
    fc.assert(
      fc.property(fc.option(fc.string({ maxLength: 12 })), fc.option(fc.string({ maxLength: 12 })), (p, r) => {
        const v = classifyDob(p, r);
        return v.state !== 'ok' || isCalendarIsoDate(v.text);
      }),
    );
  });

  it('a slash date that reads as two real dates is "ambiguous" with both readings', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1900, max: 2099 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 12 }),
        (y, a, b) => {
          fc.pre(a !== b);
          const raw = `${a}/${b}/${y}`;
          const parsed = parseUsDate(raw)!; // the response parser's month/day reading
          const v = classifyDob(parsed, raw);
          return (
            v.state === 'ambiguous' &&
            v.text === parsed &&
            v.readings!.md === `${y}-${pad(a)}-${pad(b)}` &&
            v.readings!.dm === `${y}-${pad(b)}-${pad(a)}` &&
            v.raw === raw
          );
        },
      ),
    );
  });

  it('day > 12 or day == month is not ambiguous', () => {
    expect(classifyDob('2005-07-21', '7/21/2005').state).toBe('ok');
    expect(classifyDob('1990-03-03', '3/3/1990').state).toBe('ok');
    expect(slashDateReadings('13/13/1990')).toBeNull();
  });

  it('the request parser flags exactly the dates the display marks ambiguous (R-08)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1900, max: 2099 }),
        fc.integer({ min: 1, max: 31 }),
        fc.integer({ min: 1, max: 31 }),
        (y, a, b) => {
          const raw = `${a}/${b}/${y}`;
          const p = parseDobText(raw);
          const v = classifyDob(p.parsed, raw, { ambiguous: p.ambiguous });
          if (p.parsed === null) return v.state === 'invalid' && v.text === raw;
          return p.ambiguous === (v.state === 'ambiguous');
        },
      ),
    );
  });

  it('the request parser rejects impossible ISO text (never swaps it)', () => {
    expect(parseDobText('1995-20-07').parsed).toBeNull();
    fc.assert(fc.property(impossibleIso, (s) => parseDobText(s).parsed === null));
  });
});

describe('the matcher ignores impossible stored dates', () => {
  const raw = (parsed: string) => ({ kind: 'text' as const, value: parsed, parsed, ambiguousDayMonth: false });
  it('an impossible parsed value is no date: DOB_MISSING, never EQUAL or SWAPPED', () => {
    expect(dobFromRaw(raw('1995-20-07'))).toMatchObject({ date: null, precision: 'unknown' });
    expect(compareDob(dobFromRaw(raw('1995-20-07')), dobFromRaw(raw('1995-07-20')))).toBe('DOB_MISSING');
    fc.assert(
      fc.property(impossibleIso, realDate, (bad, good) => {
        const e = compareDob(dobFromRaw(raw(bad)), dobFromRaw(raw(iso(good))));
        return e === 'DOB_MISSING';
      }),
    );
  });
});
