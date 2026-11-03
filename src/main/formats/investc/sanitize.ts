/**
 * Package whitelist for INVESTc workbooks (finding F-05).
 *
 * A counterpart's workbook may carry far more than the three sheets VSS reads: comments, custom XML, label metadata,
 * printer settings, pictures, pivot caches, embedded objects, extra sheets, defined names and document properties.
 * Anything of that kind can hold other people's data, so before a workbook is used as the base of an export (or kept
 * as a vault template) it goes through `sanitizeInvestcPackage`:
 *
 * - KEPT: the package skeleton, the workbook, its styles / theme / shared strings, the three known sheets and the
 *   two standard document-property parts (rewritten to a fixed safe form);
 * - DROPPED (with every reference to them): parts that are known to be metadata or decoration and that nothing VSS
 *   writes depends on (custom XML, label metadata, custom properties, thumbnails, calc chain, comment authors,
 *   printer settings, drawings and pictures, comments and their VML, hyperlinks);
 * - UNKNOWN: everything else (pivot caches and tables, embedded objects, external links, extra sheets, VBA, tables,
 *   orphaned parts, ...). The caller must not use such a package as an export base: filter-original falls back to
 *   regenerating from the vault template, and template capture refuses it.
 *
 * The function is pure and idempotent: a package that is already clean comes back with identical part bytes.
 */
import { decodeUtf8, encodeUtf8, escapeXmlText, parseAttrs } from '../ooxml/xml.ts';
import type { OoxmlPackage } from '../ooxml/zip.ts';
import { EXPECTED_SHEETS } from './layout.ts';

export const SAFE_AUTHOR = 'VSS';

