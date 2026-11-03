/** A1-style reference math. Columns and rows are 1-based. */

export const MAX_COLUMN = 16384;
export const MAX_ROW = 1048576;

/** 'A' -> 1, 'Z' -> 26, 'AA' -> 27. Returns 0 for anything that is not a valid column label. */
export function colToIndex(label: string): number {
  if (!/^[A-Za-z]{1,3}$/.test(label)) return 0;
  let n = 0;
  for (const ch of label.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n >= 1 && n <= MAX_COLUMN ? n : 0;
}

/** 1 -> 'A', 27 -> 'AA'. Throws RangeError outside 1..16384. */
export function indexToCol(index: number): string {
  if (!Number.isInteger(index) || index < 1 || index > MAX_COLUMN) throw new RangeError(`column index ${index}`);
  let n = index;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export interface CellAddress {
  col: number;
  row: number;
}

/** 'AB12' -> { col: 28, row: 12 }; null when malformed. '$' markers are tolerated. */
export function parseRef(ref: string): CellAddress | null {
  const m = /^\$?([A-Za-z]{1,3})\$?([1-9]\d{0,6})$/.exec(ref);
  if (!m) return null;
  const col = colToIndex(m[1] as string);
  const row = Number(m[2]);
  if (col === 0 || row > MAX_ROW) return null;
  return { col, row };
}

export function makeRef(col: number, row: number): string {
  return `${indexToCol(col)}${row}`;
}
