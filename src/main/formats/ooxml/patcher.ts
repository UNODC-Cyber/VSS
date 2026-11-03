import { encodeUtf8 } from './xml.ts';
import { canonicalOrder, readZip, writeZip, type OoxmlPackage } from './zip.ts';

/**
 * Copy-on-write view over an OOXML package. Parts that are never replaced keep the very same bytes, so the
 * written archive carries them unchanged. New parts are appended in the order they were added.
 */
export class WorkbookPatcher {
  private readonly order: string[];
  private readonly parts: Map<string, Uint8Array>;
  private readonly original: ReadonlyMap<string, Uint8Array>;
  private readonly changed = new Set<string>();

  constructor(pkg: OoxmlPackage) {
    this.order = [...pkg.order];
    this.parts = new Map(pkg.parts);
    this.original = new Map(pkg.parts);
  }

  static fromBytes(bytes: Uint8Array): WorkbookPatcher {
    return new WorkbookPatcher(readZip(bytes));
  }

  has(path: string): boolean {
    return this.parts.has(path);
  }

  get(path: string): Uint8Array | undefined {
    return this.parts.get(path);
  }

  partNames(): string[] {
    return [...this.order];
  }

  /** Replaces an existing part (throws if it does not exist: use addPart for new ones). */
  replacePart(path: string, data: Uint8Array | string): void {
    if (!this.parts.has(path)) throw new Error(`no such part: ${path}`);
    this.parts.set(path, typeof data === 'string' ? encodeUtf8(data) : data);
    this.changed.add(path);
  }

  addPart(path: string, data: Uint8Array | string): void {
    if (this.parts.has(path)) throw new Error(`part already exists: ${path}`);
    this.order.push(path);
    this.parts.set(path, typeof data === 'string' ? encodeUtf8(data) : data);
    this.changed.add(path);
  }

  removePart(path: string): void {
    if (!this.parts.delete(path)) throw new Error(`no such part: ${path}`);
    const i = this.order.indexOf(path);
    if (i >= 0) this.order.splice(i, 1);
    this.changed.add(path);
  }

  /** Paths replaced, added or removed since construction. */
  touched(): string[] {
    return [...this.changed].sort();
  }

  /** Paths present in both the original and now, with bytes that are identical. */
  untouched(): string[] {
    return this.order.filter((p) => {
      const o = this.original.get(p);
      const n = this.parts.get(p);
      return o !== undefined && n !== undefined && (o === n || equalBytes(o, n));
    });
  }

  toPackage(): OoxmlPackage {
    return { order: [...this.order], parts: new Map(this.parts) };
  }

  /** Deterministic archive bytes. */
  toBytes(): Uint8Array {
    return writeZip(this.toPackage());
  }
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Builds a package from scratch with the canonical part order. */
export function packageFromParts(parts: Record<string, Uint8Array | string>): OoxmlPackage {
  const map = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(parts)) map.set(k, typeof v === 'string' ? encodeUtf8(v) : v);
  return { order: canonicalOrder(map.keys()), parts: map };
}
