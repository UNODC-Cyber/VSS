/**
 * In-memory data for the dev-only mock API. Everything here is SYNTHETIC (invented names, identifiers and units);
 * never put real personal data in this file.
 */
import { DEFAULT_SETTINGS } from '@shared/domain/types';
import type {
  AuditEvent,
  DcResponse,
  NameKey,
  ObservedPerson,
  ObservedUnit,
  Person,
  RawDate,
  RequestItem,
  ReviewItem,
  Settings,
  Unit,
  UnitVettingRecord,
  VettingRecord,
  VettingRequest,
} from '@shared/domain/types';
import type { KeySlotInfo, MergeLogEntry, TemplateInfo } from '@shared/ipc/contract';

export interface MockDb {
  vault: {
    exists: boolean;
    locked: boolean;
    password: string;
    failed: number;
    lockedOutUntil: string | null;
    path: string | null;
    slots: KeySlotInfo[];
  };
  settings: Settings;
  persons: Person[];
  units: Unit[];
  unitRecords: UnitVettingRecord[];
  requests: VettingRequest[];
  responses: DcResponse[];
  records: VettingRecord[];
  reviews: ReviewItem[];
  audit: AuditEvent[];
  merges: MergeLogEntry[];
  notSame: [string, string][];
  exports: { id: string; requestId: string }[];
  /** Export templates kept in the (mock) vault; at most one active. */
  templates: TemplateInfo[];
  clipboard: string;
}

/** A template row as the real app stores it after sanitising (mock: metadata only). */
export function mockTemplate(source: TemplateInfo['source'], originalName: string, createdAt: string): TemplateInfo {
  return {
    id: newId(),
    kind: 'investc-request',
    source,
    originalName,
    templateVersion: '1.11.0',
    instructionsVersion: '2.6.0',
    sha256: 'a'.repeat(64),
    bytes: 21504,
    createdAt,
    active: true,
    replacedAt: null,
  };
}

let counter = 0;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 26-char ULID-shaped id (not cryptographic; mock only). */
export function newId(): string {
  counter += 1;
  let n = counter;
  let tail = '';
  while (tail.length < 6) {
    tail = ALPHABET[n % 32]! + tail;
    n = Math.floor(n / 32);
  }
  let head = '';
  let ms = Date.now();
  while (head.length < 10) {
    head = ALPHABET[ms % 32]! + head;
    ms = Math.floor(ms / 32);
  }
  return `${head}MOCK000000${tail}`;
}

export function isoDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}
export function isoTime(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString();
}

export function nameKey(surname: string, given: string[]): NameKey {
  const toks = [surname, ...given].map((s) => s.toLowerCase());
  return {
    fullTokens: [...toks].sort(),
    coreTokens: [...toks].sort(),
    particles: [],
    phonetic: [],
    folded: toks.join(' '),
  };
}

export function rawDate(iso: string | null): RawDate {
  return iso
    ? { kind: 'text', value: iso, parsed: iso, ambiguousDayMonth: false }
    : { kind: 'empty', value: '', parsed: null, ambiguousDayMonth: false };
}

export function makePerson(surname: string, given: string[], dob: string | null, extra: Partial<Person> = {}): Person {
  const now = isoTime(-90);
  return {
    id: newId(),
    createdAt: now,
    updatedAt: now,
    canonical: { surname, given, raw: `${surname}, ${given.join(' ')}`, script: 'Latn' },
    aliases: [],
    dob,
    dobPrecision: dob ? 'exact' : 'unknown',
    sex: null,
    pob: { city: null, state: null, country: 'Exampleland' },
    nationality: 'Exampleland',
    identifiers: [],
    state: 'active',
    mergedInto: null,
    notes: '',
    ...extra,
  };
}

export function makeUnit(name: string, type: Unit['type']): Unit {
  return {
    id: newId(),
    name,
    type,
    country: 'Exampleland',
    unitIdNo: null,
    alias: null,
    location: 'Example City',
    description: null,
    englishDescription: null,
    branchName: null,
    branchDescription: null,
    parentOrg: null,
    subordinateOrg: null,
    orgLevel: null,
    aliases: [],
  };
}

