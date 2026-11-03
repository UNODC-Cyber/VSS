/** Minimal XML text helpers for OOXML parts. */

/** True when the code point is allowed in XML 1.0 character data. */
function isXmlChar(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

/** Removes characters that cannot appear in XML 1.0 (control chars, lone surrogates, U+FFFE/U+FFFF). */
export function stripInvalidXmlChars(s: string): string {
  let out = '';
  for (const ch of s) {
    // Iterating by code point yields a lone surrogate as its own element.
    const cp = ch.codePointAt(0) as number;
    if (isXmlChar(cp)) out += ch;
  }
  return out;
}

/** Escapes text for element content. Invalid XML characters are dropped; CR is written as a character reference. */
export function escapeXmlText(s: string): string {
  return stripInvalidXmlChars(s).replace(/[&<>\r]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&#13;',
  );
}

/** Escapes text for a double- or single-quoted attribute value. */
export function escapeXmlAttr(s: string): string {
  return stripInvalidXmlChars(s).replace(/[&<>"'\r\n\t]/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&apos;';
      case '\r':
        return '&#13;';
      case '\n':
        return '&#10;';
      default:
        return '&#9;';
    }
  });
}

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Decodes the five predefined entities and numeric character references. Unknown entities are left as written. */
export function unescapeXml(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp <= 0x10ffff && isXmlChar(cp) ? String.fromCodePoint(cp) : whole;
    }
    return NAMED[body] ?? whole;
  });
}

/** Excel stores characters it cannot write directly as _xHHHH_; a literal "_x0041_" is stored as "_x005F_x0041_". */
export function decodeExcelEscapes(s: string): string {
  if (!s.includes('_x')) return s;
  return s.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

export function encodeExcelEscapes(s: string): string {
  return s.replace(/_x([0-9A-Fa-f]{4})_/g, '_x005F_x$1_');
}

const ATTR_RE = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Parses the attributes of a start tag body (the text between the tag name and `>`). Values are unescaped. */
export function parseAttrs(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(body)) !== null) {
    out[m[1] as string] = unescapeXml((m[2] ?? m[3]) as string);
  }
  return out;
}

const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

/** UTF-8 decode that drops a leading BOM. */
export function decodeUtf8(bytes: Uint8Array): string {
  const s = decoder.decode(bytes);
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

export function encodeUtf8(s: string): Uint8Array {
  return encoder.encode(s);
}
