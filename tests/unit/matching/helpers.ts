// Synthetic test builders. All names are invented.
import type {
  ObservedPerson,
  Person,
  RawDate,
  RequestItem,
  ResponseRow,
  ResponseSection,
} from '../../../src/shared/domain/types';
import { buildNameKey, personNameFromRequest, splitDcName } from '../../../src/shared/names';

export const NOW = '2026-11-03T00:00:00.000Z';
export const now = (): string => NOW;

export function rawDate(iso: string | null, ambiguousDayMonth = false): RawDate {
  return { kind: iso ? 'text' : 'empty', value: iso ?? '', parsed: iso, ambiguousDayMonth };
}

export function observed(over: Partial<ObservedPerson> & { surname: string; name1: string }): ObservedPerson {
  return {
    rowRef: 'Data!A20',
    unitName: 'Synthetic Unit Alpha',
    isHeadOfUnit: false,
    name2: '',
    name3: '',
    name4: '',
    passport: '',
    nationalId: '',
    titleRank: '',
    fatherName: '',
    motherName: '',
    dob: rawDate('1990-03-07'),
    pobCity: '',
    pobState: '',
    pobCountry: 'ATLANTIS',
    nationality: 'ATLANTIS',
    searchCountry: 'ATLANTIS',
    sex: 'M',
    ...over,
  };
}

export function item(
  id: string,
  o: ObservedPerson,
  unitId: string | null = 'UNIT-A',
  requestId = 'REQ-1',
): RequestItem {
  return {
    id,
    requestId,
    observed: o,
    nameKey: buildNameKey(personNameFromRequest(o.surname, o.name1, o.name2, o.name3, o.name4)),
    personId: null,
    linkState: 'unlinked',
    unitId,
    issues: [],
    prior: null,
    exportDecision: 'include',
    exportReason: '',
  };
}

export function row(
  id: string,
  nameRaw: string,
  dob: string | null,
  over: { pobCountry?: string | null; unitName?: string; section?: ResponseSection; ambiguous?: boolean } = {},
): ResponseRow {
  const name = splitDcName(nameRaw);
  return {
    id,
    responseId: 'RESP-1',
    rowRef: 'Final_Results!B10',
    section: over.section ?? 'approved-individual',
    disp: 'Approved',
    nameRaw,
    name,
    nameKey: buildNameKey(name),
    dob: rawDate(dob, over.ambiguous ?? false),
    pob: { city: null, state: null, country: over.pobCountry === undefined ? 'ATLANTIS' : over.pobCountry },
    unitType: 'Police',
    unitName: over.unitName ?? 'Synthetic Unit Alpha',
    certDate: rawDate('2026-10-01'),
    expires: rawDate('2027-10-01'),
    match: { candidates: [], decision: 'none', chosen: null, decidedBy: null, decidedAt: null },
  };
}

export function person(
  id: string,
  surname: string,
  given: string[],
  dob: string | null,
  over: Partial<Person> = {},
): Person {
  const canonical = personNameFromRequest(surname, ...(given as [string?, string?, string?, string?]));
  return {
    id,
    createdAt: NOW,
    updatedAt: NOW,
    canonical,
    aliases: [],
    dob,
    dobPrecision: dob ? 'exact' : 'unknown',
    sex: 'M',
    pob: { city: null, state: null, country: 'ATLANTIS' },
    nationality: 'ATLANTIS',
    identifiers: [],
    state: 'active',
    mergedInto: null,
    notes: '',
    ...over,
  };
}