export function observedFor(p: Person, unitName: string, rowRef: string): ObservedPerson {
  return {
    rowRef,
    unitName,
    isHeadOfUnit: false,
    surname: p.canonical.surname,
    name1: p.canonical.given[0] ?? '',
    name2: p.canonical.given[1] ?? '',
    name3: '',
    name4: '',
    passport: p.identifiers.find((i) => i.type === 'passport')?.value ?? '',
    nationalId: p.identifiers.find((i) => i.type === 'national-id')?.value ?? '',
    titleRank: '',
    fatherName: '',
    motherName: '',
    dob: rawDate(p.dob),
    pobCity: '',
    pobState: '',
    pobCountry: p.pob.country ?? '',
    nationality: p.nationality ?? '',
    searchCountry: 'Exampleland',
    sex: p.sex ?? '',
  };
}

export function observedUnit(u: Unit, rowRef: string): ObservedUnit {
  return {
    rowRef,
    name: u.name,
    unitIdNo: u.unitIdNo ?? '',
    type: u.type,
    alias: '',
    location: u.location ?? '',
    description: '',
    englishDescription: '',
    branchName: '',
    branchDescription: '',
    parentOrg: '',
    subordinateOrg: '',
    orgLevel: '',
    country: u.country,
  };
}

export function emptyDb(): MockDb {
  return {
    vault: { exists: false, locked: true, password: '', failed: 0, lockedOutUntil: null, path: null, slots: [] },
    settings: structuredClone(DEFAULT_SETTINGS),
    persons: [],
    units: [],
    unitRecords: [],
    requests: [],
    responses: [],
    records: [],
    reviews: [],
    audit: [],
    merges: [],
    notSame: [],
    exports: [],
    templates: [],
    clipboard: '',
  };
}

function makeRecord(
  personId: string,
  unitId: string | null,
  disposition: VettingRecord['disposition'],
  certOffset: number,
  expiresOffset: number | null,
  source: VettingRecord['source'] = 'dc-file',
  expiryAssumed = false,
): VettingRecord {
  return {
    id: newId(),
    personId,
    unitId,
    requestId: null,
    responseRowId: null,
    disposition,
    certDate: isoDay(certOffset),
    expiresAt: expiresOffset === null ? null : isoDay(expiresOffset),
    expiryAssumed,
    source,
    recordedAt: isoTime(certOffset),
    recordedBy: 'mock-user',
    note: '',
  };
}

function hashOf(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0').repeat(8);
}

export function appendAudit(
  db: MockDb,
  type: string,
  subjectType: string,
  subjectId: string | null,
  offsetDays = 0,
  details: Record<string, string | number | boolean> = {},
): void {
  const prev = db.audit[db.audit.length - 1];
  const seq = (prev?.seq ?? 0) + 1;
  const prevHash = prev?.hash ?? '0'.repeat(64);
  const at = isoTime(offsetDays);
  db.audit.push({
    seq,
    at,
    actor: 'mock-user',
    type,
    subjectType,
    subjectId,
    details,
    prevHash,
    hash: hashOf(`${prevHash}|${seq}|${at}|${type}|${subjectId ?? ''}`),
  });
}

