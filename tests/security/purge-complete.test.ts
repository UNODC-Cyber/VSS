/**
 * Security review F-01: purge must erase a person's data everywhere VSS keeps it.
 *
 * The services run over a PLAINTEXT SQLite file here (same migrations, same pragmas as production except the
 * cipher), so a raw-byte scan of the main file and the -wal file is meaningful: with the real cipher every page is
 * encrypted and such a scan would always pass. After the purge the test scans every table and column (including
 * the FTS5 shadow tables), unpacks every stored workbook, and greps the raw DB and WAL bytes. Synthetic data only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { investcExporter } from '../../src/main/app/domain-wiring';
import { runMigrations } from '../../src/main/db/migrate';
import { Db } from '../../src/main/db/open';
import { createRepos } from '../../src/main/db/repos';
import { searchAll } from '../../src/main/db/search';
import { AuditLog } from '../../src/main/services/audit';
import { createDomainServices } from '../../src/main/services/vetting-api';
import { commitHeader, fixtureBytes, memoryFiles, PASSWORD, unwrap } from '../unit/services/helpers';

/** Values that only the purged person (A) and the person merged into it (B) carry in req-001 / resp-001. */
const A = ['Siarorikpon', 'Bachop', 'Tamwuan', 'ZN000001', 'Nojammat', 'Bimak', '1996-12-11', '12/11/1996'];
const B = ['Buthasak', 'Moeta', 'ZZ000001', 'Choetai', 'Wiajaong', '1989-08-03'];
/** Person C (kept): proves the scan does see data. */
const C = ['Thaikhamum', 'Chaipaom'];

function plainHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'vss-purge-'));
  const path = join(dir, 'plain.db');
  const raw = new Database(path);
  raw.pragma('journal_mode = WAL');
  raw.pragma('synchronous = FULL');
  raw.pragma('secure_delete = ON');
  raw.pragma('temp_store = MEMORY');
  raw.pragma('foreign_keys = ON');
  const db = new Db(raw, path);
  runMigrations(db, { backupDir: join(dir, 'mig') });
  const repos = createRepos(db);
  let now = new Date('2026-11-03T09:00:00.000Z');
  const svc = createDomainServices({
    db,
    repos,
    audit: new AuditLog(db),
    clock: () => now,
    files: memoryFiles(),
    exporter: investcExporter,
    verifyPassword: async (pw) => pw === PASSWORD,
  });
  return {
    dir,
    path,
    db,
    repos,
    svc,
    setNow: (iso: string) => void (now = new Date(iso)),
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
type H = ReturnType<typeof plainHarness>;

const lower = (s: string) => s.toLowerCase();
const inText = (hay: string, needle: string) => lower(hay).includes(lower(needle));
const inBytes = (hay: Uint8Array, needle: string) => {
  const b = Buffer.from(hay.buffer, hay.byteOffset, hay.byteLength);
  return b.includes(Buffer.from(needle, 'utf8')) || b.includes(Buffer.from(lower(needle), 'utf8'));
};
/** Bytes plus, when they are a zip (xlsx), every inflated part. */
function expand(bytes: Uint8Array): Uint8Array[] {
  const out = [bytes];
  try {
    out.push(...Object.values(unzipSync(bytes)));
  } catch {
    // not a zip
  }
  return out;
}

/** Every place a needle is still found: `table.column`, `stored-file`, `db-file`, `wal-file`. */
function findLeftovers(h: H, needles: readonly string[]): string[] {
  const hits = new Set<string>();
  const tables = (h.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
    (t) => t.name,
  );
  expect(tables).toEqual(expect.arrayContaining(['request_search_data', 'request_search_content', 'audit']));
  for (const t of tables) {
    for (const row of h.db.prepare(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[]) {
      for (const [col, v] of Object.entries(row)) {
        for (const n of needles) {
          if (typeof v === 'string' && inText(v, n)) hits.add(`${t}.${col}:${n}`);
          if (v instanceof Uint8Array && expand(v).some((b) => inBytes(b, n))) hits.add(`${t}.${col}:${n}`);
        }
      }
    }
  }
  h.db.checkpoint();
  const files: [string, string][] = [
    ['db-file', h.path],
    ['wal-file', `${h.path}-wal`],
  ];
  for (const [label, p] of files) {
    if (!existsSync(p)) continue;
    const bytes = readFileSync(p);
    for (const n of needles) if (inBytes(bytes, n)) hits.add(`${label}:${n}`);
  }
  return [...hits].sort();
}

/** Trigrams of the purged values that no remaining search blob uses: none may survive in an FTS5 segment. */
function leftoverTrigrams(h: H, needles: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of ['person_search', 'unit_search', 'request_search', 'response_search']) {
    const live = (h.db.prepare(`SELECT c1 AS blob FROM ${t}_content`).all() as { blob: string | null }[])
      .map((r) => r.blob ?? '')
      .join('\n');
    const blocks = (h.db.prepare(`SELECT block FROM ${t}_data`).all() as { block: Uint8Array | null }[]).flatMap((r) =>
      r.block ? [r.block] : [],
    );
    for (const n of needles) {
      const s = lower(n);
      for (let i = 0; i + 3 <= s.length; i++) {
        const g = s.slice(i, i + 3);
        if (live.includes(g)) continue;
        if (blocks.some((b) => inBytes(b, g))) out.push(`${t}:${g}`);
      }
    }
  }
  return [...new Set(out)].sort();
}

async function seed(h: H) {
  const p = unwrap(await h.svc.requests.importFile('r.xlsx', fixtureBytes('requests/req-001-basic.xlsx')));
  const s = unwrap(await h.svc.requests.importCommit(commitHeader(p.previewId)));
  const ex = unwrap(await h.svc.requests.export({ requestId: s.id, mode: 'filter-original', destPath: '/o.xlsx' }));
  expect(ex.mode).toBe('filter-original');
  unwrap(await h.svc.requests.markSentToDc({ id: s.id, at: '2026-11-05T08:00:00.000Z' }));
  h.setNow('2026-11-25T08:00:00.000Z');
  const pv = unwrap(
    await h.svc.responses.importFile('a.xlsx', fixtureBytes('responses/resp-001-all-approved.xlsx'), s.id),
  );
  unwrap(await h.svc.responses.importCommit({ previewId: pv.previewId, requestId: s.id }));
  const items = h.repos.requests.listItems(s.id);
  const pid = (surname: string) => items.find((i) => i.observed.surname === surname)!.personId!;
  return { requestId: s.id, a: pid('Siarorikpon'), b: pid('Buthasak'), c: pid('Thaikhamum') };
}

describe('F-01 purge erases everywhere', () => {
  let h: H;
  afterEach(() => h?.cleanup());

  it('scan of every table, FTS shadow table, stored blob, the DB file and the WAL finds nothing after purge', async () => {
    h = plainHarness();
    const { requestId, a, b, c } = await seed(h);
    // B is merged into A (A gets B's name as a merge alias); A and C are marked as not the same person.
    unwrap(await h.svc.persons.merge({ survivorId: a, mergedId: b, reason: 'same as Buthasak Moeta' }));
    unwrap(await h.svc.persons.markNotSame({ a, b: c }));
    // Sanity: before the purge the scan finds the data in many places.
    const before = findLeftovers(h, A);
    expect(before.some((x) => x.startsWith('stored_file.content'))).toBe(true);
    expect(before.some((x) => x.startsWith('request_search_content'))).toBe(true);

    unwrap(await h.svc.persons.purge({ id: a, password: PASSWORD }));

    expect(findLeftovers(h, [...A, ...B])).toEqual([]);
    expect(leftoverTrigrams(h, ['Siarorikpon', 'Buthasak'])).toEqual([]);
    // C is untouched (the scan is not blind), and the negative pair naming A is gone.
    expect(findLeftovers(h, C).length).toBeGreaterThan(0);
    expect(h.repos.negativePairs.has(a, c)).toBe(false);
    // Nothing is searchable any more under the purged name, in any kind.
    for (const n of ['Siarorikpon', 'Bachop', 'Buthasak']) {
      expect(searchAll(h.db, n).groups.map((g) => g.total)).toEqual([0, 0, 0, 0]);
    }
    // Stored workbooks of the request, its export and the response are scrubbed but still recognised by hash.
    const req = h.repos.requests.get(requestId)!;
    expect(h.repos.files.content(req.sourceFile!.id)).toBeNull();
    expect(h.repos.files.isPurged(req.sourceFile!.id)).toBe(true);
    expect(h.repos.files.verify(req.sourceFile!.id)).toBe(false);
    const dup = unwrap(
      await h.svc.responses.importFile('again.xlsx', fixtureBytes('responses/resp-001-all-approved.xlsx'), requestId),
    );
    expect(dup.duplicateOfResponseId).not.toBeNull();
    // Export falls back to regenerate: the original workbook is gone.
    const pre = unwrap(await h.svc.requests.exportPreview({ requestId, mode: 'filter-original' }));
    expect(pre.filterOriginalAvailable).toBe(false);
    // Audit chain still verifies and its details carry no personal data.
    expect(new AuditLog(h.db).verifyChain().ok).toBe(true);
  });

  it('FTS5 secure-delete is on for every search table (migration 003)', () => {
    h = plainHarness();
    for (const t of ['person_search', 'unit_search', 'request_search', 'response_search']) {
      const r = h.db.prepare(`SELECT v FROM ${t}_config WHERE k = 'secure-delete'`).get() as { v: number } | undefined;
      expect(r?.v).toBe(1);
    }
  });
});
