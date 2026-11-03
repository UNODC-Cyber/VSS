import type { IsoDateTime, Ulid } from '@shared/domain/types';
import type { Db } from '../open';
import { nowIso } from './util';

/** "Not the same person" decisions. Stored ordered (a < b) so each pair has one row. */
export class NegativePairRepo {
  constructor(private readonly db: Db) {}

  private static order(x: Ulid, y: Ulid): [Ulid, Ulid] {
    return x < y ? [x, y] : [y, x];
  }
  add(x: Ulid, y: Ulid, at: IsoDateTime = nowIso()): void {
    const [a, b] = NegativePairRepo.order(x, y);
    this.db.prepare('INSERT OR IGNORE INTO negative_pair(a, b, at) VALUES (?,?,?)').run(a, b, at);
  }
  has(x: Ulid, y: Ulid): boolean {
    const [a, b] = NegativePairRepo.order(x, y);
    return !!this.db.prepare('SELECT 1 AS x FROM negative_pair WHERE a = ? AND b = ?').get(a, b);
  }
  remove(x: Ulid, y: Ulid): void {
    const [a, b] = NegativePairRepo.order(x, y);
    this.db.prepare('DELETE FROM negative_pair WHERE a = ? AND b = ?').run(a, b);
  }
  /** Ids recorded as "not the same" as `id`. */
  partnersOf(id: Ulid): Ulid[] {
    return (
      this.db
        .prepare('SELECT b AS o FROM negative_pair WHERE a = @id UNION SELECT a FROM negative_pair WHERE b = @id')
        .all({ id }) as { o: string }[]
    ).map((r) => r.o);
  }
}
