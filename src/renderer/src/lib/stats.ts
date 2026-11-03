import type { RequestSummary } from '@shared/ipc/contract';

export type AgingBucket = '0-7' | '8-14' | '15-30' | '>30';
export const AGING_BUCKETS: AgingBucket[] = ['0-7', '8-14', '15-30', '>30'];

export function agingBucket(days: number): AgingBucket {
  if (days <= 7) return '0-7';
  if (days <= 14) return '8-14';
  if (days <= 30) return '15-30';
  return '>30';
}

export function bucketCounts(agingDays: number[]): Record<AgingBucket, number> {
  const out: Record<AgingBucket, number> = { '0-7': 0, '8-14': 0, '15-30': 0, '>30': 0 };
  for (const d of agingDays) out[agingBucket(d)] += 1;
  return out;
}

export function meanMedian(values: number[]): { count: number; mean: number | null; median: number | null } {
  if (values.length === 0) return { count: 0, mean: null, median: null };
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const median = s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  return { count: s.length, mean: s.reduce((a, b) => a + b, 0) / s.length, median };
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86_400_000);
}

/** Turnaround (days from sent to responded) split by how the response arrived. */
export function turnaroundByKind(reqs: RequestSummary[]): {
  file: ReturnType<typeof meanMedian>;
  email: ReturnType<typeof meanMedian>;
} {
  const pick = (kind: 'dc-file' | 'email-clearance') =>
    meanMedian(
      reqs
        .filter((r) => r.responseKind === kind && r.sentToDcAt && r.respondedAt)
        .map((r) => dayDiff(r.sentToDcAt!, r.respondedAt!)),
    );
  return { file: pick('dc-file'), email: pick('email-clearance') };
}

/** Requests received per calendar month for the last `months` months (oldest first). */
export function requestsPerMonth(
  reqs: RequestSummary[],
  months: number,
  now = new Date(),
): { month: string; count: number }[] {
  const out: { month: string; count: number }[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push({ month: d.toISOString().slice(0, 7), count: 0 });
  }
  for (const r of reqs) {
    const m = r.receivedAt.slice(0, 7);
    const slot = out.find((x) => x.month === m);
    if (slot) slot.count += 1;
  }
  return out;
}

export function expiringCounts(
  items: { expiresAt: string }[],
  today: string,
): { d30: number; d60: number; d90: number } {
  const limit = (n: number) => new Date(Date.parse(today) + n * 86_400_000).toISOString().slice(0, 10);
  const within = (n: number) => items.filter((i) => i.expiresAt >= today && i.expiresAt <= limit(n)).length;
  return { d30: within(30), d60: within(60), d90: within(90) };
}
