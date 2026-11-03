/**
 * Golden tests: every fixture workbook is parsed and compared with its committed *.expected.json. The expected files
 * are written by tools/fixtures/generate.ts from the fixture specs, not by the parsers.
 */
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ObservedPerson, ObservedUnit } from '../../src/shared/domain/types.ts';
import { parseFinalResults } from '../../src/main/formats/dc/index.ts';
import { parseInvestc, validateRequest } from '../../src/main/formats/investc/index.ts';
import { FIXTURE_NOW_DATE, canonicalJson, sha256 } from '../../tools/fixtures/generate.ts';
import { fixtureBytes, fixtureJson, project, type IssueLike } from '../unit/formats/helpers.ts';

const listIds = (dir: string, prefix: string): string[] =>
  readdirSync(new URL(`../../fixtures/${dir}/`, import.meta.url))
    .filter((f) => f.startsWith(prefix) && f.endsWith('.xlsx'))
    .map((f) => f.replace(/\.xlsx$/, ''))
    .sort();

interface RequestExpected {
  id: string;
  templateVersion: string;
  instructionsVersion: string;
  parseIssues: IssueLike[];
  validationIssues: IssueLike[];
  units?: ObservedUnit[];
  people?: ObservedPerson[];
  summary?: {
    units: number;
    people: number;
    sha256: string;
    firstUnit: ObservedUnit;
    firstPerson: ObservedPerson;
    lastPerson: ObservedPerson;
  };
}

describe('request fixtures', () => {
  const ids = listIds('requests', 'req-');
  it('all eight request fixtures exist', () => {
    expect(ids).toEqual([
      'req-001-basic',
      'req-002-malay-particles',
      'req-003-thai-script',
      'req-004-errors',
      'req-005-shifted-layout',
      'req-006-large',
      'req-007-text-dates',
      'req-008-unknown-version',
    ]);
  });
  for (const id of ids) {
    it(`${id} parses to its golden`, () => {
      const expected = fixtureJson<RequestExpected>(`requests/${id}.expected.json`);
      const parsed = parseInvestc(fixtureBytes(`requests/${id}.xlsx`));
      expect(parsed.templateVersion).toBe(expected.templateVersion);
      expect(parsed.instructionsVersion).toBe(expected.instructionsVersion);
      expect(project(parsed.issues)).toEqual(project(expected.parseIssues));
      if (expected.summary) {
        const s = expected.summary;
        expect(parsed.units).toHaveLength(s.units);
        expect(parsed.people).toHaveLength(s.people);
        expect(parsed.units[0]).toEqual(s.firstUnit);
        expect(parsed.people[0]).toEqual(s.firstPerson);
        expect(parsed.people[parsed.people.length - 1]).toEqual(s.lastPerson);
        expect(sha256(canonicalJson({ units: parsed.units, people: parsed.people }, 0))).toBe(s.sha256);
      } else {
        expect(parsed.units).toEqual(expected.units);
        expect(parsed.people).toEqual(expected.people);
      }
      const validation = validateRequest(parsed, null, FIXTURE_NOW_DATE);
      expect(project(validation)).toEqual(project(expected.validationIssues));
    });
  }

  it('req-006-large (50 units, 1200 people) parses and validates in under 2 seconds', () => {
    const bytes = fixtureBytes('requests/req-006-large.xlsx');
    const t0 = performance.now();
    const parsed = parseInvestc(bytes);
    const issues = validateRequest(parsed, null, FIXTURE_NOW_DATE);
    const ms = performance.now() - t0;
    expect(parsed.units).toHaveLength(50);
    expect(parsed.people).toHaveLength(1200);
    expect(issues).toEqual([]);
    expect(ms).toBeLessThan(2000);
  });
});

interface ResponseExpected {
  batchId: string;
  post: string;
  resultsAsOf: string;
  assistanceLine: string;
  blocked: boolean;
  unknownSections: string[];
  rows: Record<string, unknown>[];
  issues: IssueLike[];
}

describe('response fixtures', () => {
  const ids = listIds('responses', 'resp-');
  it('all five response fixtures exist', () => {
    expect(ids).toEqual([
      'resp-001-all-approved',
      'resp-002-reformatted',
      'resp-003-nonapproved',
      'resp-004-thai',
      'resp-005-unknown-section',
    ]);
  });
  for (const id of ids) {
    it(`${id} parses to its golden`, () => {
      const expected = fixtureJson<ResponseExpected>(`responses/${id}.expected.json`);
      const r = parseFinalResults(fixtureBytes(`responses/${id}.xlsx`));
      expect(r.draft.batchId).toBe(expected.batchId);
      expect(r.draft.post).toBe(expected.post);
      expect(r.draft.resultsAsOf).toBe(expected.resultsAsOf);
      expect(r.draft.assistanceLine).toBe(expected.assistanceLine);
      expect(r.blocked).toBe(expected.blocked);
      expect(r.unknownSections).toEqual(expected.unknownSections);
      expect(project(r.issues)).toEqual(project(expected.issues));
      const rows = r.draft.rows.map((x) => ({
        rowRef: x.rowRef,
        section: x.section,
        disp: x.disp,
        nameRaw: x.nameRaw,
        surname: x.name.surname,
        given: x.name.given,
        unknownCommander: x.unknownCommander,
        script: x.name.script,
        dob: x.dob,
        pob: x.pob,
        unitType: x.unitType,
        unitName: x.unitName,
        certDate: x.certDate,
        expires: x.expires,
      }));
      expect(canonicalJson(rows)).toBe(canonicalJson(expected.rows));
    });
  }

  it('resp-002 carries the DC reformatting quirks the matcher will have to absorb', () => {
    const r = parseFinalResults(fixtureBytes('responses/resp-002-reformatted.xlsx'));
    const ind = r.draft.rows.filter((x) => x.section === 'approved-individual');
    expect(ind.every((x) => x.nameRaw.endsWith('   '))).toBe(true); // trailing spaces kept verbatim
    expect(ind.every((x) => x.name.surname === x.name.surname.trim())).toBe(true);
    expect(ind.some((x) => x.pob.city === null && x.pob.state === null && x.pob.country !== null)).toBe(true);
    expect(ind.some((x) => x.pob.country === null)).toBe(true);
    const unit = r.draft.rows.find((x) => x.section === 'approved-unit');
    expect(unit).toMatchObject({ unknownCommander: true, name: { surname: 'UNKNOWN', given: [] } });
    expect(unit?.expires.parsed).toBe('2027-01-18'); // 90 days after 2026-10-20: a short unit expiry
    expect(ind[0]?.expires.parsed).toBe('2027-10-20'); // individuals: certificate + 365 days
  });

  it('resp-004 keeps Thai-script names as written', () => {
    const r = parseFinalResults(fixtureBytes('responses/resp-004-thai.xlsx'));
    const scripts = new Set(r.draft.rows.map((x) => x.name.script));
    expect(scripts.has('Thai')).toBe(true);
    expect(scripts.has('Mixed') || scripts.has('Latn')).toBe(true);
  });
});
