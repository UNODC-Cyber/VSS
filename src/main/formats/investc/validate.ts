import type { ObservedPerson, ObservedUnit } from '../../../shared/domain/types.ts';
import { ageOn, todayIso } from '../ooxml/dates.ts';
import { coreKey, normalizeUnitName, startsWithHonorific } from './names.ts';
import type { KnownPerson, ParsedInvestc, RequestLookups, RuleIssue } from './types.ts';

function issue(
  rule: string,
  code: RuleIssue['code'],
  severity: RuleIssue['severity'],
  rowRef: string | null,
  field: string | null,
  message: string,
): RuleIssue {
  return { rule, code, severity, rowRef, field, message };
}

const empty = (s: string): boolean => s.trim() === '';
const len = (s: string): number => [...s].length;

/** Case-insensitive membership with the canonical spelling: exact, case-only difference, or absent. */
class Vocabulary {
  private readonly exact: Set<string>;
  private readonly folded = new Map<string, string>();
  constructor(values: readonly string[]) {
    this.exact = new Set(values);
    for (const v of values) {
      const k = v.trim().toLowerCase();
      if (!this.folded.has(k)) this.folded.set(k, v);
    }
  }
  check(value: string): 'exact' | 'case' | 'missing' {
    const v = value.trim();
    if (this.exact.has(v)) return 'exact';
    return this.folded.has(v.toLowerCase()) ? 'case' : 'missing';
  }
}

const UNIT_LABEL: Record<string, string> = {
  name: 'Unit Name',
  type: 'Unit Type',
  country: 'Unit Country',
};

/**
 * Value rules R-06..R-15 over a parsed request. `lookups` carries the database expectations for R-15; pass null
 * when no database is available. `now` fixes "today" (UTC date) for the DOB rules. Never throws.
 */
