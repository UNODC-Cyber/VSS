/**
 * `stats.*` and vetting status helpers (WP-16): per-person status (deriveStatus), the Dashboard (outstanding requests
 * with aging buckets, turnaround mean/median split by DC file vs email, monthly counts, expiring within 30/60/90 days,
 * review count), the expiry watch list and its password-gated CSV export.
 */
import { addDays, daysBetween } from '@shared/domain/status';
import type { IsoDate, Ulid, VettingStatus, VettingStatusSnapshot } from '@shared/domain/types';
import type {
  Dashboard,
  DashboardQuery,
  ExpiryCsvRequest,
  ExpiryCsvResult,
  ExpiryWatchQuery,
  ExpiryWatchRow,
  Result,
  TurnaroundStats,
} from '@shared/ipc/contract';
import { summarize } from './requests';
import { snapshotsFor } from './vetting-status';
import { displayName, fail, makeCtx, mean, median, run } from './vetting-common';
import type { Ctx, ServiceDeps } from './vetting-common';

// DashboardEx, the expiry-watch and CSV types were promoted into the IPC contract (lane J).
export type { ExpiryCsvRequest, ExpiryWatchQuery, ExpiryWatchRow, TurnaroundStats };
export type DashboardEx = Dashboard;
/** Meta key the backup service writes (epoch ms of the last successful backup). */
export const BACKUP_LAST_META_KEY = 'backup.last';

export interface VettingService {
  statusOf(personId: Ulid): Promise<Result<VettingStatusSnapshot>>;
  dashboard(req: DashboardQuery): Promise<Result<DashboardEx>>;
  expiryWatch(req: ExpiryWatchQuery): Promise<Result<ExpiryWatchRow[]>>;
  exportExpiryCsv(req: ExpiryCsvRequest): Promise<Result<ExpiryCsvResult>>;
}

function turnaround(days: number[]): TurnaroundStats {
  return {
    count: days.length,
    meanDays: mean(days),
    medianDays: median(days),
    maxDays: days.length ? Math.max(...days) : null,
  };
}

function activeIds(ctx: Ctx): Ulid[] {
  return (ctx.db.prepare("SELECT id FROM person WHERE state = 'active' ORDER BY id").all() as { id: string }[]).map(
    (r) => r.id,
  );
}

export function expiryWatch(ctx: Ctx, q: ExpiryWatchQuery): ExpiryWatchRow[] {
  const asOf = ctx.today();
  const within = q.withinDays ?? 90;
  const snaps = snapshotsFor(ctx, activeIds(ctx), asOf);
  const rows: ExpiryWatchRow[] = [];
  const persons = new Map(ctx.repos.persons.getMany([...snaps.keys()]).map((p) => [p.id, p]));
  for (const [id, s] of snaps) {
    if (!s.expiresAt || s.status === 'non-approved') continue;
    const left = daysBetween(asOf, s.expiresAt);
    if (left > within || (left < 0 && !q.includeExpired)) continue;
    const rec = s.source ? ctx.repos.vetting.get(s.source) : null;
    rows.push({
      personId: id,
      displayName: displayName(persons.get(id)!.canonical),
      status: s.status,
      expiresAt: s.expiresAt,
      daysLeft: left,
      expiryAssumed: rec?.expiryAssumed ?? false,
      unitName: s.unitId ? (ctx.repos.units.get(s.unitId)?.name ?? null) : null,
    });
  }
  return rows.sort((a, b) =>
    a.expiresAt < b.expiresAt ? -1 : a.expiresAt > b.expiresAt ? 1 : a.personId < b.personId ? -1 : 1,
  );
}

/** Years without any activity after which a person is listed in the (informational) retention hint. */
export const INACTIVE_YEARS = 3;

