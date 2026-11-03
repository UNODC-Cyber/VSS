// Service-test harness: real encrypted temp DB (random key), fake exporter, in-memory files, controllable clock.
// All data is synthetic (fixtures/ README).
import { createTemplatesService, type TemplatesService } from '../../../src/main/services/templates';
import { generateBlankTemplate } from '../../../tools/fixtures/investc-workbook.ts';
import type { ObservedPerson, ObservedUnit } from '@shared/domain/types';
import type { ManualRequestInput, ManualRequestItemInput, Result } from '@shared/ipc/contract';
import type { ExporterInput, ExporterPort } from '../../../src/main/services/exporter-port';
import { AuditLog } from '../../../src/main/services/audit';
import { createDomainServices } from '../../../src/main/services/vetting-api';
import type { DomainServices } from '../../../src/main/services/vetting-api';
import type { FileIo } from '../../../src/main/services/vetting-common';
import { freshDb } from '../db/helpers';
import type { Fixture } from '../db/helpers';

export { fixtureBytes, fixtureJson } from '../formats/helpers';

export const PASSWORD = 'correct horse battery staple';

export interface FakeExporter extends ExporterPort {
  calls: ExporterInput[];
}
export function fakeExporter(): FakeExporter {
  const calls: ExporterInput[] = [];
  return {
    calls,
    exportInvestc(input) {
      calls.push(input);
      const body = JSON.stringify({
        mode: input.mode,
        units: input.units.length,
        people: input.people.map((p) => p.rowRef),
      });
      return {
        bytes: new TextEncoder().encode(body),
        issues: [],
        stats: { units: input.units.length, people: input.people.length },
        modeUsed: input.mode,
      };
    },
    suggestExportFilename: (_eventName: string, date: Date) => `INVESTc_export_${date.toISOString().slice(0, 10)}.xlsx`,
  };
}

export function memoryFiles(): FileIo & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    read: async (p) => {
      const b = store.get(p);
      if (!b) throw new Error('ENOENT');
      return b;
    },
    write: async (p, b) => {
      store.set(p, b);
    },
    remove: async (p) => {
      store.delete(p);
    },
  };
}

export interface Harness {
  fx: Fixture;
  svc: DomainServices & { templates: TemplatesService };
  exporter: FakeExporter;
  files: ReturnType<typeof memoryFiles>;
  audit: AuditLog;
  setNow(iso: string): void;
  fault: { step: string | null };
  auditCount(): number;
  count(table: string): number;
  cleanup(): void;
}

export function harness(startIso = '2026-11-03T09:00:00.000Z'): Harness {
  const fx = freshDb();
  let now = new Date(startIso);
  const fault = { step: null as string | null };
  const exporter = fakeExporter();
  const files = memoryFiles();
  const audit = new AuditLog(fx.db);
  const deps = {
    db: fx.db,
    repos: fx.repos,
    audit,
    clock: () => now,
    files,
    exporter,
    verifyPassword: async (pw: string) => pw === PASSWORD,
    faultInjector: (step: string) => {
      if (fault.step === step) throw new Error('injected failure');
    },
  };
  const svc = { ...createDomainServices(deps), templates: createTemplatesService(deps) };
  const count = (table: string): number =>
    (fx.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    fx,
    svc,
    exporter,
    files,
    audit,
    setNow: (iso) => {
      now = new Date(iso);
    },
    fault,
    auditCount: () => count('audit'),
    count,
    cleanup: fx.cleanup,
  };
}

/** Stores the test-only generated blank workbook as the vault's active export template. */
export function storeTemplate(h: Harness): Uint8Array {
  const content = generateBlankTemplate();
  h.fx.repos.templates.insertActive({
    kind: 'investc-request',
    source: 'manual',
    originalName: 'blank.xlsx',
    templateVersion: '1.11.0',
    instructionsVersion: '2.6.0',
    content,
  });
  return content;
}

export function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}
export function errCode<T>(r: Result<T>): string {
  if (r.ok) throw new Error('expected an error result');
  return r.error.code;
}

/** Runs a mutating call and asserts it appended exactly one audit event. */
export async function once<T>(h: Harness, p: () => Promise<Result<T>>): Promise<T> {
  const before = h.auditCount();
  const r = await p();
  const v = unwrap(r);
  const after = h.auditCount();
  if (after - before !== 1) throw new Error(`expected exactly one audit event, got ${after - before}`);
  return v;
}

export const REQUESTOR = {
  name: 'Requestor Placeholder',
  email: 'requestor@example.invalid',
  organisation: 'Example Org',
};

export function commitHeader(previewId: string, eventStart = '2026-11-20') {
  return {
    previewId,
    requestor: REQUESTOR,
    eventName: 'Example Workshop',
    eventStart,
    eventEnd: '2026-11-22',
    eventLocation: 'Example City',
    notes: '',
  };
}

export function manualItem(over: Partial<ManualRequestItemInput> = {}): ManualRequestItemInput {
  return {
    surname: 'Testsurname',
    givenNames: ['Synthetic'],
    dob: '1990-03-12',
    dobPrecision: 'exact',
    sex: 'M',
    unitName: 'Synthetic Unit One',
    unitType: 'Police',
    unitCountry: 'TESTLAND',
    pobCountry: 'TESTLAND',
    // Same unit + same POB city is what lets a later request auto-link a known person (security review F-06).
    pobCity: 'Fictioncity',
    nationality: 'TESTLAND',
    isHeadOfUnit: false,
    ...over,
  };
}
export function manualRequest(
  items: ManualRequestItemInput[],
  over: Partial<ManualRequestInput> = {},
): ManualRequestInput {
  return {
    requestor: REQUESTOR,
    eventName: 'Synthetic Manual Event',
    eventStart: '2026-12-01',
    eventEnd: '2026-12-02',
    eventLocation: 'Fictioncity',
    sentToDcAt: null,
    notes: '',
    items,
    ...over,
  };
}

export type { ObservedPerson, ObservedUnit };
