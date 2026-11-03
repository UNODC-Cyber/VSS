import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { exportInvestc } from '../../../src/main/formats/investc/export.ts';
import { normalizeUnitName, parseInvestc } from '../../../src/main/formats/investc/index.ts';
import { validatePackageStructure } from '../../../tools/ooxml-validate/structural.ts';
import { semanticPeople, semanticUnits } from './export-helpers.ts';
import { fixtureBytes, TEMPLATE } from './helpers.ts';

describe('property: random subsets round-trip', () => {
  for (const id of ['req-001-basic', 'req-003-thai-script', 'req-005-shifted-layout']) {
    it(`${id}: any subset of people, either mode`, () => {
      const source = fixtureBytes(`requests/${id}.xlsx`);
      const parsed = parseInvestc(source);
      fc.assert(
        fc.property(
          fc.subarray(parsed.people),
          fc.constantFrom('regenerate' as const, 'filter-original' as const),
          (people, mode) => {
            const out = exportInvestc({ mode, template: TEMPLATE(), source, units: parsed.units, people });
            const again = parseInvestc(out.bytes);
            const used = new Set(people.map((p) => normalizeUnitName(p.unitName)));
            const units = parsed.units.filter((u) => used.has(normalizeUnitName(u.name)));
            expect(again.issues).toEqual([]);
            expect(semanticPeople(again.people)).toEqual(semanticPeople(people));
            expect(semanticUnits(again.units)).toEqual(semanticUnits(units));
            expect(out.stats).toEqual({ units: units.length, people: people.length });
            expect(validatePackageStructure(out.bytes)).toEqual([]);
          },
        ),
        { numRuns: 40 },
      );
    });
  }
});