export function validateRequest(parsed: ParsedInvestc, lookups: RequestLookups | null, now: Date): RuleIssue[] {
  const out: RuleIssue[] = [];
  const ref = parsed.reference;
  const today = todayIso(now);
  const unitTypes = new Vocabulary(ref.unitTypes);
  const genders = new Vocabulary(ref.genders);
  const countriesPob = new Vocabulary(ref.countriesPob);
  const countriesUnit = new Vocabulary(ref.countriesUnit);

  // ---- Units -------------------------------------------------------------------------------------------------
  const declared = new Map<string, ObservedUnit>();
  const unitUse = new Map<string, number>();
  for (const u of parsed.units) {
    // R-06
    if (empty(u.name)) {
      out.push(issue('R-06', 'REQUIRED_MISSING', 'error', u.rowRef, 'name', 'Unit Name is required.'));
    }
    if (empty(u.type)) out.push(issue('R-06', 'REQUIRED_MISSING', 'error', u.rowRef, 'type', 'Unit Type is required.'));
    if (empty(u.country)) {
      out.push(issue('R-06', 'REQUIRED_MISSING', 'error', u.rowRef, 'country', 'Unit Country is required.'));
    }
    // R-07
    if (!empty(u.type)) {
      const r = unitTypes.check(u.type);
      if (r === 'missing') {
        out.push(
          issue('R-07', 'UNIT_TYPE_INVALID', 'error', u.rowRef, 'type', `Unit Type "${u.type}" is not in the list.`),
        );
      } else if (r === 'case') {
        out.push(
          issue(
            'R-07',
            'UNIT_TYPE_INVALID',
            'warning',
            u.rowRef,
            'type',
            `Unit Type "${u.type}" differs from the list only in letter case.`,
          ),
        );
      }
    }
    if (!empty(u.country))
      countryCheck(out, countriesUnit, u.rowRef, 'country', u.country, UNIT_LABEL['country'] as string);
    // R-09 duplicates
    if (!empty(u.name)) {
      const key = normalizeUnitName(u.name);
      if (declared.has(key)) {
        out.push(
          issue('R-09', 'UNIT_DUPLICATE', 'error', u.rowRef, 'name', `Unit "${key}" is declared more than once.`),
        );
      } else {
        declared.set(key, u);
        unitUse.set(key, 0);
      }
    }
    // R-12
    for (const [field, limit] of Object.entries(ref.limits.unit)) {
      const v = (u as unknown as Record<string, string>)[field];
      if (typeof v === 'string' && len(v) > limit) {
        out.push(
          issue(
            'R-12',
            'CHAR_LIMIT',
            'error',
            u.rowRef,
            field,
            `${field} has ${len(v)} characters; the limit is ${limit}.`,
          ),
        );
      }
    }
  }

  // ---- Individuals -------------------------------------------------------------------------------------------
  const heads = new Map<string, number>();
  const seen = new Map<string, string>();
  for (const p of parsed.people) {
    const rowRef = p.rowRef;
    // R-06
    const req = (cond: boolean, field: string, label: string, detail = 'is required'): void => {
      if (cond) out.push(issue('R-06', 'REQUIRED_MISSING', 'error', rowRef, field, `${label} ${detail}.`));
    };
    req(empty(p.unitName), 'unitName', 'Unit Name');
    req(p.isHeadOfUnit === null, 'isHeadOfUnit', 'IsHeadOfUnit', 'is required and must be TRUE or FALSE');
    req(empty(p.surname), 'surname', 'Surname');
    req(p.dob.kind === 'empty', 'dob', 'DOB');
    req(empty(p.pobCountry), 'pobCountry', 'Place of birth Country');
    req(empty(p.searchCountry), 'searchCountry', 'Search Country');
    req(empty(p.sex), 'sex', 'Sex');

    // R-07
    if (!empty(p.sex)) {
      const r = genders.check(p.sex);
      if (r === 'missing') {
        out.push(issue('R-07', 'SEX_INVALID', 'error', rowRef, 'sex', `Sex "${p.sex}" must be M or F.`));
      } else if (r === 'case') {
        out.push(
          issue(
            'R-07',
            'SEX_INVALID',
            'warning',
            rowRef,
            'sex',
            `Sex "${p.sex}" is accepted but should be upper case.`,
          ),
        );
      }
    }
    if (!empty(p.pobCountry))
      countryCheck(out, countriesPob, rowRef, 'pobCountry', p.pobCountry, 'Place of birth Country');
    if (!empty(p.nationality)) countryCheck(out, countriesPob, rowRef, 'nationality', p.nationality, 'Nationality');
    if (!empty(p.searchCountry))
      countryCheck(out, countriesUnit, rowRef, 'searchCountry', p.searchCountry, 'Search Country');

    // R-08
    const dob = p.dob;
    if (dob.kind !== 'empty') {
      if (dob.parsed === null) {
        out.push(issue('R-08', 'DOB_INVALID', 'error', rowRef, 'dob', `DOB "${dob.value}" is not a valid date.`));
      } else {
        if (dob.kind === 'text') {
          out.push(
            issue(
              'R-08',
              'DOB_TEXT',
              'info',
              rowRef,
              'dob',
              `DOB is stored as text ("${dob.value}") and was read as ${dob.parsed}.`,
            ),
          );
        }
        if (dob.ambiguousDayMonth) {
          out.push(
            issue(
              'R-08',
              'DOB_AMBIGUOUS_DM',
              'warning',
              rowRef,
              'dob',
              `DOB "${dob.value}" can be read as day/month or month/day; read as month/day (${dob.parsed}).`,
            ),
          );
        }
        if (dob.parsed > today) {
          out.push(issue('R-08', 'DOB_FUTURE', 'error', rowRef, 'dob', `DOB ${dob.parsed} is in the future.`));
        } else if (ageOn(dob.parsed, today) < 18) {
          out.push(
            issue(
              'R-08',
              'DOB_UNDER_18',
              'error',
              rowRef,
              'dob',
              `DOB ${dob.parsed} makes the person younger than 18.`,
            ),
          );
        }
      }
    }

    // R-09 declared unit
    if (!empty(p.unitName)) {
      const key = normalizeUnitName(p.unitName);
      if (!declared.has(key)) {
        out.push(
          issue(
            'R-09',
            'UNIT_NOT_DECLARED',
            'error',
            rowRef,
            'unitName',
            `Unit "${key}" is not declared in the Units section.`,
          ),
        );
      } else {
        unitUse.set(key, (unitUse.get(key) ?? 0) + 1);
        if (p.isHeadOfUnit === true) heads.set(key, (heads.get(key) ?? 0) + 1);
      }
    }

    // R-11
    if ((!empty(p.passport) || !empty(p.nationalId)) && empty(p.nationality)) {
      out.push(
        issue(
          'R-11',
          'ID_WITHOUT_NATIONALITY',
          'error',
          rowRef,
          'nationality',
          'A passport or national ID number needs a Nationality (country of issue).',
        ),
      );
    }

    // R-12
    for (const [field, limit] of Object.entries(ref.limits.person)) {
      const v = (p as unknown as Record<string, string>)[field];
      if (typeof v === 'string' && len(v) > limit) {
        out.push(
          issue(
            'R-12',
            'CHAR_LIMIT',
            'error',
            rowRef,
            field,
            `${field} has ${len(v)} characters; the limit is ${limit}.`,
          ),
        );
      }
    }

    // R-13
    const key = coreKey(p.surname, p.name1, p.name2, p.name3, p.name4);
    if (key !== '' && dob.parsed !== null) {
      const full = `${key}|${dob.parsed}`;
      const first = seen.get(full);
      if (first !== undefined) {
        out.push(
          issue('R-13', 'DUPLICATE_ROW', 'error', rowRef, 'surname', `Same name and DOB as the row at ${first}.`),
        );
      } else {
        seen.set(full, rowRef);
      }
    }

    // R-14
    for (const field of ['surname', 'name1', 'name2', 'name3', 'name4'] as const) {
      const v = p[field];
      if (!empty(v) && startsWithHonorific(v)) {
        out.push(
          issue(
            'R-14',
            'NAME_HAS_HONORIFIC',
            'warning',
            rowRef,
            field,
            `${field} starts with an honorific or rank ("${v.trim()}").`,
          ),
        );
      }
    }
  }

  // R-09 unused, R-10 heads
  for (const [key, u] of declared) {
    const used = unitUse.get(key) ?? 0;
    if (used === 0) {
      out.push(issue('R-09', 'UNIT_UNUSED', 'warning', u.rowRef, 'name', `Unit "${key}" has no individuals.`));
      continue;
    }
    const h = heads.get(key) ?? 0;
    if (h === 0) {
      out.push(
        issue(
          'R-10',
          'HEAD_OF_UNIT_NONE',
          'warning',
          u.rowRef,
          'name',
          `Unit "${key}" has no individual marked as head of unit.`,
        ),
      );
    } else if (h > 1) {
      out.push(
        issue(
          'R-10',
          'HEAD_OF_UNIT_MULTIPLE',
          'error',
          u.rowRef,
          'name',
          `Unit "${key}" has ${h} individuals marked as head of unit.`,
        ),
      );
    }
  }

  // R-15
  if (lookups) out.push(...databaseExpectations(parsed, lookups));
  return out;
}