/** Synthetic demonstration data: a handful of persons, units, requests and review items. */
export function seed(db: MockDb): void {
  db.templates.push(mockTemplate('auto-capture', 'request-sample.xlsx', '2026-09-01T08:00:00.000Z'));
  const uA = makeUnit('Sample Police Unit A', 'Police');
  const uB = makeUnit('Sample Military Unit B', 'Military');
  const uC = makeUnit('Sample Other Agency C', 'Other');
  db.units.push(uA, uB, uC);

  const alder = makePerson('Alder', ['Terra'], '1980-03-12', {
    sex: 'F',
    identifiers: [{ type: 'passport', value: 'XX0000001', valueFolded: 'xx0000001', issuingCountry: 'Exampleland' }],
  });
  const birch = makePerson('Birch', ['Quincy'], '1991-07-04', { sex: 'M' });
  // Day and month are swapped relative to the import fixture row "Cedar, Sol 10/02/1985".
  const cedar = makePerson('Cedar', ['Solana'], '1985-10-02', { sex: 'F' });
  const elm = makePerson('Elm', ['Rowan'], '1979-01-30', { sex: 'M' });
  const fir = makePerson('Fir', ['Marlo'], '1990-05-05');
  const firDup = makePerson('Fir', ['Marlo', 'J'], '1990-05-05');
  const gum = makePerson('Gum', ['Ellis'], '1988-11-21', {
    identifiers: [{ type: 'national-id', value: 'ID-000-777', valueFolded: 'id000777', issuingCountry: 'Exampleland' }],
  });
  const hazel = makePerson('Hazel', ['Indigo'], null);
  db.persons.push(alder, birch, cedar, elm, fir, firDup, gum, hazel);

  db.records.push(
    makeRecord(alder.id, uA.id, 'approved', -120, 245),
    makeRecord(birch.id, uB.id, 'approved', -330, 25),
    makeRecord(cedar.id, uA.id, 'approved', -400, -35),
    makeRecord(elm.id, uB.id, 'non-approved', -60, null),
    makeRecord(gum.id, uC.id, 'email-cleared', -20, 10, 'email', true),
    makeRecord(fir.id, uC.id, 'approved', -200, 80),
  );

  const mkItem = (requestId: string, p: Person, u: Unit, i: number): RequestItem => ({
    id: newId(),
    requestId,
    observed: observedFor(p, u.name, `R${i + 1}`),
    nameKey: nameKey(p.canonical.surname, p.canonical.given),
    personId: p.id,
    linkState: 'auto',
    unitId: u.id,
    issues: [],
    prior: null,
    exportDecision: 'include',
    exportReason: '',
  });
  const mkReq = (
    kind: 'file' | 'manual',
    eventName: string,
    org: string,
    people: [Person, Unit][],
    patch: Partial<VettingRequest>,
  ): VettingRequest => {
    const id = newId();
    return {
      id,
      kind,
      receivedAt: isoTime(-10),
      requestor: { name: 'Pat Example', email: 'pat@example.invalid', organisation: org },
      eventName,
      eventStart: isoDay(30),
      eventEnd: isoDay(34),
      eventLocation: 'Example City',
      sourceFile:
        kind === 'file'
          ? {
              id: newId(),
              originalName: `${eventName.replace(/\s+/g, '-')}.xlsx`,
              sha256: 'a'.repeat(64),
              bytes: 20480,
              storedAt: isoTime(-10),
            }
          : null,
      templateVersion: kind === 'file' ? 'INVESTc-2024' : null,
      units: [...new Set(people.map(([, u]) => u))].map((u, k) => observedUnit(u, `U${k + 1}`)),
      items: people.map(([p, u], i) => mkItem(id, p, u, i)),
      status: 'received',
      sentToDcAt: null,
      respondedAt: null,
      responseKind: null,
      batchId: null,
      notes: '',
      ...patch,
    };
  };

  db.requests.push(
    mkReq(
      'file',
      'Regional Cyber Workshop',
      'Training Office',
      [
        [alder, uA],
        [birch, uB],
        [elm, uB],
        [fir, uC],
      ],
      {
        receivedAt: isoTime(-14),
        status: 'sent-to-dc',
        sentToDcAt: isoTime(-12),
        batchId: 'BATCH-001',
      },
    ),
    mkReq(
      'file',
      'Forensics Course',
      'Academy',
      [
        [cedar, uA],
        [gum, uC],
      ],
      {
        receivedAt: isoTime(-52),
        status: 'responded',
        sentToDcAt: isoTime(-50),
        respondedAt: isoTime(-41),
        responseKind: 'dc-file',
        batchId: 'BATCH-000',
      },
    ),
    mkReq('manual', 'Liaison Visit', 'Liaison Desk', [[gum, uC]], {
      receivedAt: isoTime(-23),
      status: 'responded',
      sentToDcAt: isoTime(-22),
      respondedAt: isoTime(-19),
      responseKind: 'email-clearance',
    }),
    mkReq('manual', 'Seminar (draft)', 'Desk Officer', [[hazel, uC]], { receivedAt: isoTime(-1) }),
  );

  db.reviews.push({
    id: newId(),
    kind: 'duplicate-persons',
    createdAt: isoTime(-2),
    subjectIds: [fir.id, firDup.id],
    candidates: [
      { targetKind: 'person', targetId: firDup.id, tier: 'T2', evidence: ['NAME_SUBSET_1', 'DOB_EQUAL'], score: 0.86 },
    ],
    state: 'open',
    resolution: null,
  });

  appendAudit(db, 'vault.created', 'vault', null, -90);
  appendAudit(db, 'request.imported', 'request', db.requests[1]!.id, -52);
  appendAudit(db, 'vault.backup', 'vault', null, -9);
}
