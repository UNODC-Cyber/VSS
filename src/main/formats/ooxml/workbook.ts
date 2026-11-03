import { SharedStringsTable } from './sharedStrings.ts';
import { readSheet, type Sheet } from './sheet.ts';
import { decodeUtf8, parseAttrs } from './xml.ts';
import { readZip, ZipFormatError, type OoxmlPackage } from './zip.ts';

export interface SheetRef {
  name: string;
  sheetId: string | null;
  relId: string | null;
  state: 'visible' | 'hidden' | 'veryHidden';
  /** Part path inside the archive, e.g. xl/worksheets/sheet2.xml; null when the relationship cannot be resolved. */
  path: string | null;
}

export interface WorkbookInfo {
  sheets: SheetRef[];
  sharedStringsPath: string | null;
}

export type OpenResult = { ok: true; pkg: OoxmlPackage; info: WorkbookInfo } | { ok: false; reason: string };

export function partText(pkg: OoxmlPackage, path: string): string | null {
  const b = pkg.parts.get(path);
  return b ? decodeUtf8(b) : null;
}

function resolveTarget(target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const out: string[] = ['xl'];
  for (const seg of target.split('/')) {
    if (seg === '..') out.pop();
    else if (seg !== '.' && seg !== '') out.push(seg);
  }
  return out.join('/');
}

/** Reads sheet names, states and part paths from xl/workbook.xml and its relationships. */
export function readWorkbookInfo(pkg: OoxmlPackage): WorkbookInfo {
  const wbXml = partText(pkg, 'xl/workbook.xml') ?? '';
  const relsXml = partText(pkg, 'xl/_rels/workbook.xml.rels') ?? '';
  const rels = new Map<string, { type: string; target: string }>();
  const rre = /<Relationship\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = rre.exec(relsXml)) !== null) {
    const a = parseAttrs(m[1] as string);
    if (a['Id'] && a['Target']) rels.set(a['Id'], { type: a['Type'] ?? '', target: a['Target'] });
  }
  const sheets: SheetRef[] = [];
  const sre = /<sheet\b([^>]*?)\/?>/g;
  while ((m = sre.exec(wbXml)) !== null) {
    const a = parseAttrs(m[1] as string);
    const relId = a['r:id'] ?? null;
    const rel = relId ? rels.get(relId) : undefined;
    const state = a['state'] === 'hidden' || a['state'] === 'veryHidden' ? a['state'] : 'visible';
    sheets.push({
      name: a['name'] ?? '',
      sheetId: a['sheetId'] ?? null,
      relId,
      state,
      path: rel ? resolveTarget(rel.target) : null,
    });
  }
  let sharedStringsPath: string | null = null;
  for (const r of rels.values()) if (r.type.endsWith('/sharedStrings')) sharedStringsPath = resolveTarget(r.target);
  return { sheets, sharedStringsPath };
}

/** Opens bytes as an xlsx package: a zip with [Content_Types].xml and xl/workbook.xml. Never throws. */
export function openWorkbook(bytes: Uint8Array): OpenResult {
  let pkg: OoxmlPackage;
  try {
    pkg = readZip(bytes);
  } catch (e) {
    return { ok: false, reason: e instanceof ZipFormatError ? e.message : 'not a zip archive' };
  }
  if (!pkg.parts.has('[Content_Types].xml')) return { ok: false, reason: 'missing [Content_Types].xml' };
  if (!pkg.parts.has('xl/workbook.xml')) return { ok: false, reason: 'missing xl/workbook.xml' };
  return { ok: true, pkg, info: readWorkbookInfo(pkg) };
}

export function loadSharedStrings(pkg: OoxmlPackage, info: WorkbookInfo): SharedStringsTable {
  const path = info.sharedStringsPath ?? 'xl/sharedStrings.xml';
  const xml = partText(pkg, path);
  return xml === null ? SharedStringsTable.empty() : new SharedStringsTable(xml);
}

/** Parses one worksheet part. Returns null when the part is missing. */
export function loadSheet(pkg: OoxmlPackage, ref: SheetRef, strings: SharedStringsTable): Sheet | null {
  if (!ref.path) return null;
  const xml = partText(pkg, ref.path);
  return xml === null ? null : readSheet(xml, strings);
}