/** The canonical docProps/core.xml: author fields VSS, created/modified timestamps only. */
export function canonicalCoreXml(createdIso: string, modifiedIso: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:creator>${SAFE_AUTHOR}</dc:creator><cp:lastModifiedBy>${SAFE_AUTHOR}</cp:lastModifiedBy>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${escapeXmlText(createdIso)}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${escapeXmlText(modifiedIso)}</dcterms:modified>` +
    '</cp:coreProperties>'
  );
}

/** The canonical docProps/app.xml: application name and the sheet titles, nothing else. */
export function canonicalAppXml(sheetNames: readonly string[] = EXPECTED_SHEETS): string {
  const titles = sheetNames.map((n) => `<vt:lpstr>${escapeXmlText(n)}</vt:lpstr>`).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    `<Application>${SAFE_AUTHOR}</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>` +
    '<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant>' +
    `<vt:variant><vt:i4>${sheetNames.length}</vt:i4></vt:variant></vt:vector></HeadingPairs>` +
    `<TitlesOfParts><vt:vector size="${sheetNames.length}" baseType="lpstr">${titles}</vt:vector></TitlesOfParts>` +
    '<LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged>' +
    '</Properties>'
  );
}

const W3CDTF = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const FALLBACK_TIME = '2000-01-01T00:00:00Z';

function coreTime(xml: string | null, tag: 'created' | 'modified'): string {
  const m = xml ? new RegExp(`<dcterms:${tag}\\b[^>]*>([^<]*)</dcterms:${tag}>`).exec(xml) : null;
  const v = m?.[1]?.trim() ?? '';
  return W3CDTF.test(v) ? v : FALLBACK_TIME;
}

/** Removes `x15ac:absPath` (the author's local folder) and its mc:AlternateContent wrapper from workbook.xml. */
export function removeAbsPath(xml: string): string {
  return xml
    .replace(
      /<mc:AlternateContent\b[^>]*>(?:(?!<\/mc:AlternateContent>)[\s\S])*?x15ac:absPath[\s\S]*?<\/mc:AlternateContent>/g,
      '',
    )
    .replace(/<x15ac:absPath\b[^>]*?(?:\/>|>[\s\S]*?<\/x15ac:absPath>)/g, '');
}

const REF_ONLY = /^(?:'Reference Data'|Reference_Data)!\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?$/;

/**
 * Workbook-level clean-up: absPath, revision pointer, file-sharing user name, and every defined name except plain
 * ranges on the Reference Data sheet (print areas, filters or constants can point at, or hold, removed rows).
 */
export function sanitizeWorkbookXml(xml: string): string {
  let out = removeAbsPath(xml)
    .replace(/<xr:revisionPtr\b[^>]*?(?:\/>|>[\s\S]*?<\/xr:revisionPtr>)/g, '')
    .replace(/<fileSharing\b[^>]*?(?:\/>|>[\s\S]*?<\/fileSharing>)/g, '');
  out = out.replace(/<definedNames\b[^>]*>([\s\S]*?)<\/definedNames>/, (_w, body: string) => {
    const kept: string[] = [];
    const re = /<definedName\b[^>]*?(?:\/>|>([\s\S]*?)<\/definedName>)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      if (m[1] !== undefined && REF_ONLY.test(m[1].trim())) kept.push(m[0]);
    }
    return kept.length > 0 ? `<definedNames>${kept.join('')}</definedNames>` : '';
  });
  out = out.replace(/<definedNames\s*\/>/g, '');
  return out;
}

// ---- relationships ----------------------------------------------------------------------------------------------

interface Rel {
  xml: string;
  id: string;
  type: string;
  target: string;
  external: boolean;
}

function readRels(xml: string | null): Rel[] {
  if (xml === null) return [];
  const out: Rel[] = [];
  const re = /<Relationship\b([^>]*?)(?:\/>|>[\s\S]*?<\/Relationship>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const a = parseAttrs(m[1] as string);
    out.push({
      xml: m[0],
      id: a['Id'] ?? '',
      type: a['Type'] ?? '',
      target: a['Target'] ?? '',
      external: a['TargetMode'] === 'External',
    });
  }
  return out;
}

export function relsPathOf(part: string): string {
  const i = part.lastIndexOf('/');
  return i < 0 ? `_rels/${part}.rels` : `${part.slice(0, i)}/_rels/${part.slice(i + 1)}.rels`;
}

function dirOf(part: string): string {
  const i = part.lastIndexOf('/');
  return i < 0 ? '' : part.slice(0, i);
}

export function resolvePartPath(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const out = baseDir === '' ? [] : baseDir.split('/');
  for (const seg of target.split('/')) {
    if (seg === '..') out.pop();
    else if (seg !== '.' && seg !== '') out.push(seg);
  }
  return out.join('/');
}

const ends = (type: string, ...names: string[]): boolean => names.some((n) => type.endsWith(`/${n}`));

const ROOT_KEEP = ['officeDocument', 'core-properties', 'extended-properties'];
const ROOT_DROP = ['custom-properties', 'classificationlabels', 'thumbnail'];
const WB_KEEP = ['styles', 'theme', 'sharedStrings'];
const WB_DROP = ['calcChain', 'customXml', 'person'];
const SHEET_DROP = ['printerSettings', 'drawing', 'vmlDrawing', 'comments', 'threadedComment', 'hyperlink', 'image'];

export interface SanitizeResult {
  /** The cleaned package (only meaningful when `unknown` is empty). */
  pkg: OoxmlPackage;
  /** Parts removed as known metadata / decoration, sorted. */
  removed: string[];
  /** Parts (or relationship types) VSS does not recognise, sorted. Non-empty => do not use as an export base. */
  unknown: string[];
}

/**
 * Applies the whitelist. `sheetPaths` maps the three expected sheet names to their part paths (from the workbook).
 * Never throws for odd input: anything it cannot classify is reported in `unknown`.
 */
export function sanitizeInvestcPackage(pkg: OoxmlPackage, sheetPaths: ReadonlyMap<string, string>): SanitizeResult {
  const has = (p: string): boolean => pkg.parts.has(p);
  const text = (p: string): string | null => {
    const b = pkg.parts.get(p);
    return b ? decodeUtf8(b) : null;
  };
  const keep = new Set<string>(['[Content_Types].xml', '_rels/.rels']);
  const drop = new Set<string>();
  const unknown = new Set<string>();

  const dropClosure = (part: string): void => {
    if (drop.has(part) || keep.has(part)) return;
    if (has(part)) drop.add(part);
    const rp = relsPathOf(part);
    if (!has(rp)) return;
    drop.add(rp);
    for (const r of readRels(text(rp))) {
      if (!r.external) dropClosure(resolvePartPath(dirOf(part), r.target));
    }
  };

  // Root relationships.
  const rootRels = readRels(text('_rels/.rels'));
  const rootKept: Rel[] = [];
  let workbookPath: string | null = null;
  let corePath: string | null = null;
  let appPath: string | null = null;
  for (const r of rootRels) {
    if (r.external) {
      unknown.add(`external relationship ${r.type.split('/').pop() ?? r.type}`);
      continue;
    }
    const target = resolvePartPath('', r.target);
    if (ends(r.type, ...ROOT_KEEP)) {
      rootKept.push(r);
      keep.add(target);
      if (ends(r.type, 'officeDocument')) workbookPath = target;
      else if (ends(r.type, 'core-properties')) corePath = target;
      else appPath = target;
    } else if (ends(r.type, ...ROOT_DROP)) {
      dropClosure(target);
    } else {
      unknown.add(target);
    }
  }
  if (workbookPath !== 'xl/workbook.xml') unknown.add(workbookPath ?? 'officeDocument relationship');

  // Workbook relationships.
  const wbRelsPath = 'xl/_rels/workbook.xml.rels';
  keep.add(wbRelsPath);
  const known = new Set(EXPECTED_SHEETS.map((n) => sheetPaths.get(n)).filter((p): p is string => !!p));
  const wbKept: Rel[] = [];
  for (const r of readRels(text(wbRelsPath))) {
    if (r.external) {
      unknown.add(`external relationship ${r.type.split('/').pop() ?? r.type}`);
      continue;
    }
    const target = resolvePartPath('xl', r.target);
    if (ends(r.type, 'worksheet') && known.has(target)) {
      wbKept.push(r);
      keep.add(target);
    } else if (ends(r.type, ...WB_KEEP)) {
      wbKept.push(r);
      keep.add(target);
      if (has(relsPathOf(target))) unknown.add(relsPathOf(target));
    } else if (ends(r.type, ...WB_DROP)) {
      dropClosure(target);
    } else {
      unknown.add(target);
    }
  }

  // Sheet relationships: only known-droppable kinds are tolerated; the rels part goes away entirely.
  const strip = new Map<string, Set<string>>(); // sheet path -> relationship types removed
  for (const sheet of known) {
    const rp = relsPathOf(sheet);
    if (!has(rp)) continue;
    const kinds = new Set<string>();
    for (const r of readRels(text(rp))) {
      const kind = r.type.split('/').pop() ?? '';
      if (!ends(r.type, ...SHEET_DROP)) {
        unknown.add(r.external ? `external relationship ${kind}` : resolvePartPath(dirOf(sheet), r.target));
        continue;
      }
      kinds.add(kind);
      if (!r.external) dropClosure(resolvePartPath(dirOf(sheet), r.target));
    }
    drop.add(rp);
    strip.set(sheet, kinds);
  }

  // Everything else in the archive is unknown (including orphans).
  for (const p of pkg.order) if (!keep.has(p) && !drop.has(p)) unknown.add(p);
  for (const p of keep) if (!has(p) && p !== '_rels/.rels') unknown.add(`missing ${p}`);

  // Build the cleaned package.
  const parts = new Map(pkg.parts);
  const order = pkg.order.filter((p) => !drop.has(p));
  for (const p of drop) parts.delete(p);
  const put = (p: string, xml: string): void => {
    const before = parts.get(p);
    const bytes = encodeUtf8(xml);
    if (before && decodeUtf8(before) === xml) return; // keep the very same bytes when nothing changed
    parts.set(p, bytes);
  };

  const filterRels = (p: string, kept: readonly Rel[]): void => {
    const xml = text(p);
    if (xml === null) return;
    const keepXml = new Set(kept.map((r) => r.xml));
    put(
      p,
      xml.replace(/<Relationship\b[^>]*?(?:\/>|>[\s\S]*?<\/Relationship>)/g, (el) => (keepXml.has(el) ? el : '')),
    );
  };
  filterRels('_rels/.rels', rootKept);
  filterRels(wbRelsPath, wbKept);

  const ct = text('[Content_Types].xml');
  if (ct !== null) {
    const kept = new Set([...keep].filter((p) => parts.has(p)).map((p) => `/${p}`.toLowerCase()));
    const exts = new Set(['rels', 'xml']);
    put(
      '[Content_Types].xml',
      ct
        .replace(/<Override\b[^>]*?\/>/g, (el) =>
          kept.has((parseAttrs(el.slice(9, -2))['PartName'] ?? '').toLowerCase()) ? el : '',
        )
        .replace(/<Default\b[^>]*?\/>/g, (el) =>
          exts.has((parseAttrs(el.slice(8, -2))['Extension'] ?? '').toLowerCase()) ? el : '',
        ),
    );
  }

  const wb = text('xl/workbook.xml');
  if (wb !== null) put('xl/workbook.xml', sanitizeWorkbookXml(wb));

  for (const [sheet, kinds] of strip) {
    let xml = text(sheet);
    if (xml === null) continue;
    if (kinds.has('drawing')) xml = xml.replace(/<drawing\b[^>]*?\/>/g, '');
    if (kinds.has('vmlDrawing') || kinds.has('comments') || kinds.has('threadedComment'))
      xml = xml.replace(/<legacyDrawing\b[^>]*?\/>/g, '');
    if (kinds.has('vmlDrawing')) xml = xml.replace(/<legacyDrawingHF\b[^>]*?\/>/g, '');
    if (kinds.has('image')) xml = xml.replace(/<picture\b[^>]*?\/>/g, '');
    if (kinds.has('hyperlink')) xml = xml.replace(/<hyperlinks\b[^>]*>[\s\S]*?<\/hyperlinks>/g, '');
    if (kinds.has('printerSettings')) xml = xml.replace(/(<pageSetup\b[^>]*?)\s+r:id="[^"]*"/g, '$1');
    put(sheet, xml);
  }

  if (corePath && parts.has(corePath)) {
    const src = text(corePath);
    put(corePath, canonicalCoreXml(coreTime(src, 'created'), coreTime(src, 'modified')));
  }
  if (appPath && parts.has(appPath)) put(appPath, canonicalAppXml());

  return {
    pkg: { order, parts },
    removed: [...drop].sort(),
    unknown: [...unknown].sort(),
  };
}

/** Sheet name -> part path for the three expected sheets (missing ones are left out). */
export function expectedSheetPaths(sheets: readonly { name: string; path: string | null }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of sheets) {
    if ((EXPECTED_SHEETS as readonly string[]).includes(s.name) && s.path && !out.has(s.name)) out.set(s.name, s.path);
  }
  return out;
}