function countryCheck(
  out: RuleIssue[],
  vocab: Vocabulary,
  rowRef: string,
  field: string,
  value: string,
  label: string,
): void {
  const r = vocab.check(value);
  if (r === 'missing') {
    out.push(
      issue('R-07', 'COUNTRY_NOT_IN_LIST', 'error', rowRef, field, `${label} "${value}" is not in the country list.`),
    );
  } else if (r === 'case') {
    out.push(
      issue(
        'R-07',
        'COUNTRY_NOT_IN_LIST',
        'warning',
        rowRef,
        field,
        `${label} "${value}" differs from the list only in letter case.`,
      ),
    );
  }
}

function databaseExpectations(parsed: ParsedInvestc, lookups: RequestLookups): RuleIssue[] {
  const out: RuleIssue[] = [];
  const reported = new Set<string>();
  for (const u of parsed.units) {
    if (empty(u.name)) continue;
    const key = normalizeUnitName(u.name);
    if (reported.has(key)) continue;
    reported.add(key);
    if (!lookups.isKnownUnit(key)) {
      out.push(
        issue(
          'R-15',
          'UNEXPECTED_UNIT',
          'info',
          u.rowRef,
          'name',
          `Unit "${key}" has not appeared in earlier requests.`,
        ),
      );
    }
  }
  for (const p of parsed.people) {
    const key = coreKey(p.surname, p.name1, p.name2, p.name3, p.name4);
    const known = lookups.findKnownPerson({
      rowRef: p.rowRef,
      coreKey: key,
      dobIso: p.dob.parsed,
      passport: p.passport.trim(),
      nationalId: p.nationalId.trim(),
    });
    if (!known) continue;
    comparePerson(out, p, key, known);
  }
  return out;
}

function comparePerson(out: RuleIssue[], p: ObservedPerson, key: string, known: KnownPerson): void {
  const ref = p.rowRef;
  if (key !== '' && known.coreKey !== '' && key !== known.coreKey) {
    out.push(
      issue(
        'R-15',
        'PERSON_KNOWN_NAME_MISMATCH',
        'warning',
        ref,
        'surname',
        'The name differs from the one on record for this person.',
      ),
    );
  }
  if (p.dob.parsed !== null && known.dobIso !== null && p.dob.parsed !== known.dobIso) {
    out.push(
      issue(
        'R-15',
        'PERSON_KNOWN_DOB_MISMATCH',
        'warning',
        ref,
        'dob',
        'The DOB differs from the one on record for this person.',
      ),
    );
  }
  const pp = p.passport.trim();
  const nn = p.nationalId.trim();
  if (pp !== '' && known.passports.length > 0 && !known.passports.includes(pp)) {
    out.push(
      issue(
        'R-15',
        'PERSON_KNOWN_ID_MISMATCH',
        'warning',
        ref,
        'passport',
        'The passport number differs from the ones on record for this person.',
      ),
    );
  }
  if (nn !== '' && known.nationalIds.length > 0 && !known.nationalIds.includes(nn)) {
    out.push(
      issue(
        'R-15',
        'PERSON_KNOWN_ID_MISMATCH',
        'warning',
        ref,
        'nationalId',
        'The national ID number differs from the ones on record for this person.',
      ),
    );
  }
  if (known.nonApproved) {
    out.push(
      issue(
        'R-15',
        'PERSON_NON_APPROVED',
        'warning',
        ref,
        null,
        'This person is recorded as non-approved; excluded from export by default policy.',
      ),
    );
  }
}
