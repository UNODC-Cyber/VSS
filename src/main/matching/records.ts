/** Builders that turn domain objects into MatchRecords. */
import type {
  Identifier,
  ObservedPerson,
  Person,
  PersonName,
  RequestItem,
  ResponseRow,
  Sex,
  Ulid,
} from '../../shared/domain/types';
import { buildNameKey, surnameCoreTokens } from '../../shared/names/key';
import { foldCountry, foldIdentifier, foldUnitName, tokenize } from '../../shared/names/normalize';
import { personNameFromRequest } from '../../shared/names/personName';
import { dobFromRaw, isPlaceholderDob } from './dob';
import type { IdentifierRef, MatchSubject, MatchTarget, NameVariant } from './types';

/** Place-of-birth fold (city / state): tokens folded like names and joined without spaces, '' when unknown. */
export function foldPlace(value: string | null | undefined): string {
  return value ? tokenize(value).join('') : '';
}

/** Father's-name tokens (folded); [] when unknown. */
export function foldFather(value: string | null | undefined): string[] {
  return value ? tokenize(value) : [];
}

export function nameVariant(name: PersonName): NameVariant {
  const surname = surnameCoreTokens(name);
  return { key: buildNameKey(name), surname: surname.length > 0 ? surname : null };
}

export function parseSex(s: string | null | undefined): Sex | null {
  const v = (s ?? '').trim().toUpperCase();
  return v === 'M' || v === 'F' ? v : null;
}

export function observedName(o: ObservedPerson): PersonName {
  return personNameFromRequest(o.surname, o.name1, o.name2, o.name3, o.name4);
}

export function observedIdentifiers(o: ObservedPerson): IdentifierRef[] {
  const issuing = foldCountry(o.nationality) || null;
  const out: IdentifierRef[] = [];
  const p = foldIdentifier(o.passport);
  if (p !== '') out.push({ type: 'passport', valueFolded: p, issuingCountry: issuing });
  const n = foldIdentifier(o.nationalId);
  if (n !== '') out.push({ type: 'national-id', valueFolded: n, issuingCountry: issuing });
  return out;
}

function personIdentifiers(ids: readonly Identifier[]): IdentifierRef[] {
  return ids
    .map((i) => ({
      type: i.type,
      // Re-fold defensively so junk values stored by older code never create ID evidence.
      valueFolded: foldIdentifier(i.valueFolded || i.value),
      issuingCountry: foldCountry(i.issuingCountry) || null,
    }))
    .filter((i) => i.valueFolded !== '');
}

/** Subject from a raw request observation. `id` is the request item id. */
export function subjectFromObserved(
  id: Ulid,
  o: ObservedPerson,
  extra: { unitId?: Ulid | null; personId?: Ulid | null } = {},
): MatchSubject {
  const name = observedName(o);
  return {
    id,
    names: [nameVariant(name)],
    dob: dobFromRaw(o.dob),
    sex: parseSex(o.sex),
    pobCountry: foldCountry(o.pobCountry),
    pobCity: foldPlace(o.pobCity),
    pobState: foldPlace(o.pobState),
    fatherNames: o.fatherName.trim() === '' ? [] : [foldFather(o.fatherName)],
    unitIds: extra.unitId ? [extra.unitId] : [],
    unitNames: o.unitName.trim() === '' ? [] : [foldUnitName(o.unitName)],
    identifiers: observedIdentifiers(o),
    personId: extra.personId ?? null,
  };
}

export function subjectFromRequestItem(item: RequestItem): MatchSubject {
  return subjectFromObserved(item.id, item.observed, { unitId: item.unitId, personId: item.personId });
}

export function targetFromRequestItem(item: RequestItem): MatchTarget {
  return { ...subjectFromRequestItem(item), kind: 'request-item' };
}

/** Response rows carry no IDs and no sex; unit is known by name only. */
export function subjectFromResponseRow(row: ResponseRow): MatchSubject {
  // The key is rebuilt from row.name (not row.nameKey) so both sides always use the same normalisation config.
  return {
    id: row.id,
    names: [nameVariant(row.name)],
    dob: dobFromRaw(row.dob),
    sex: null,
    pobCountry: foldCountry(row.pob.country),
    pobCity: foldPlace(row.pob.city),
    pobState: foldPlace(row.pob.state),
    unitIds: [],
    unitNames: row.unitName.trim() === '' ? [] : [foldUnitName(row.unitName)],
    identifiers: [],
    personId: null,
  };
}

/** Person target. Units are not on Person; pass the units the person was vetted with if known. */
export function targetFromPerson(
  p: Person,
  units: { unitIds?: readonly Ulid[]; unitNames?: readonly string[]; fatherNames?: readonly string[] } = {},
): MatchTarget {
  return {
    id: p.id,
    kind: 'person',
    state: p.state,
    names: [p.canonical, ...p.aliases].map(nameVariant),
    dob: {
      date: p.dob,
      precision: p.dob === null ? 'unknown' : p.dobPrecision,
      placeholder: isPlaceholderDob(p.dob),
    },
    sex: p.sex,
    pobCountry: foldCountry(p.pob.country),
    pobCity: foldPlace(p.pob.city),
    pobState: foldPlace(p.pob.state),
    fatherNames: (units.fatherNames ?? []).map(foldFather).filter((t) => t.length > 0),
    unitIds: [...(units.unitIds ?? [])],
    unitNames: (units.unitNames ?? []).map(foldUnitName).filter((u) => u !== ''),
    identifiers: personIdentifiers(p.identifiers),
  };
}
