/** Fixed vocabulary of the INVESTc request workbook (docs/FILE-FORMATS.md). */
import type { ObservedPerson, ObservedUnit } from '../../../shared/domain/types.ts';

export const EXPECTED_SHEETS = ['Template Instructions', 'Data', 'Reference Data'] as const;
export const SHEET_INSTRUCTIONS = EXPECTED_SHEETS[0];
export const SHEET_DATA = EXPECTED_SHEETS[1];
export const SHEET_REFERENCE = EXPECTED_SHEETS[2];

/** Template versions this build knows (the C2 cell of the instructions sheet). */
export const KNOWN_TEMPLATE_VERSIONS: readonly string[] = ['1.11.0'];

export const MARKER_UNITS = 'UNITS';
export const MARKER_SEPARATOR = 'LEAVE A ROW BLANK';
export const MARKER_INDIVIDUALS = 'INDIVIDUALS';

export const UNIT_HEADERS = [
  '* Unit Name',
  'Unit ID #',
  '* Unit Type',
  'Unit Alias',
  'Unit Location',
  'Unit Description',
  'Unit English Description',
  'Branch Name',
  'Branch Description',
  'Parent Organization',
  'Subordinate Organization',
  'Organization/Federal Level',
  '* Unit Country',
] as const;

export const PERSON_HEADERS = [
  '* Unit Name',
  '* IsHeadOfUnit',
  '* Surname',
  'Name 1',
  'Name 2',
  'Name 3',
  'Name 4',
  'Passport',
  'National ID Card',
  'Title/Rank',
  "Father's Name",
  "Mother's Name",
  '* DOB (MM/DD/YYYY)',
  'City/Village',
  'State/Province',
  '* Country',
  'Nationality',
  '* Country',
  '* Sex (M/F)',
] as const;

/** Column letters (A..M) of unit fields, in ObservedUnit order after rowRef. */
export const UNIT_FIELDS = [
  'name',
  'unitIdNo',
  'type',
  'alias',
  'location',
  'description',
  'englishDescription',
  'branchName',
  'branchDescription',
  'parentOrg',
  'subordinateOrg',
  'orgLevel',
  'country',
] as const satisfies readonly (keyof ObservedUnit)[];
export type UnitField = (typeof UNIT_FIELDS)[number];

/** Text fields of an individual by column (A..S); the boolean and DOB columns are handled separately. */
export const PERSON_FIELDS = [
  'unitName',
  'isHeadOfUnit',
  'surname',
  'name1',
  'name2',
  'name3',
  'name4',
  'passport',
  'nationalId',
  'titleRank',
  'fatherName',
  'motherName',
  'dob',
  'pobCity',
  'pobState',
  'pobCountry',
  'nationality',
  'searchCountry',
  'sex',
] as const satisfies readonly (keyof ObservedPerson)[];
export type PersonField = (typeof PERSON_FIELDS)[number];

/** Label in the instructions sheet character-limit table -> field. */
export const LIMIT_LABELS: Readonly<Record<string, { scope: 'unit' | 'person'; field: string }>> = {
  'UNITS: Unit Name': { scope: 'unit', field: 'name' },
  'UNITS: Unit ID #': { scope: 'unit', field: 'unitIdNo' },
  'UNITS: Unit Alias': { scope: 'unit', field: 'alias' },
  'UNITS: Unit Location': { scope: 'unit', field: 'location' },
  'UNITS: Unit Description': { scope: 'unit', field: 'description' },
  'UNITS: Unit English Description': { scope: 'unit', field: 'englishDescription' },
  'UNITS: Branch Name': { scope: 'unit', field: 'branchName' },
  'UNITS: Branch Description': { scope: 'unit', field: 'branchDescription' },
  'UNITS: Parent Organization': { scope: 'unit', field: 'parentOrg' },
  'UNITS: Subordinate Org': { scope: 'unit', field: 'subordinateOrg' },
  'UNITS: Org/Fed Level': { scope: 'unit', field: 'orgLevel' },
  'INDS: Surname': { scope: 'person', field: 'surname' },
  'INDS: Name1': { scope: 'person', field: 'name1' },
  'INDS: Name2': { scope: 'person', field: 'name2' },
  'INDS: Name3': { scope: 'person', field: 'name3' },
  'INDS: Name4': { scope: 'person', field: 'name4' },
  'INDS: Passport': { scope: 'person', field: 'passport' },
  'INDS: National ID Card': { scope: 'person', field: 'nationalId' },
  'INDS: Title/Rank': { scope: 'person', field: 'titleRank' },
  "INDS: Father's Name": { scope: 'person', field: 'fatherName' },
  "INDS: Mother's Name": { scope: 'person', field: 'motherName' },
  'INDS: POB City/Village': { scope: 'person', field: 'pobCity' },
  'INDS: POB State/Province': { scope: 'person', field: 'pobState' },
};

/** Defaults used when the instructions sheet has no limit table (identical to the template). */
export const DEFAULT_LIMITS = {
  unit: {
    name: 512,
    unitIdNo: 32,
    alias: 512,
    location: 256,
    description: 512,
    englishDescription: 512,
    branchName: 128,
    branchDescription: 256,
    parentOrg: 256,
    subordinateOrg: 128,
    orgLevel: 256,
  },
  person: {
    surname: 128,
    name1: 64,
    name2: 64,
    name3: 64,
    name4: 64,
    passport: 32,
    nationalId: 32,
    titleRank: 256,
    fatherName: 128,
    motherName: 128,
    pobCity: 128,
    pobState: 256,
  },
} as const satisfies Record<'unit' | 'person', Record<string, number>>;

export const VERSION_A2 = /^Version (\d+\.\d+\.\d+)$/;
export const VERSION_C2 = /^INVESTc Template Version (\d+\.\d+\.\d+)$/;
