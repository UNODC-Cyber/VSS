/**
 * Node-side structural checks of an xlsx package: a local stand-in for the OpenXML SDK validator (X-08), cheap
 * enough to run in Vitest on every export.
 *
 * - every XML part is well formed;
 * - [Content_Types].xml covers every part, and every Override names a part that exists;
 * - every internal relationship target resolves to a part;
 * - sharedStrings: uniqueCount = number of <si>, count = number of t="s" cells, every index in range;
 * - per worksheet: rows ascending, cells ascending and in their row, merges valid and non-overlapping, mergeCells
 *   and dataValidations counts correct, <dimension> equal to the extent of the cells.
 */
import { XMLValidator } from 'fast-xml-parser';
import { colToIndex, indexToCol } from '../../src/main/formats/ooxml/columns.ts';
import { decodeUtf8, parseAttrs } from '../../src/main/formats/ooxml/xml.ts';
import { readZip, type OoxmlPackage } from '../../src/main/formats/ooxml/zip.ts';

const XML_PART = /\.(xml|rels|vml)$/i;

function relsSourceDir(relsPath: string): string {
  // a/b/_rels/c.xml.rels -> a/b ; _rels/.rels -> ''
  const i = relsPath.lastIndexOf('_rels/');
  return relsPath.slice(0, Math.max(0, i - 1));
}

function resolve(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const out = baseDir === '' ? [] : baseDir.split('/');
  for (const seg of target.split('/')) {
    if (seg === '..') out.pop();
    else if (seg !== '.' && seg !== '') out.push(seg);
  }
  return out.join('/');
}

interface Rect {
  c1: number;
  r1: number;
  c2: number;
  r2: number;
  ref: string;
}

function rect(ref: string): Rect | null {
  const m = /^([A-Z]{1,3})(\d+)(?::([A-Z]{1,3})(\d+))?$/.exec(ref);
  if (!m) return null;
  const c1 = colToIndex(m[1] as string);
  const r1 = Number(m[2]);
  const c2 = colToIndex((m[3] ?? m[1]) as string);
  const r2 = Number(m[4] ?? m[2]);
  return { c1, r1, c2, r2, ref };
}

function worksheetChecks(path: string, xml: string, sstSize: number | null, errors: string[]): number {
  let stringCells = 0;
  const data = /<sheetData\b[^>]*?(?:\/>|>([\s\S]*?)<\/sheetData>)/.exec(xml);
  const body = data?.[1] ?? '';
  let lastRow = 0;
  let minC = Infinity;
  let maxC = 0;
  let minR = Infinity;
  let maxR = 0;
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(body)) !== null) {
    const r = Number(parseAttrs(rm[1] as string)['r']);
    if (!Number.isInteger(r) || r <= lastRow) errors.push(`${path}: row ${r} out of order (after ${lastRow})`);
    lastRow = r;
    let lastCol = 0;
    const cellRe = /<c\b([^>]*?)(\/?)>/g;
    let cm: RegExpExecArray | null;
    const inner = rm[2] ?? '';
    while ((cm = cellRe.exec(inner)) !== null) {
      const a = parseAttrs(cm[1] as string);
      const ref = /^([A-Z]{1,3})(\d+)$/.exec(a['r'] ?? '');
      if (!ref) {
        errors.push(`${path}: cell without a valid r in row ${r}`);
        continue;
      }
      const c = colToIndex(ref[1] as string);
      if (Number(ref[2]) !== r) errors.push(`${path}: cell ${a['r']} inside row ${r}`);
      if (c <= lastCol) errors.push(`${path}: cell ${a['r']} out of order`);
      lastCol = c;
      minC = Math.min(minC, c);
      maxC = Math.max(maxC, c);
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
      if (a['t'] === 's') {
        stringCells += 1;
        if (cm[2] !== '/') {
          const end = inner.indexOf('</c>', cellRe.lastIndex);
          const v = /<v>\s*(\d+)\s*<\/v>/.exec(inner.slice(cellRe.lastIndex, end < 0 ? undefined : end));
          if (!v) errors.push(`${path}: shared-string cell ${a['r']} without an index`);
          else if (sstSize !== null && Number(v[1]) >= sstSize) {
            errors.push(`${path}: cell ${a['r']} refers to shared string ${v[1]} of ${sstSize}`);
          }
        }
      }
    }
  }
  const dim = /<dimension\b([^>]*?)\/?>/.exec(xml);
  if (dim && maxC > 0) {
    const want = `${indexToCol(minC)}${minR}:${indexToCol(maxC)}${maxR}`;
    const got = parseAttrs(dim[1] as string)['ref'];
    const single = `${indexToCol(minC)}${minR}`;
    if (got !== want && !(got === single && want === `${single}:${single}`)) {
      errors.push(`${path}: dimension ${got} but cells span ${want}`);
    }
  }
  const merges: Rect[] = [];
  const mc = /<mergeCells\b([^>]*)>([\s\S]*?)<\/mergeCells>/.exec(xml);
  if (mc) {
    const re = /<mergeCell\b([^>]*?)\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(mc[2] as string)) !== null) {
      const ref = parseAttrs(m[1] as string)['ref'] ?? '';
      const r = rect(ref);
      if (!r || r.c2 < r.c1 || r.r2 < r.r1 || (r.c1 === r.c2 && r.r1 === r.r2)) {
        errors.push(`${path}: bad merge ${ref}`);
        continue;
      }
      for (const o of merges) {
        if (r.c1 <= o.c2 && o.c1 <= r.c2 && r.r1 <= o.r2 && o.r1 <= r.r2) {
          errors.push(`${path}: merges ${o.ref} and ${ref} overlap`);
        }
      }
      merges.push(r);
    }
    const count = parseAttrs(mc[1] as string)['count'];
    if (count !== undefined && Number(count) !== merges.length) {
      errors.push(`${path}: mergeCells count=${count} but ${merges.length} merges`);
    }
  }
  const counted = (open: RegExp, child: RegExp, label: string): void => {
    const re = new RegExp(open.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      const n = ((m[2] as string).match(child) ?? []).length;
      const count = parseAttrs(m[1] as string)['count'];
      if (count !== undefined && Number(count) !== n) errors.push(`${path}: ${label} count=${count} but ${n} items`);
    }
  };
  counted(/<dataValidations\b([^>]*)>([\s\S]*?)<\/dataValidations>/, /<dataValidation\b/g, 'dataValidations');
  counted(
    /<x14:dataValidations\b([^>]*)>([\s\S]*?)<\/x14:dataValidations>/,
    /<x14:dataValidation\b/g,
    'x14 dataValidations',
  );
  return stringCells;
}

