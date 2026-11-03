import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NameKey, ObservedPerson, RequestItem } from '@shared/domain/types';
import { runMigrations } from '../../../src/main/db/migrate';
import { openDatabase } from '../../../src/main/db/open';
import type { Db } from '../../../src/main/db/open';
import { createRepos } from '../../../src/main/db/repos';
import type { PersonInput, Repos, RequestInput, RequestItemInput } from '../../../src/main/db/repos';

export const newKey = (): string => randomBytes(32).toString('hex');

export interface Fixture {
  dir: string;
  path: string;
  key: string;
  db: Db;
  repos: Repos;
  cleanup: () => void;
}

/** Fresh encrypted, migrated DB in a temp dir. */
export function freshDb(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'vss-db-test-'));
  const path = join(dir, 'vss.db');
  const key = newKey();
  const db = openDatabase(path, key);
  runMigrations(db, { backupDir: join(dir, 'backups') });
  return {
    dir,
    path,
    key,
    db,
    repos: createRepos(db),
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* closed */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const KEY0: NameKey = { fullTokens: [], coreTokens: [], particles: [], phonetic: [], folded: '' };

/** Synthetic person (all values invented). */
export function personInput(over: Partial<PersonInput> = {}): PersonInput {
  return {
    canonical: {
      surname: 'Testsurname',
      given: ['Synthetic', 'Example'],
      raw: 'TESTSURNAME, Synthetic Example',
      script: 'Latn',
    },
    dob: '1990-03-12',
    dobPrecision: 'exact',
    sex: 'M',
    pob: { city: 'Fictioncity', state: null, country: 'Testland' },
    nationality: 'Testland',
    coreKey: 'example synthetic testsurname',
    ...over,
  };
}

export function observed(over: Partial<ObservedPerson> = {}): ObservedPerson {
  return {
    rowRef: 'Data!A20',
    unitName: 'Synthetic Unit One',
    isHeadOfUnit: false,
    surname: 'Testsurname',
    name1: 'Synthetic',
    name2: '',
    name3: '',
    name4: '',
    passport: '',
    nationalId: '',
    titleRank: '',
    fatherName: '',
    motherName: '',
    dob: { kind: 'serial', value: '32944', parsed: '1990-03-12', ambiguousDayMonth: false },
    pobCity: 'Fictioncity',
    pobState: '',
    pobCountry: 'Testland',
    nationality: 'Testland',
    searchCountry: 'Testland',
    sex: 'M',
    ...over,
  };
}

export function itemInput(over: Partial<RequestItemInput> = {}): RequestItemInput {
  const base: Omit<RequestItem, 'id' | 'requestId'> = {
    observed: observed(),
    nameKey: { ...KEY0, coreTokens: ['synthetic', 'testsurname'] },
    personId: null,
    linkState: 'unlinked',
    unitId: null,
    issues: [],
    prior: null,
    exportDecision: 'include',
    exportReason: '',
  };
  return { ...base, ...over };
}

export function requestInput(over: Partial<RequestInput> = {}): RequestInput {
  return {
    kind: 'file',
    receivedAt: '2026-05-01T08:00:00.000Z',
    requestor: { name: 'Requestor Placeholder', email: 'requestor@example.invalid', organisation: 'Example Org' },
    eventName: 'Synthetic Training Event',
    eventStart: '2026-06-01',
    eventEnd: '2026-06-05',
    eventLocation: 'Fictioncity',
    templateVersion: 'test-1',
    units: [],
    status: 'received',
    sentToDcAt: null,
    respondedAt: null,
    responseKind: null,
    batchId: null,
    notes: '',
    ...over,
  };
}
