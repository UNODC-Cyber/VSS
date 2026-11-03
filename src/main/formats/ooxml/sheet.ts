import { makeRef, parseRef } from './columns.ts';
import { decodeExcelEscapes, parseAttrs, unescapeXml } from './xml.ts';

export type CellKind = 'blank' | 'string' | 'number' | 'boolean' | 'error';

export interface Cell {
  ref: string;
  row: number;
  col: number;
  kind: CellKind;
  /** Text form: the string itself, the raw numeric literal, TRUE/FALSE, or the error code. Empty for blank cells. */
  text: string;
  /** Present when kind is 'number'. */
  num?: number;
  /** Present when kind is 'boolean'. */
  bool?: boolean;
  /** Style index (cellXfs) when the cell has one. */
  style: number | null;
}

/** Anything that can resolve a shared string index. */
export interface StringLookup {
  get(i: number): string | undefined;
}

export class Sheet {
  private readonly rows = new Map<number, Map<number, Cell>>();
  private rowList: number[] | null = null;
  maxRow = 0;

  /** @internal */
  put(cell: Cell): void {
    let r = this.rows.get(cell.row);
    if (!r) {
      r = new Map();
      this.rows.set(cell.row, r);
      this.rowList = null;
    }
    r.set(cell.col, cell);
    if (cell.row > this.maxRow) this.maxRow = cell.row;
  }

  /** Row numbers that contain at least one cell element, ascending. */
  rowNumbers(): number[] {
    if (!this.rowList) this.rowList = [...this.rows.keys()].sort((a, b) => a - b);
    return this.rowList;
  }

  cell(row: number, col: number): Cell | undefined {
    return this.rows.get(row)?.get(col);
  }

  cellAt(ref: string): Cell | undefined {
    const a = parseRef(ref);
    return a ? this.cell(a.row, a.col) : undefined;
  }

  /** Cells of a row ordered by column. */
  rowCells(row: number): Cell[] {
    const r = this.rows.get(row);
    return r ? [...r.values()].sort((a, b) => a.col - b.col) : [];
  }

  /** Text of a cell ('' when absent or blank). Numbers keep their raw literal; booleans give TRUE/FALSE. */
  text(row: number, col: number): string {
    return this.cell(row, col)?.text ?? '';
  }

  /** True when no cell in the row carries a value. */
  isRowEmpty(row: number, fromCol = 1, toCol = 16384): boolean {
    const r = this.rows.get(row);
    if (!r) return true;
    for (const c of r.values())
      if (c.col >= fromCol && c.col <= toCol && c.kind !== 'blank' && c.text !== '') return false;
    return true;
  }
}

const ROW_RE = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
const CELL_RE = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;

function innerText(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*?(?:/>|>([\\s\\S]*?)</${tag}>)`);
  const m = re.exec(xml);
  return m ? (m[1] ?? '') : null;
}

function inlineString(inner: string): string {
  const noPhonetic = inner.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  const re = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noPhonetic)) !== null) out += m[1] ?? '';
  return decodeExcelEscapes(unescapeXml(out));
}

/** Parses worksheet XML into cells. Handles t = s, b, n, inlineStr, str, e and blank styled cells. */
export function readSheet(xml: string, strings: StringLookup): Sheet {
  const sheet = new Sheet();
  const data = /<sheetData\b[^>]*?(?:\/>|>([\s\S]*?)<\/sheetData>)/.exec(xml);
  if (!data || !data[1]) return sheet;
  const body = data[1];
  let rowNo = 0;
  ROW_RE.lastIndex = 0;
  let rm: RegExpExecArray | null;
  while ((rm = ROW_RE.exec(body)) !== null) {
    const rattrs = parseAttrs(rm[1] as string);
    rowNo = rattrs['r'] ? Number(rattrs['r']) : rowNo + 1;
    const inner = rm[2];
    if (!inner || !Number.isInteger(rowNo) || rowNo < 1) continue;
    let colNo = 0;
    const cre = new RegExp(CELL_RE.source, 'g');
    let cm: RegExpExecArray | null;
    while ((cm = cre.exec(inner)) !== null) {
      const cattrs = parseAttrs(cm[1] as string);
      let col: number;
      if (cattrs['r']) {
        const a = parseRef(cattrs['r']);
        col = a ? a.col : colNo + 1;
      } else {
        col = colNo + 1;
      }
      colNo = col;
      if (col < 1 || col > 16384) continue;
      const style = cattrs['s'] !== undefined && /^\d+$/.test(cattrs['s']) ? Number(cattrs['s']) : null;
      const t = cattrs['t'] ?? 'n';
      const cinner = cm[2] ?? '';
      const cell: Cell = { ref: makeRef(col, rowNo), row: rowNo, col, kind: 'blank', text: '', style };
      if (t === 'inlineStr') {
        const is = innerText(cinner, 'is');
        if (is !== null) {
          cell.kind = 'string';
          cell.text = inlineString(is);
        }
      } else {
        const v = innerText(cinner, 'v');
        if (v !== null && v !== '') {
          const raw = unescapeXml(v);
          if (t === 's') {
            const s = strings.get(Number(raw));
            if (s !== undefined) {
              cell.kind = 'string';
              cell.text = s;
            }
          } else if (t === 'str') {
            cell.kind = 'string';
            cell.text = decodeExcelEscapes(raw);
          } else if (t === 'b') {
            cell.kind = 'boolean';
            cell.bool = raw.trim() === '1' || raw.trim().toLowerCase() === 'true';
            cell.text = cell.bool ? 'TRUE' : 'FALSE';
          } else if (t === 'e') {
            cell.kind = 'error';
            cell.text = raw;
          } else {
            const n = Number(raw);
            if (Number.isFinite(n)) {
              cell.kind = 'number';
              cell.num = n;
              cell.text = raw.trim();
            } else {
              cell.kind = 'string';
              cell.text = raw;
            }
          }
        }
      }
      sheet.put(cell);
    }
  }
  return sheet;
}
