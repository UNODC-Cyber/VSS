import type { Sheet } from '../ooxml/sheet.ts';
import {
  BUNDLED_COUNTRIES_POB,
  BUNDLED_COUNTRIES_UNIT,
  BUNDLED_GENDERS,
  BUNDLED_ID_TYPES,
  BUNDLED_LIMITS,
  BUNDLED_UNIT_TYPES,
} from './bundled-reference.ts';
import { DEFAULT_LIMITS, LIMIT_LABELS } from './layout.ts';

export interface Limits {
  unit: Record<string, number>;
  person: Record<string, number>;
}

export interface ReferenceData {
  unitTypes: string[];
  genders: string[];
  idTypes: string[];
  /** Column E: countries valid for place of birth and nationality. */
  countriesPob: string[];
  /** Column G: countries valid for unit country and search country. */
  countriesUnit: string[];
  limits: Limits;
  /** Where each part came from: the workbook's own sheets or the bundled copy. */
  source: { lists: 'file' | 'bundled'; limits: 'file' | 'bundled' };
}

function limitsFromBundled(table: Readonly<Record<string, number>>): Limits {
  const out: Limits = { unit: { ...DEFAULT_LIMITS.unit }, person: { ...DEFAULT_LIMITS.person } };
  for (const [label, n] of Object.entries(table)) {
    const m = LIMIT_LABELS[label];
    if (m) out[m.scope][m.field] = n;
  }
  return out;
}

export function bundledReference(): ReferenceData {
  return {
    unitTypes: [...BUNDLED_UNIT_TYPES],
    genders: [...BUNDLED_GENDERS],
    idTypes: [...BUNDLED_ID_TYPES],
    countriesPob: [...BUNDLED_COUNTRIES_POB],
    countriesUnit: [...BUNDLED_COUNTRIES_UNIT],
    limits: limitsFromBundled(BUNDLED_LIMITS),
    source: { lists: 'bundled', limits: 'bundled' },
  };
}

function column(sheet: Sheet, header: string): string[] | null {
  let col = 0;
  for (const c of sheet.rowCells(1)) {
    if (c.text.trim() === header) {
      col = c.col;
      break;
    }
  }
  if (!col) return null;
  const out: string[] = [];
  for (let r = 2; r <= sheet.maxRow; r++) {
    const t = sheet.text(r, col).trim();
    if (t !== '') out.push(t);
  }
  return out;
}

/**
 * Reference data from the workbook's own sheets when usable, otherwise the bundled copy. Each list falls back
 * independently, so a damaged column never leaves a rule without data.
 */
export function readReferenceData(reference: Sheet | null, instructions: Sheet | null): ReferenceData {
  const base = bundledReference();
  let listsFromFile = false;
  if (reference) {
    const unitTypes = column(reference, 'Unit Type');
    const genders = column(reference, 'Gender');
    const idTypes = column(reference, 'ID Type');
    const pob = column(reference, 'Country');
    const unit = column(reference, 'UnitCountry');
    if (unitTypes?.length) {
      base.unitTypes = unitTypes;
      listsFromFile = true;
    }
    if (genders?.length) {
      base.genders = genders;
      listsFromFile = true;
    }
    if (idTypes?.length) {
      base.idTypes = idTypes;
      listsFromFile = true;
    }
    if (pob?.length) {
      base.countriesPob = pob;
      listsFromFile = true;
    }
    if (unit?.length) {
      base.countriesUnit = unit;
      listsFromFile = true;
    }
  }
  base.source.lists = listsFromFile ? 'file' : 'bundled';
  if (instructions) {
    let found = 0;
    for (let r = 1; r <= instructions.maxRow; r++) {
      const label = instructions.text(r, 2).trim();
      const m = LIMIT_LABELS[label];
      const cell = instructions.cell(r, 3);
      if (m && cell?.kind === 'number' && cell.num !== undefined && cell.num > 0) {
        base.limits[m.scope][m.field] = cell.num;
        found += 1;
      }
    }
    if (found > 0) base.source.limits = 'file';
  }
  return base;
}
