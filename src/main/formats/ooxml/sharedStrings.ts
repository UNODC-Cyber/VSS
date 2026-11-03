import {
  decodeExcelEscapes,
  encodeExcelEscapes,
  escapeXmlText,
  parseAttrs,
  stripInvalidXmlChars,
  unescapeXml,
} from './xml.ts';

const SST_OPEN = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const SST_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

/** Plain text of one <si>: all <t> runs concatenated, phonetic runs (<rPh>) excluded. */
function siText(inner: string): string {
  const noPhonetic = inner.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  const re = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noPhonetic)) !== null) out += m[1] ?? '';
  return decodeExcelEscapes(unescapeXml(out));
}

/**
 * Shared string table. Reads every <si> (rich text flattened) and can append new strings while leaving the
 * original XML text untouched, so a read followed by serialize() with no additions is byte-identical.
 */
export class SharedStringsTable {
  private readonly originalXml: string | null;
  private readonly strings: string[] = [];
  private readonly index = new Map<string, number>();
  private readonly appended: string[] = [];
  private readonly originalCount: number;

  constructor(xml: string | null = null) {
    this.originalXml = xml;
    let count = 0;
    if (xml !== null) {
      const open = /<sst\b([^>]*)>/.exec(xml);
      const attrs = open ? parseAttrs(open[1] as string) : {};
      count = Number(attrs['count'] ?? 0) || 0;
      const re = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(xml)) !== null) {
        const text = m[1] === undefined ? '' : siText(m[1]);
        if (!this.index.has(text)) this.index.set(text, this.strings.length);
        this.strings.push(text);
      }
    }
    this.originalCount = count;
  }

  static empty(): SharedStringsTable {
    return new SharedStringsTable(null);
  }

  get size(): number {
    return this.strings.length;
  }

  /** String at a shared index, or undefined when out of range. */
  get(i: number): string | undefined {
    return this.strings[i];
  }

  /** All strings in index order (a copy). */
  toArray(): string[] {
    return [...this.strings];
  }

  /** Index of an existing identical string, or appends it. Invalid XML characters are stripped first. */
  add(text: string): number {
    const clean = stripInvalidXmlChars(text);
    const hit = this.index.get(clean);
    if (hit !== undefined) return hit;
    const i = this.strings.length;
    this.strings.push(clean);
    this.index.set(clean, i);
    this.appended.push(clean);
    return i;
  }

  get appendedCount(): number {
    return this.appended.length;
  }

  /**
   * XML for the part. With no additions the original text is returned as is. `refCount` is the total number of
   * string cells that reference the table (the `count` attribute); it defaults to the original count plus additions.
   */
  serialize(refCount?: number): string {
    if (this.originalXml !== null && this.appended.length === 0 && refCount === undefined) return this.originalXml;
    const items = this.appended
      .map((s) => `<si><t xml:space="preserve">${escapeXmlText(encodeExcelEscapes(s))}</t></si>`)
      .join('');
    const count = refCount ?? this.originalCount + this.appended.length;
    if (this.originalXml === null) {
      return `${SST_OPEN}<sst xmlns="${SST_NS}" count="${count}" uniqueCount="${this.strings.length}">${items}</sst>`;
    }
    const open = /<sst\b([^>]*)>/.exec(this.originalXml);
    const close = this.originalXml.lastIndexOf('</sst>');
    if (!open || close < 0) throw new Error('sharedStrings part is not a well-formed <sst> element');
    let attrs = open[1] as string;
    attrs = setAttr(attrs, 'count', String(count));
    attrs = setAttr(attrs, 'uniqueCount', String(this.strings.length));
    const head = this.originalXml.slice(0, open.index) + `<sst${attrs}>`;
    const body = this.originalXml.slice(open.index + open[0].length, close);
    return head + body + items + '</sst>';
  }
}

function setAttr(attrs: string, name: string, value: string): string {
  const re = new RegExp(`(\\s${name}\\s*=\\s*)(?:"[^"]*"|'[^']*')`);
  return re.test(attrs) ? attrs.replace(re, `$1"${value}"`) : `${attrs} ${name}="${value}"`;
}
