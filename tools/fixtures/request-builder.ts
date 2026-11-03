/** Writes a synthetic INVESTc request workbook from a fixture spec (fixtures only). */
import { isoToSerial } from '../../src/main/formats/ooxml/dates.ts';
import { UNIT_FIELDS } from '../../src/main/formats/investc/layout.ts';
import { buildInvestcWorkbook, type BuiltInvestcWorkbook, type CellValue, type RowCells } from './investc-workbook.ts';
import type { PersonSpec, RequestSpec, UnitSpec } from './model.ts';

const UNIT_COLS = 'ABCDEFGHIJKLM';

function unitCells(u: UnitSpec): RowCells {
  const cells: RowCells = {};
  const values: Record<string, string | undefined> = {
    name: u.name,
    unitIdNo: u.unitIdNo,
    type: u.type,
    alias: u.alias,
    location: u.location,
    description: u.description,
    englishDescription: u.englishDescription,
    branchName: u.branchName,
    branchDescription: u.branchDescription,
    parentOrg: u.parentOrg,
    subordinateOrg: u.subordinateOrg,
    orgLevel: u.orgLevel,
    country: u.country,
  };
  UNIT_FIELDS.forEach((f, i) => {
    const v = values[f];
    if (v !== undefined && v !== '') cells[UNIT_COLS[i] as string] = { t: 's', v };
  });
  return cells;
}

function personCells(p: PersonSpec): RowCells {
  const cells: RowCells = {};
  const s = (col: string, v: string | undefined): void => {
    if (v !== undefined && v !== '') cells[col] = { t: 's', v };
  };
  s('A', p.unit);
  if (p.isHead !== null) cells['B'] = { t: 'b', v: p.isHead };
  s('C', p.surname);
  p.names.slice(0, 4).forEach((n, i) => s('DEFG'[i] as string, n));
  s('H', p.passport);
  s('I', p.nationalId);
  s('J', p.titleRank);
  s('K', p.father);
  s('L', p.mother);
  if (p.dob.kind === 'serial') {
    const serial = isoToSerial(p.dob.iso);
    if (serial === null) throw new Error(`bad DOB ${p.dob.iso}`);
    cells['M'] = { t: 'n', v: serial } satisfies CellValue;
  } else if (p.dob.kind === 'text') {
    cells['M'] = { t: 's', v: p.dob.text };
  }
  s('N', p.pobCity);
  s('O', p.pobState);
  s('P', p.pobCountry);
  s('Q', p.nationality);
  s('R', p.searchCountry);
  s('S', p.sex);
  return cells;
}

export type { BuiltInvestcWorkbook as BuiltWorkbook } from './investc-workbook.ts';

/** Writes the request workbook of a spec with the from-scratch generator (no third-party template involved). */
export function buildRequestWorkbook(spec: RequestSpec): BuiltInvestcWorkbook {
  return buildInvestcWorkbook({
    unitRows: spec.unitRows.map((u) => (u ? unitCells(u) : null)),
    people: spec.people.map(personCells),
    ...(spec.versionCells ? { versionCells: spec.versionCells } : {}),
  });
}