/** Active persons whose latest activity (edit, request received, record) is INACTIVE_YEARS+ before asOf. */
export function inactivePersons(ctx: Ctx, asOf: IsoDate, sampleSize = 20): Dashboard['inactivePersons'] {
  const [y, m, d] = asOf.split('-');
  const cutoff = `${Number(y) - INACTIVE_YEARS}-${m}-${d}`;
  const rows = ctx.db
    .prepare(
      `SELECT p.id AS id, max(
         coalesce(p.updated_at, ''), coalesce(p.created_at, ''),
         coalesce((SELECT max(r.received_at) FROM request_item i JOIN request r ON r.id = i.request_id
                   WHERE i.person_id = p.id), ''),
         coalesce((SELECT max(v.recorded_at) FROM vetting_record v WHERE v.person_id = p.id), '')
       ) AS last
       FROM person p WHERE p.state = 'active'`,
    )
    .all() as { id: string; last: string }[];
  const old = rows
    .filter((r) => r.last !== '' && r.last.slice(0, 10) < cutoff)
    .sort((a, b) => (a.last < b.last ? -1 : a.last > b.last ? 1 : a.id < b.id ? -1 : 1));
  const persons = new Map(ctx.repos.persons.getMany(old.slice(0, sampleSize).map((r) => r.id)).map((p) => [p.id, p]));
  return {
    count: old.length,
    sample: old.slice(0, sampleSize).map((r) => ({
      personId: r.id,
      displayName: displayName(persons.get(r.id)!.canonical),
      lastActivityAt: r.last.slice(0, 10),
    })),
  };
}

