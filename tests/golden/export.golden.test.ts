/**
 * Golden round-trip tests of the INVESTc exporter over every synthetic request fixture (X-01..X-07), in both modes.
 */
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { exportInvestc as exportRaw, type ExportInput } from '../../src/main/formats/investc/export.ts';
import { parseInvestc, validateRequest } from '../../src/main/formats/investc/index.ts';
import { FIXTURE_NOW_DATE } from '../../tools/fixtures/generate.ts';
import { validatePackageStructure } from '../../tools/ooxml-validate/structural.ts';
import { changedParts, semanticPeople, semanticUnits } from '../unit/formats/export-helpers.ts';
import { fixtureBytes, TEMPLATE } from '../unit/formats/helpers.ts';

/** Every export gets the test-only generated template (the app passes the vault template). */
const exportInvestc = (input: ExportInput) => exportRaw({ template: TEMPLATE(), ...input });

const ids = readdirSync(new URL('../../fixtures/requests/', import.meta.url))
  .filter((f) => /^req-.*\.xlsx$/.test(f))
  .map((f) => f.replace(/\.xlsx$/, ''))
  .sort();

/** Fixtures with intentional errors: exported for no-throw only. */
const WITH_ERRORS = new Set(['req-004-errors']);
/** Fixtures already in the canonical X-04 layout with serial DOBs: the round trip is exact, row refs included. */
const EXACT = new Set(['req-001-basic', 'req-002-malay-particles', 'req-003-thai-script', 'req-006-large']);
const MODES = ['regenerate', 'filter-original'] as const;

describe('export round trip: parse(export(parse(f))) == parse(f)', () => {
  it('covers all eight request fixtures', () => {
    expect(ids).toHaveLength(8);
  });

  for (const id of ids) {
    for (const mode of MODES) {
      it(`${id} (${mode})`, () => {
        const source = fixtureBytes(`requests/${id}.xlsx`);
        const parsed = parseInvestc(source);
        const out = exportInvestc({ mode, source, units: parsed.units, people: parsed.people });
        const again = parseInvestc(out.bytes);
        expect(again.issues.filter((i) => i.severity === 'error')).toEqual([]);
        expect(validatePackageStructure(out.bytes)).toEqual([]);
        if (WITH_ERRORS.has(id)) {
          expect(again.people).toHaveLength(parsed.people.length);
          return;
        }
        expect(out.issues.filter((i) => i.severity !== 'info')).toEqual([]);
        expect(out.stats).toEqual({ units: parsed.units.length, people: parsed.people.length });
        expect(semanticUnits(again.units)).toEqual(semanticUnits(parsed.units));
        expect(semanticPeople(again.people)).toEqual(semanticPeople(parsed.people));
        if (EXACT.has(id) || (id === 'req-008-unknown-version' && mode === 'regenerate')) {
          expect(again.units).toEqual(parsed.units);
          expect(again.people).toEqual(parsed.people);
        }
        // X-01: the output validates without errors (DOB text in req-007 becomes serials).
        const v = validateRequest(again, null, FIXTURE_NOW_DATE);
        expect(v.filter((i) => i.severity === 'error')).toEqual([]);
        expect(v.filter((i) => i.code === 'DOB_TEXT')).toEqual([]);
      });
    }
  }

  it('req-004-errors keeps every row, reports what it could not normalise, and never throws', () => {
    const source = fixtureBytes('requests/req-004-errors.xlsx');
    const parsed = parseInvestc(source);
    for (const mode of MODES) {
      const out = exportInvestc({ mode, source, units: parsed.units, people: parsed.people });
      const codes = new Set(out.issues.map((i) => i.code));
      expect(codes).toContain('UNIT_DUPLICATE');
      expect(codes).toContain('UNIT_NOT_DECLARED');
      expect(codes).toContain('COUNTRY_NOT_IN_LIST');
      expect(codes).toContain('DOB_INVALID');
      expect(parseInvestc(out.bytes).people).toHaveLength(parsed.people.length);
    }
  });
});

describe('untouched parts are byte-identical', () => {
  for (const id of ids) {
    it(`${id}: regenerate differs from the blank template only in X-02 parts`, () => {
      const parsed = parseInvestc(fixtureBytes(`requests/${id}.xlsx`));
      const out = exportInvestc({ mode: 'regenerate', units: parsed.units, people: parsed.people });
      const allowed = ['docProps/app.xml', 'docProps/core.xml', 'xl/sharedStrings.xml', 'xl/worksheets/sheet2.xml'];
      for (const p of changedParts(TEMPLATE(), out.bytes)) expect(allowed).toContain(p);
    });
    it(`${id}: filter-original differs from the source only in X-03 parts`, () => {
      const source = fixtureBytes(`requests/${id}.xlsx`);
      const parsed = parseInvestc(source);
      const out = exportInvestc({ mode: 'filter-original', source, units: parsed.units, people: parsed.people });
      if (id === 'req-008-unknown-version') return; // falls back to regenerate (tested in the unit tests)
      const allowed = ['docProps/core.xml', 'xl/sharedStrings.xml', 'xl/worksheets/sheet2.xml'];
      for (const p of changedParts(source, out.bytes)) expect(allowed).toContain(p);
    });
  }
});

describe('determinism and speed', () => {
  it('same input gives the same bytes, in both modes', () => {
    const source = fixtureBytes('requests/req-003-thai-script.xlsx');
    const parsed = parseInvestc(source);
    for (const mode of MODES) {
      const input = { mode, source, units: parsed.units, people: parsed.people, now: FIXTURE_NOW_DATE };
      const a = exportInvestc(input).bytes;
      const b = exportInvestc({ ...input, units: [...parsed.units], people: [...parsed.people] }).bytes;
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    }
  });

  it('exports 1,200 people in under 3 seconds', () => {
    const source = fixtureBytes('requests/req-006-large.xlsx');
    const parsed = parseInvestc(source);
    expect(parsed.people).toHaveLength(1200);
    for (const mode of MODES) {
      const t0 = performance.now();
      const out = exportInvestc({ mode, source, units: parsed.units, people: parsed.people });
      const ms = performance.now() - t0;
      expect(out.stats.people).toBe(1200);
      expect(ms).toBeLessThan(3000);
    }
  });
});
