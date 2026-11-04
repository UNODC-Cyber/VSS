/** Property tests of the structure-based DC response parser (lane C). Synthetic strings only. */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { classifyDisp, parseFinalResults, parseSectionLabel, splitName } from '../../../src/main/formats/dc/index.ts';
import {
  buildResponseWorkbook,
  type ResponseRowSpec,
  type ResponseWorkbookSpec,
} from '../../../tools/fixtures/response-builder.ts';

const HEADERS = ['DISP', 'NAME', 'DOB', 'POB', 'UNIT TYPE', 'UNIT NAME', 'CERT DATE', 'EXPIRES'];
const LABELS = [
  'Approved Unit/Commander:',
  'Approved Individuals:',
  'Non Approved Unit/Commander:',
  'Non Approved Individuals:',
];
/** Letters of the Thai, Lao, Khmer and Myanmar blocks, combining marks, ZWSP / ZWJ / BOM and a few Latin letters. */
const SCRIPT_CHARS = fc.oneof(
  fc.integer({ min: 0x0e00, max: 0x0e7f }),
  fc.integer({ min: 0x0e80, max: 0x0eff }),
  fc.integer({ min: 0x1780, max: 0x17ff }),
  fc.integer({ min: 0x1000, max: 0x109f }),
  fc.integer({ min: 0x0300, max: 0x036f }),
  fc.constantFrom(0x200b, 0x200d, 0xfeff, 0x20, 0x2c, 0x2d, 0x41, 0x7a),
);
const scriptText = fc.array(SCRIPT_CHARS, { maxLength: 24 }).map((cs) => String.fromCodePoint(...cs));
const cellText = fc.oneof(scriptText, fc.string({ maxLength: 20 }), fc.constantFrom('Approve', 'Not Approved', ''));

const rowArb: fc.Arbitrary<ResponseRowSpec> = fc.record({
  disp: cellText,
  name: fc.oneof(
    cellText,
    fc.tuple(scriptText, scriptText).map(([a, b]) => `${a}, ${b}`),
  ),
  dob: fc.constantFrom('1/2/1990', '', '13/13/1990', 'x'),
  pob: fc.constantFrom('CITY - STATE - THAILAND', '', ' -  - '),
  unitType: fc.constantFrom('Police', ''),
  unitName: cellText,
  cert: fc.constantFrom('10/20/2026', ''),
  expires: fc.constantFrom('10/20/2027', ''),
});

const specArb: fc.Arbitrary<ResponseWorkbookSpec> = fc.record({
  line1: fc.oneof(fc.constant('Final Results as of 10/22/2026'), fc.constant(null), cellText),
  line2: fc.oneof(fc.constant('Post: Example City'), fc.constant(null)),
  line3: fc.oneof(fc.constant('Batch ID: SYNTH-0000000001'), fc.constant(null), cellText),
  line4: fc.oneof(fc.constant('Assistance: Example'), fc.constant(null)),
  sections: fc.array(
    fc.record({
      label: fc.oneof(fc.constantFrom(...LABELS), fc.constant(null), cellText),
      rows: fc.array(rowArb, { maxLength: 4 }),
      noHeader: fc.boolean(),
    }),
    { maxLength: 5 },
  ),
});

/** Fisher-Yates driven by fast-check so shrinking works. */
const permutation = (n: number): fc.Arbitrary<number[]> =>
  fc.array(fc.nat(), { minLength: n, maxLength: n }).map((rs) => {
    const out = [...Array(n).keys()];
    for (let i = n - 1; i > 0; i--) {
      const j = (rs[i] ?? 0) % (i + 1);
      [out[i], out[j]] = [out[j] as number, out[i] as number];
    }
    return out;
  });

describe('DC response parser properties', { timeout: 120_000 }, () => {
  it('classifyDisp is total and deterministic on arbitrary Unicode', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ unit: 'grapheme', maxLength: 30 }), scriptText), (s) => {
        const a = classifyDisp(s);
        expect(['approved', 'non-approved', 'unknown', 'blank']).toContain(a);
        expect(classifyDisp(s)).toBe(a);
        expect(() => parseSectionLabel(s)).not.toThrow();
        expect(() => splitName(s)).not.toThrow();
      }),
      { numRuns: 2000 },
    );
  });

  it('parseFinalResults never throws, and a blocked result is never silent', () => {
    fc.assert(
      fc.property(specArb, (s) => {
        const r = parseFinalResults(buildResponseWorkbook(s).bytes);
        expect(r.blocked).toBe(r.issues.some((i) => i.severity === 'error'));
        if (r.blocked) expect(r.issues.length).toBeGreaterThan(0);
        for (const row of r.draft.rows) {
          expect(['approved', 'non-approved', 'unknown']).toContain(row.dispClass);
          // 'unknown' rows are never stored under an approved section
          if (row.dispClass !== 'approved') expect(row.section.startsWith('nonapproved')).toBe(true);
          else expect(row.section.startsWith('approved')).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('a workbook with reordered columns parses to the same draft as the canonical one', () => {
    fc.assert(
      fc.property(
        fc.array(rowArb, { minLength: 1, maxLength: 4 }),
        fc.array(rowArb, { maxLength: 3 }),
        permutation(HEADERS.length),
        (units, people, perm) => {
          const base: ResponseWorkbookSpec = {
            line1: 'Final Results as of 10/22/2026',
            line2: 'Post: Example City',
            line3: 'Batch ID: SYNTH-0000000001',
            line4: 'Assistance: Example',
            sections: [
              { label: LABELS[0] as string, rows: units },
              { label: LABELS[1] as string, rows: people },
            ],
          };
          const a = parseFinalResults(buildResponseWorkbook(base).bytes);
          const b = parseFinalResults(
            buildResponseWorkbook({ ...base, headers: perm.map((i) => HEADERS[i] as string) }).bytes,
          );
          expect(b.draft).toEqual(a.draft);
          // Same issues apart from the column letters they point at.
          const strip = (xs: typeof a.issues) => xs.map((i) => `${i.code}|${i.severity}|${i.rowRef ?? ''}`).sort();
          expect(strip(b.issues)).toEqual(strip(a.issues));
        },
      ),
      { numRuns: 150 },
    );
  });
});