function lastBackup(ctx: Ctx, asOf: IsoDate): Pick<Dashboard, 'lastBackupAt' | 'lastBackupAgeDays'> {
  const raw = Number(ctx.repos.meta.get(BACKUP_LAST_META_KEY) ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return { lastBackupAt: null, lastBackupAgeDays: null };
  const at = new Date(raw).toISOString();
  return { lastBackupAt: at, lastBackupAgeDays: Math.max(0, daysBetween(at.slice(0, 10), asOf)) };
}

/** CSV cell: quoted, quotes doubled, and a leading = + - @ neutralised (spreadsheet formula injection). */
export function csvCell(v: string | number | boolean | null): string {
  let s = v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function createVettingService(deps: ServiceDeps): VettingService {
  const ctx = makeCtx(deps);
  return {
    statusOf: (personId) =>
      run(() => {
        if (!ctx.repos.persons.get(personId)) return fail('NOT_FOUND', 'Person not found');
        return snapshotsFor(ctx, [personId]).get(personId)!;
      }),

    dashboard: (q) =>
      run((): DashboardEx => {
        const asOf = ctx.today();
        const ids = activeIds(ctx);
        const snaps = snapshotsFor(ctx, ids, asOf);
        const counts: Record<VettingStatus, number> = {
          unknown: 0,
          pending: 0,
          approved: 0,
          expiring: 0,
          expired: 0,
          'non-approved': 0,
        };
        const expiringWithin = { d30: 0, d60: 0, d90: 0 };
        for (const s of snaps.values()) {
          counts[s.status]++;
          if (s.expiresAt && s.status !== 'non-approved') {
            const left = daysBetween(asOf, s.expiresAt);
            if (left >= 0 && left <= 30) expiringWithin.d30++;
            if (left >= 0 && left <= 60) expiringWithin.d60++;
            if (left >= 0 && left <= 90) expiringWithin.d90++;
          }
        }
        const outstanding = ctx.repos.requests.outstanding();
        const outSummaries = summarize(ctx, outstanding);
        const agingBuckets = { '0-7': 0, '8-14': 0, '15-30': 0, '>30': 0 };
        const outstandingRequests = outstanding.map((h, i) => {
          const since = (h.sentToDcAt ?? h.receivedAt).slice(0, 10);
          const aging = Math.max(0, daysBetween(since, asOf));
          if (aging <= 7) agingBuckets['0-7']++;
          else if (aging <= 14) agingBuckets['8-14']++;
          else if (aging <= 30) agingBuckets['15-30']++;
          else agingBuckets['>30']++;
          return {
            requestId: h.id,
            eventName: h.eventName,
            sentToDcAt: h.sentToDcAt ?? h.receivedAt,
            agingDays: aging,
            itemCount: outSummaries[i]!.itemCount,
            answeredCount: outSummaries[i]!.answeredCount,
          };
        });
        const since = q.sinceDays !== undefined ? `${addDays(asOf, -q.sinceDays)}T00:00:00.000Z` : undefined;
        const all: number[] = [];
        const file: number[] = [];
        const email: number[] = [];
        for (const t of ctx.repos.requests.responseTimings(since)) {
          const d = Math.max(0, daysBetween(t.sentToDcAt.slice(0, 10), t.respondedAt.slice(0, 10)));
          all.push(d);
          const kind = ctx.repos.requests.getHeader(t.requestId)?.responseKind;
          if (kind === 'email-clearance') email.push(d);
          else if (kind === 'dc-file') file.push(d);
        }
        const months: string[] = [];
        const [y, m] = asOf.split('-').map(Number) as [number, number];
        for (let k = 11; k >= 0; k--) {
          const d = new Date(Date.UTC(y, m - 1 - k, 1));
          months.push(d.toISOString().slice(0, 7));
        }
        const countBy = (col: string): Map<string, number> =>
          new Map(
            (
              ctx.db
                .prepare(
                  `SELECT substr(${col}, 1, 7) AS mo, count(*) AS n FROM request WHERE ${col} IS NOT NULL GROUP BY mo`,
                )
                .all() as { mo: string; n: number }[]
            ).map((r) => [r.mo, r.n]),
          );
        const rec = countBy('received_at');
        const sent = countBy('sent_to_dc_at');
        const resp = countBy('responded_at');
        const expiringSoon = expiryWatch(ctx, { withinDays: ctx.settings().exportPolicy.expiringWithinDays })
          .slice(0, 50)
          .map((r) => ({ personId: r.personId, displayName: r.displayName, expiresAt: r.expiresAt }));
        return {
          asOf,
          counts,
          totalPersons: ids.length,
          openReviewItems: ctx.repos.reviews.counts().open,
          outstandingRequests,
          turnaround: turnaround(all),
          expiringSoon,
          recentRequests: summarize(
            ctx,
            ctx.repos.requests.list({ offset: 0, limit: 10, sort: 'receivedAt', direction: 'desc' }).items,
          ),
          agingBuckets,
          turnaroundByKind: { file: turnaround(file), email: turnaround(email) },
          perMonth: months.map((mo) => ({
            month: mo,
            received: rec.get(mo) ?? 0,
            sent: sent.get(mo) ?? 0,
            responded: resp.get(mo) ?? 0,
          })),
          expiringWithin,
          ...lastBackup(ctx, asOf),
          inactivePersons: inactivePersons(ctx, asOf),
        };
      }),

    expiryWatch: (q) => run(() => expiryWatch(ctx, q)),

    exportExpiryCsv: (req) =>
      run(async () => {
        if (!(await ctx.verifyPassword(req.password))) return fail('BAD_CREDENTIALS', 'Password check failed');
        const rows = expiryWatch(ctx, req);
        const header = ['name', 'status', 'expires_at', 'days_left', 'expiry_assumed', 'unit'];
        const lines = [
          header.map(csvCell).join(','),
          ...rows.map((r) =>
            [r.displayName, r.status, r.expiresAt, r.daysLeft, r.expiryAssumed, r.unitName].map(csvCell).join(','),
          ),
        ];
        const CRLF = '\r\n';
        const bytes = new TextEncoder().encode(String.fromCharCode(0xfeff) + lines.join(CRLF) + CRLF);
        await ctx.files.write(req.destPath, bytes);
        ctx.tx('vetting.exportExpiryCsv', () =>
          ctx.audit('vetting.expiry-export', 'person', null, { count: rows.length, bytes: bytes.byteLength }),
        );
        return { path: req.destPath, count: rows.length, bytes: bytes.byteLength };
      }),
  };
}
