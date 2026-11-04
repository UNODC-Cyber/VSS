/**
 * Demo seeder (docs/PLAN-ALPHA.md section 11, lane H). Synthetic data only.
 *
 * When `VSS_DEMO_SEED=<password>` is set, the build is not a release channel and no vault exists yet, main creates a
 * vault and imports the dataset in `fixtures/demo/` through the real IPC handlers (the same services the UI uses), in
 * the order of `manifest.json`: request 1 -> export -> response 1 -> request 2 -> response 2. The review items,
 * unmatched and unidentified rows the dataset produces are left in place. On top of that the seeder adds only:
 * two requestors and two e-mail-cleared manual requests (one left Finished, one Closed). The first import captures
 * the export template by itself. The vault is locked again at the end, so the app opens on the unlock screen.
 *
 * Guard (`isDemoSeedAllowed`): unpackaged build, or `VSS_ALLOW_DEMO_SEED=1` (alpha build channel until lane I defines
 * one); never a `release` channel. No Electron import here: the caller passes everything in.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Handlers } from '../../src/main/ipc/registry';
import type { PathGrants } from '../../src/main/services/files';
import type { Result } from '../../src/shared/ipc/contract';

export interface SeedGuardInput {
  env: Record<string, string | undefined>;
  isPackaged: boolean;
  /** Build channel once lane I defines it; 'release' always refuses. */
  channel?: string | undefined;
  vaultExists: boolean;
}

/** The password to seed with, or null when seeding must not run. */
export function isDemoSeedAllowed(g: SeedGuardInput): string | null {
  const pw = g.env['VSS_DEMO_SEED'];
  if (!pw || pw.length < 8) return null;
  if (g.channel === 'release') return null;
  if (g.vaultExists) return null;
  const ok = !g.isPackaged || g.env['VSS_ALLOW_DEMO_SEED'] === '1';
  return ok ? pw : null;
}

export interface SeedDeps {
  handlers: Handlers;
  grants: PathGrants;
  password: string;
  fixturesDir: string;
  /** Scratch folder for the intermediate export (created if missing). */
  tempDir: string;
  log?: (msg: string) => void;
}

interface Manifest {
  files: { request1: string; request2: string; response1: string; response2: string };
  requestor: { email: string; name: string; organisation: string };
  requests: { eventName: string; eventStart: string; eventEnd: string; eventLocation: string }[];
}

const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const stamp = (offset: number): string => `${day(offset)}T08:00:00.000Z`;

export async function seedDemo(d: SeedDeps): Promise<void> {
  const log = d.log ?? (() => undefined);
  const manifest = JSON.parse(readFileSync(join(d.fixturesDir, 'manifest.json'), 'utf8')) as Manifest;
  const table = d.handlers as unknown as Record<
    string,
    Record<string, (a: unknown, e: unknown) => Promise<Result<unknown>> | Result<unknown>>
  >;
  const call = async <T>(ns: string, method: string, arg?: unknown): Promise<T> => {
    const fn = table[ns]?.[method];
    if (!fn) throw new Error(`seed: ${ns}.${method} missing`);
    const r = await fn(arg, undefined);
    if (!r.ok) throw new Error(`seed: ${ns}.${method} failed (${r.error.code})`);
    return r.value as T;
  };
  const file = (name: string): string => {
    const p = join(d.fixturesDir, name);
    if (!existsSync(p)) throw new Error(`seed: missing fixture ${name}`);
    return p;
  };

  await call('vault', 'create', { password: d.password, displayName: 'Demo office' });
  log('vault created');

  const requestor = manifest.requestor;
  const savedRequestor = await call<{ id: string }>('requestors', 'upsert', { requestor });
  await call('requestors', 'upsert', {
    requestor: {
      name: 'Example Programme Officer',
      email: 'officer@example.invalid',
      organisation: 'Example Training Centre',
    },
  });

  mkdirSync(d.tempDir, { recursive: true });
  const importRequest = async (fileName: string, ev: Manifest['requests'][number]) => {
    const pv = await call<{ previewId: string }>('requests', 'importPreview', {
      path: d.grants.issue(file(fileName), 'request-xlsx', 'open'),
    });
    return call<{ id: string }>('requests', 'importCommit', {
      previewId: pv.previewId,
      requestor: { ...requestor, id: savedRequestor.id },
      eventName: ev.eventName,
      eventStart: ev.eventStart,
      eventEnd: ev.eventEnd,
      eventLocation: ev.eventLocation,
      notes: '',
    });
  };
  const importResponse = async (fileName: string, requestId: string) => {
    const pv = await call<{ previewId: string }>('responses', 'importPreview', {
      path: d.grants.issue(file(fileName), 'response-xlsx', 'open'),
      requestId,
    });
    await call('responses', 'importCommit', { previewId: pv.previewId, requestId });
  };

  // Request 1 -> export -> response 1
  const r1 = await importRequest(manifest.files.request1, manifest.requests[0]!);
  await call('requests', 'export', {
    requestId: r1.id,
    mode: 'filter-original',
    destPath: d.grants.issue(join(d.tempDir, 'demo-export.xlsx'), 'request-xlsx', 'save'),
  });
  await call('requests', 'setStatus', { id: r1.id, status: 'sent-to-dc', at: stamp(-14) });
  await importResponse(manifest.files.response1, r1.id);
  log('request 1 and response 1');

  // Request 2 -> response 2
  const r2 = await importRequest(manifest.files.request2, manifest.requests[1]!);
  await call('requests', 'setStatus', { id: r2.id, status: 'sent-to-dc', at: stamp(-7) });
  await importResponse(manifest.files.response2, r2.id);
  log('request 2 and response 2');

  // Two e-mail-cleared manual requests: one stays Finished, one is Closed.
  const person = (surname: string, given: string, dob: string, city: string) => ({
    surname,
    givenNames: [given],
    dob,
    dobPrecision: 'exact',
    sex: 'M',
    unitName: 'Example Cyber Unit',
    unitType: 'Police',
    unitCountry: 'MALAYSIA',
    pobCountry: 'MALAYSIA',
    pobCity: city,
    nationality: 'MALAYSIA',
    isHeadOfUnit: false,
  });
  const manual = async (name: string, items: ReturnType<typeof person>[], offset: number) => {
    const req = await call<{ id: string }>('requests', 'createManual', {
      requestor: { ...requestor, id: savedRequestor.id },
      eventName: name,
      eventStart: day(offset + 30),
      eventEnd: day(offset + 32),
      eventLocation: 'Example Harbour City',
      sentToDcAt: stamp(offset),
      notes: '',
      items,
    });
    const detail = await call<{ items: { id: string }[] }>('requests', 'get', { id: req.id });
    await call('responses', 'recordEmailClearance', {
      requestId: req.id,
      itemIds: detail.items.map((i) => i.id),
      certDate: day(offset + 10),
      expiresAt: day(offset + 10 + 365 * 2),
      disposition: 'approved',
      note: '',
    });
    return req.id;
  };
  await manual('Example Seed Course A', [person('Seedone', 'Alfa', '1980-01-02', 'Examplton')], -40);
  const closedId = await manual(
    'Example Seed Course B',
    [person('Seedtwo', 'Bravo', '1985-05-06', 'Sampleville')],
    -60,
  );
  await call('requests', 'close', { id: closedId, note: 'Demo: closed after clearance.' });
  log('manual requests done');

  await call('vault', 'lock');
  log('vault locked');
}
