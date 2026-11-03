/**
 * Canonical JSON for signed release manifests: object keys sorted by UTF-16 code unit order (as in RFC 8785 for the
 * ASCII keys we use), no insignificant whitespace, strings escaped by JSON.stringify, numbers must be safe integers.
 * The signature covers exactly these bytes, and verification refuses manifests that are not already canonical, so the
 * object the app acts on is byte-for-byte the object that was signed (no duplicate keys, no reordering tricks).
 */

export type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue };

export class CanonicalizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalizeError';
  }
}

function write(value: unknown, depth: number): string {
  if (depth > 32) throw new CanonicalizeError('Nesting too deep');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) throw new CanonicalizeError('Only safe integers are allowed');
      return Object.is(value, -0) ? '0' : String(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => write(v, depth + 1)).join(',')}]`;
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) throw new CanonicalizeError('Only plain objects are allowed');
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const parts: string[] = [];
      for (const k of keys) {
        if (obj[k] === undefined) throw new CanonicalizeError(`Undefined value for key ${JSON.stringify(k)}`);
        parts.push(`${JSON.stringify(k)}:${write(obj[k], depth + 1)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new CanonicalizeError(`Unsupported type ${typeof value}`);
  }
}

/** Canonical JSON text of `value`. Throws CanonicalizeError on non-JSON or non-integer numbers. */
export function canonicalize(value: unknown): string {
  return write(value, 0);
}

/** UTF-8 bytes of the canonical JSON text. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

/**
 * Parses UTF-8 JSON and returns the value only if the input bytes are exactly its canonical encoding.
 * Returns null for invalid UTF-8, invalid JSON, or non-canonical input (a parsed JSON `null` is `{ value: null }`).
 */
export function parseCanonical(bytes: Uint8Array): { value: unknown } | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  try {
    return canonicalize(value) === text ? { value } : null;
  } catch {
    return null;
  }
}
