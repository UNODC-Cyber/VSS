import { unzipSync, zipSync, type Zippable } from 'fflate';

/** An OOXML package: part names in archive order plus their bytes. Untouched parts keep the same Uint8Array. */
export interface OoxmlPackage {
  order: string[];
  parts: Map<string, Uint8Array>;
}

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipFormatError';
  }
}

const MiB = 1024 * 1024;
/**
 * Size caps (security review F-09, 2026-11-03). A real INVESTc request or DC response is well under 1 MiB; the caps
 * leave a wide margin while keeping a crafted file from pinning hundreds of MiB in the main process.
 */
export const ZIP_LIMITS = Object.freeze({
  /** The .xlsx file itself. */
  maxInputBytes: 20 * MiB,
  /** One inflated part (a worksheet, sharedStrings). */
  maxPartBytes: 64 * MiB,
  /** All inflated parts together. */
  maxTotalBytes: 256 * MiB,
  maxParts: 5000,
});

/** Reads a zip archive. Throws ZipFormatError when the bytes are not a (sane) zip. Directory entries are skipped. */
export function readZip(bytes: Uint8Array): OoxmlPackage {
  if (bytes.byteLength > ZIP_LIMITS.maxInputBytes)
    throw new ZipFormatError(`file larger than ${ZIP_LIMITS.maxInputBytes / MiB} MiB`);
  let total = 0;
  let count = 0;
  const declared = new Map<string, number>();
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        count += 1;
        total += f.originalSize;
        if (count > ZIP_LIMITS.maxParts) throw new ZipFormatError('too many parts');
        if (f.originalSize > ZIP_LIMITS.maxPartBytes)
          throw new ZipFormatError(`a part inflates to more than ${ZIP_LIMITS.maxPartBytes / MiB} MiB`);
        if (total > ZIP_LIMITS.maxTotalBytes)
          throw new ZipFormatError(`the package inflates to more than ${ZIP_LIMITS.maxTotalBytes / MiB} MiB`);
        declared.set(f.name, f.originalSize);
        return !f.name.endsWith('/');
      },
    });
  } catch (e) {
    if (e instanceof ZipFormatError) throw e;
    throw new ZipFormatError(e instanceof Error ? e.message : 'not a zip archive');
  }
  const order = Object.keys(files);
  const parts = new Map<string, Uint8Array>();
  for (const name of order) {
    const data = files[name] as Uint8Array;
    // fflate stops at the declared size; a part that inflates to a different length has a lying header.
    if (declared.has(name) && declared.get(name) !== data.byteLength)
      throw new ZipFormatError('a part does not match its declared size');
    parts.set(name, data);
  }
  return { order, parts };
}

/** Parts that are already compressed are stored; everything else is deflated at a fixed level. */
function levelFor(name: string): 0 | 6 {
  return /\.(png|jpe?g|gif|zip)$/i.test(name) ? 0 : 6;
}

const FIXED_MTIME = new Date(1980, 0, 1, 0, 0, 0);

/** Writes a deterministic archive: given part order, fixed timestamps, fixed deflate level. */
export function writeZip(pkg: OoxmlPackage): Uint8Array {
  const z: Zippable = {};
  for (const name of pkg.order) {
    const data = pkg.parts.get(name);
    if (!data) throw new ZipFormatError(`part listed in order but missing: ${name}`);
    z[name] = [data, { level: levelFor(name), mtime: FIXED_MTIME }];
  }
  return zipSync(z);
}

/** Order for packages built from scratch: content types, root rels, then the rest alphabetically. */
export function canonicalOrder(names: Iterable<string>): string[] {
  const all = [...names];
  const first = ['[Content_Types].xml', '_rels/.rels'].filter((n) => all.includes(n));
  const rest = all.filter((n) => !first.includes(n)).sort();
  return [...first, ...rest];
}
