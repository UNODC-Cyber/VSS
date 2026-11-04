/**
 * The full response row behind a review item (cert date, expiry, disposition and raw name are not part of
 * ReviewSubject): found through the item's list context (responseId) and `responses.get`.
 */
import type { ResponseRow, ReviewKind } from '@shared/domain/types';
import { vss } from '../../lib/api';

const PAGE = 200;

export async function findResponseRow(itemId: string, kind: ReviewKind, rowId: string): Promise<ResponseRow | null> {
  for (let offset = 0; offset < 5000; offset += PAGE) {
    const r = await vss().review.list({ offset, limit: PAGE, kinds: [kind] });
    if (!r.ok) return null;
    const it = r.value.items.find((i) => i.id === itemId);
    if (it) {
      if (!it.context || !('responseId' in it.context)) return null;
      const resp = await vss().responses.get({ id: it.context.responseId });
      return resp.ok ? (resp.value.rows.find((x) => x.id === rowId) ?? null) : null;
    }
    if (offset + PAGE >= r.value.total) break;
  }
  return null;
}
