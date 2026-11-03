import fc from 'fast-check';
import { describe, it } from 'vitest';
import {
  SharedStringsTable,
  colToIndex,
  escapeXmlAttr,
  escapeXmlText,
  indexToCol,
  isoToSerial,
  serialToIso,
  stripInvalidXmlChars,
  unescapeXml,
} from '../../src/main/formats/ooxml/index.ts';

describe('property: Excel serial <-> ISO date', () => {
  it('serial -> date -> serial is the identity (except the fake leap day)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2958465 }), (n) => {
        if (n === 60) return serialToIso(n) === null;
        const iso = serialToIso(n);
        return iso !== null && isoToSerial(iso) === n;
      }),
      { numRuns: 2000 },
    );
  });
  it('date -> serial -> date is the identity for valid dates', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('1900-03-01T00:00:00Z'), max: new Date('9999-12-31T00:00:00Z'), noInvalidDate: true }),
        (d) => {
          const iso = d.toISOString().slice(0, 10);
          const s = isoToSerial(iso);
          return s !== null && serialToIso(s) === iso;
        },
      ),
      { numRuns: 1000 },
    );
  });
  it('serials are strictly increasing with the date', () => {
    fc.assert(
      fc.property(fc.integer({ min: 61, max: 2958464 }), (n) => {
        const a = serialToIso(n) as string;
        const b = serialToIso(n + 1) as string;
        return a < b;
      }),
    );
  });
});

describe('property: XML escaping', () => {
  const anyString = fc.string({ unit: 'binary', maxLength: 80 });
  it('unescape(escape(s)) equals s without invalid characters', () => {
    fc.assert(
      fc.property(anyString, (s) => {
        const want = stripInvalidXmlChars(s);
        return unescapeXml(escapeXmlText(s)) === want && unescapeXml(escapeXmlAttr(s)) === want;
      }),
      { numRuns: 1000 },
    );
  });
  it('escaped text never contains markup characters', () => {
    fc.assert(
      fc.property(anyString, (s) => !/[<>]|&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(escapeXmlText(s))),
      { numRuns: 500 },
    );
  });
  it('survives a trip through the shared string table (including _xHHHH_ look-alikes)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(anyString, fc.constant('_x000D_'), fc.constant('_x005F_')), { maxLength: 8 }),
        (items) => {
          const t = SharedStringsTable.empty();
          const idx = items.map((s) => t.add(s));
          const back = new SharedStringsTable(t.serialize());
          return items.every((s, i) => back.get(idx[i] as number) === stripInvalidXmlChars(s));
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('property: column letters', () => {
  it('index -> label -> index', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 16384 }), (n) => colToIndex(indexToCol(n)) === n));
  });
});