/** Returns human-readable problems; an empty list means the package passed every check. */
export function validatePackageStructure(bytes: Uint8Array): string[] {
  const errors: string[] = [];
  let pkg: OoxmlPackage;
  try {
    pkg = readZip(bytes);
  } catch (e) {
    return [`not a zip: ${e instanceof Error ? e.message : String(e)}`];
  }
  const text = new Map<string, string>();
  for (const [name, data] of pkg.parts) {
    if (!XML_PART.test(name)) continue;
    const xml = decodeUtf8(data);
    text.set(name, xml);
    const ok = XMLValidator.validate(xml);
    if (ok !== true) errors.push(`${name}: not well-formed XML (${ok.err.msg} at line ${ok.err.line})`);
  }

  const ct = text.get('[Content_Types].xml');
  if (ct === undefined) {
    errors.push('missing [Content_Types].xml');
  } else {
    const defaults = new Set<string>();
    const overrides = new Set<string>();
    let m: RegExpExecArray | null;
    const dre = /<Default\b([^>]*?)\/?>/g;
    while ((m = dre.exec(ct)) !== null) defaults.add((parseAttrs(m[1] as string)['Extension'] ?? '').toLowerCase());
    const ore = /<Override\b([^>]*?)\/?>/g;
    while ((m = ore.exec(ct)) !== null) overrides.add(parseAttrs(m[1] as string)['PartName'] ?? '');
    for (const name of pkg.parts.keys()) {
      if (name === '[Content_Types].xml') continue;
      const ext = name.includes('.') ? (name.split('.').pop() as string).toLowerCase() : '';
      if (!overrides.has(`/${name}`) && !defaults.has(ext)) errors.push(`${name}: no content type`);
    }
    for (const o of overrides)
      if (!pkg.parts.has(o.replace(/^\//, ''))) errors.push(`content type override for missing part ${o}`);
  }

  for (const [name, xml] of text) {
    if (!name.endsWith('.rels')) continue;
    const base = relsSourceDir(name);
    const re = /<Relationship\b([^>]*?)\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      const a = parseAttrs(m[1] as string);
      if (a['TargetMode'] === 'External' || !a['Target']) continue;
      const target = resolve(base, a['Target']);
      if (!pkg.parts.has(target)) errors.push(`${name}: relationship ${a['Id']} targets missing part ${target}`);
    }
  }

  const sstXml = text.get('xl/sharedStrings.xml');
  let sstSize: number | null = null;
  let sstAttrs: Record<string, string> = {};
  if (sstXml !== undefined) {
    sstSize = (sstXml.match(/<si\b/g) ?? []).length;
    sstAttrs = parseAttrs(/<sst\b([^>]*)>/.exec(sstXml)?.[1] ?? '');
    if (sstAttrs['uniqueCount'] !== undefined && Number(sstAttrs['uniqueCount']) !== sstSize) {
      errors.push(`xl/sharedStrings.xml: uniqueCount=${sstAttrs['uniqueCount']} but ${sstSize} <si>`);
    }
  }
  let stringCells = 0;
  for (const [name, xml] of text) {
    if (/^xl\/worksheets\/[^/]+\.xml$/.test(name)) stringCells += worksheetChecks(name, xml, sstSize, errors);
  }
  if (sstXml !== undefined && sstAttrs['count'] !== undefined && Number(sstAttrs['count']) !== stringCells) {
    errors.push(`xl/sharedStrings.xml: count=${sstAttrs['count']} but ${stringCells} shared-string cells`);
  }
  return errors;
}
