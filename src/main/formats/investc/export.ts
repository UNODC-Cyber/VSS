/**
 * INVESTc request exporter (docs/FILE-FORMATS.md X-01..X-07).
 *
 * Two modes:
 * - `regenerate`: patch a blank template. VSS ships NO template: the caller passes the one kept in the vault
 *   (captured from the first imported request or imported in Settings > Templates). Without one, regenerate throws
 *   `TemplateMissingError`; there is never a bundled fallback.
 * - `filter-original`: patch the counterpart's own workbook after the package whitelist (sanitize.ts, F-05) has
 *   dropped every part that could carry other people's data. Falls back to `regenerate` (with an info issue) when the
 *   source is not the known template, uses sheet features that cannot be re-anchored, or holds parts the whitelist
 *   does not recognise.
 *
 * In both modes only the Data sheet, the shared strings and docProps/core.xml change relative to the (sanitised) base
 * (X-02 / X-03). Callers pre-filter: every supplied person is written; supplied units are written when an exported
 * person refers to them (X-07). Output is deterministic: the same input gives the same bytes.
 */
import type { ObservedPerson, ObservedUnit, ValidationIssue } from '../../../shared/domain/types.ts';
import { isoToSerial } from '../ooxml/dates.ts';
import { WorkbookPatcher } from '../ooxml/patcher.ts';
import { SharedStringsTable } from '../ooxml/sharedStrings.ts';
import { openWorkbook, partText, readWorkbookInfo, type WorkbookInfo } from '../ooxml/workbook.ts';
import { encodeExcelEscapes, escapeXmlText, parseAttrs, stripInvalidXmlChars } from '../ooxml/xml.ts';
import type { OoxmlPackage } from '../ooxml/zip.ts';
import {
  rewriteDataSheet,
  splitSheet,
  UnsupportedSheetError,
  type ExportCellValue,
  type ExportRowValues,
  type SourceSheetLayout,
} from './export-sheet.ts';
import { KNOWN_TEMPLATE_VERSIONS, SHEET_DATA, UNIT_FIELDS } from './layout.ts';
import { normalizeUnitName } from './names.ts';
import { parseInvestc } from './parse.ts';
import type { ReferenceData } from './reference.ts';
import { expectedSheetPaths, sanitizeInvestcPackage } from './sanitize.ts';

export { removeAbsPath } from './sanitize.ts';

export type ExportMode = 'filter-original' | 'regenerate';

export interface ExportInput {
  mode: ExportMode;
  /** The counterpart's original workbook; required for filter-original. */
  source?: Uint8Array;
  /** Blank template for regenerate (and for the filter-original fallback): the one kept in the vault. No default. */
  template?: Uint8Array;
  units: ObservedUnit[];
  people: ObservedPerson[];
  /** When given, docProps/core.xml `dcterms:modified` is set to this instant. Omitted: left as in the base file. */
  now?: Date;
}

export interface ExportResult {
  bytes: Uint8Array;
  issues: ValidationIssue[];
  stats: { units: number; people: number };
  /** The mode actually used (filter-original may fall back to regenerate). */
  modeUsed: ExportMode;
}

/** User-facing explanation of what to do when no template is available. */
export const TEMPLATE_MISSING_HELP =
  'No export template is stored in this vault. Open Settings > Templates and import a blank INVESTc workbook ' +
  '(or any INVESTc request you received; its rows are removed), then export again.';

/** Regenerate was needed but no template was supplied. The message is safe to show to the user. */
export class TemplateMissingError extends Error {
  /** Why regenerate was needed (null for a plain regenerate request). */
  readonly reason: string | null;
  constructor(reason: string | null) {
    super(
      reason === null
        ? TEMPLATE_MISSING_HELP
        : `The original workbook could not be filtered (${reason}). ${TEMPLATE_MISSING_HELP}`,
    );
    this.name = 'TemplateMissingError';
    this.reason = reason;
  }
}

export const EXPORT_AUTHOR = 'VSS';

/** Columns (1-based) of the individual block. */
const P = {
  unitName: 1,
  isHead: 2,
  surname: 3,
  dob: 13,
  pobCountry: 16,
  nationality: 17,
  searchCountry: 18,
  sex: 19,
} as const;

const PERSON_TEXT_COLS: readonly [keyof ObservedPerson, number][] = [
  ['unitName', 1],
  ['surname', 3],
  ['name1', 4],
  ['name2', 5],
  ['name3', 6],
  ['name4', 7],
  ['passport', 8],
  ['nationalId', 9],
  ['titleRank', 10],
  ['fatherName', 11],
  ['motherName', 12],
  ['pobCity', 14],
  ['pobState', 15],
];

function issue(
  code: ValidationIssue['code'],
  severity: ValidationIssue['severity'],
  rowRef: string | null,
  field: string | null,
  message: string,
): ValidationIssue {
  return { code, severity, rowRef, field, message };
}

/** X-06 text cleaning: NFC, control characters and characters that XML cannot carry removed. */
export function cleanExportText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return stripInvalidXmlChars(s.normalize('NFC')).replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

/** Canonical spelling from a list (case-insensitive, trimmed); null when absent. */
class Canon {
  private readonly map = new Map<string, string>();
  constructor(values: readonly string[]) {
    for (const v of values) {
      const k = v.trim().toLowerCase();
      if (!this.map.has(k)) this.map.set(k, v.trim());
    }
  }
  get(value: string): string | null {
    return this.map.get(value.trim().toLowerCase()) ?? null;
  }
}

interface Vocab {
  unitTypes: Canon;
  genders: Canon;
  pob: Canon;
  unit: Canon;
}

function vocab(ref: ReferenceData): Vocab {
  return {
    unitTypes: new Canon(ref.unitTypes),
    genders: new Canon(ref.genders),
    pob: new Canon(ref.countriesPob),
    unit: new Canon(ref.countriesUnit),
  };
}

function listValue(
  raw: string,
  canon: Canon,
  upper: boolean,
  issues: ValidationIssue[],
  code: ValidationIssue['code'],
  rowRef: string,
  field: string,
  label: string,
): ExportCellValue | null {
  const text = cleanExportText(raw).trim();
  if (text === '') return null;
  const hit = canon.get(text);
  if (hit !== null) return { t: 's', v: hit };
  issues.push(issue(code, 'warning', rowRef, field, `${label} "${text}" is not in the template list; written as is.`));
  return { t: 's', v: upper ? text.toUpperCase() : text };
}

function textValue(raw: string): ExportCellValue | null {
  const t = cleanExportText(raw);
  return t.trim() === '' ? null : { t: 's', v: t };
}

function unitRow(u: ObservedUnit, v: Vocab, issues: ValidationIssue[]): ExportRowValues {
  const row: ExportRowValues = new Map();
  UNIT_FIELDS.forEach((field, i) => {
    const col = i + 1;
    let cell: ExportCellValue | null;
    if (field === 'type') {
      cell = listValue(u.type, v.unitTypes, false, issues, 'UNIT_TYPE_INVALID', u.rowRef, 'type', 'Unit Type');
    } else if (field === 'country') {
      cell = listValue(u.country, v.unit, true, issues, 'COUNTRY_NOT_IN_LIST', u.rowRef, 'country', 'Unit Country');
    } else {
      cell = textValue(u[field]);
    }
    if (cell) row.set(col, cell);
  });
  return row;
}

function personRow(p: ObservedPerson, v: Vocab, issues: ValidationIssue[]): ExportRowValues {
  const row: ExportRowValues = new Map();
  for (const [field, col] of PERSON_TEXT_COLS) {
    const cell = textValue(p[field] as string);
    if (cell) row.set(col, cell);
  }
  if (p.isHeadOfUnit === null) {
    issues.push(issue('REQUIRED_MISSING', 'warning', p.rowRef, 'isHeadOfUnit', 'IsHeadOfUnit is empty; left blank.'));
  } else {
    row.set(P.isHead, { t: 'b', v: p.isHeadOfUnit });
  }
  const dob = dobValue(p, issues);
  if (dob) row.set(P.dob, dob);
  const c = (raw: string, canon: Canon, field: string, col: number, label: string): void => {
    const cell = listValue(raw, canon, true, issues, 'COUNTRY_NOT_IN_LIST', p.rowRef, field, label);
    if (cell) row.set(col, cell);
  };
  c(p.pobCountry, v.pob, 'pobCountry', P.pobCountry, 'Place of birth Country');
  c(p.nationality, v.pob, 'nationality', P.nationality, 'Nationality');
  c(p.searchCountry, v.unit, 'searchCountry', P.searchCountry, 'Search Country');
  const sex = listValue(p.sex, v.genders, true, issues, 'SEX_INVALID', p.rowRef, 'sex', 'Sex');
  if (sex) row.set(P.sex, sex);
  return row;
}

function dobValue(p: ObservedPerson, issues: ValidationIssue[]): ExportCellValue | null {
  const d = p.dob;
  if (d.kind === 'empty' && d.value.trim() === '') return null;
  if (d.parsed !== null) {
    const serial = isoToSerial(d.parsed);
    if (serial !== null) return { t: 'n', v: serial };
  }
  if (d.kind === 'serial') {
    const n = Number(d.value);
    if (Number.isFinite(n)) {
      issues.push(issue('DOB_INVALID', 'warning', p.rowRef, 'dob', `DOB serial ${d.value} is not a valid date.`));
      return { t: 'n', v: n };
    }
  }
  const text = cleanExportText(d.value);
  if (text.trim() === '') return null;
  issues.push(issue('DOB_INVALID', 'warning', p.rowRef, 'dob', `DOB "${text}" is not a valid date; written as text.`));
  return { t: 's', v: text };
}

// ---- package helpers -------------------------------------------------------------------------------------------

function relsTargets(pkg: OoxmlPackage, relsPath: string, baseDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const xml = partText(pkg, relsPath);
  if (xml === null) return out;
  const re = /<Relationship\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const a = parseAttrs(m[1] as string);
    if (!a['Type'] || !a['Target'] || a['TargetMode'] === 'External') continue;
    out.set(a['Type'], resolvePath(baseDir, a['Target']));
  }
  return out;
}

function resolvePath(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const out = baseDir === '' ? [] : baseDir.split('/');
  for (const seg of target.split('/')) {
    if (seg === '..') out.pop();
    else if (seg !== '.' && seg !== '') out.push(seg);
  }
  return out.join('/');
}

function stylesPath(pkg: OoxmlPackage): string {
  for (const [type, path] of relsTargets(pkg, 'xl/_rels/workbook.xml.rels', 'xl')) {
    if (type.endsWith('/styles')) return path;
  }
  return 'xl/styles.xml';
}

function corePath(pkg: OoxmlPackage): string | null {
  for (const [type, path] of relsTargets(pkg, '_rels/.rels', '')) {
    if (type.endsWith('/core-properties')) return path;
  }
  return pkg.parts.has('docProps/core.xml') ? 'docProps/core.xml' : null;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 22, 27, 30, 36, 50, 57]);

function isDateFormatCode(code: string): boolean {
  const bare = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
  return /[dy]/i.test(bare) && !/[@#0?]/.test(bare);
}

/** Style index of the DOB column: the pattern row's M cell, else column M's default, if that style is a date. */
function findDobStyle(sheetXml: string, stylesXml: string | null, hdr: number): number | null {
  if (stylesXml === null) return null;
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? '';
  const fmtOfXf: number[] = [];
  const xre = /<xf\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = xre.exec(xfs)) !== null) fmtOfXf.push(Number(parseAttrs(m[1] as string)['numFmtId'] ?? 0));
  const custom = new Map<number, string>();
  const fre = /<numFmt\b([^>]*?)\/?>/g;
  while ((m = fre.exec(stylesXml)) !== null) {
    const a = parseAttrs(m[1] as string);
    if (a['numFmtId'] !== undefined && a['formatCode'] !== undefined)
      custom.set(Number(a['numFmtId']), a['formatCode']);
  }
  const isDate = (style: number): boolean => {
    const id = fmtOfXf[style];
    if (id === undefined) return false;
    const code = custom.get(id);
    return code !== undefined ? isDateFormatCode(code) : BUILTIN_DATE_FORMATS.has(id);
  };
  const candidates: number[] = [];
  const parts = splitSheet(sheetXml);
  const pattern = parts.rows.get(hdr + 1);
  const mCell = pattern ? /<c\b[^>]*?\sr="M\d+"[^>]*?>/.exec(pattern) : null;
  const ms = mCell ? parseAttrs(mCell[0].slice(2).replace(/\/?>$/, ''))['s'] : undefined;
  if (ms !== undefined) candidates.push(Number(ms));
  const cre = /<col\b([^>]*?)\/?>/g;
  while ((m = cre.exec(parts.head)) !== null) {
    const a = parseAttrs(m[1] as string);
    if (Number(a['min']) <= 13 && Number(a['max']) >= 13 && a['style'] !== undefined)
      candidates.push(Number(a['style']));
  }
  return candidates.find(isDate) ?? null;
}

/** Sets creator/lastModifiedBy to VSS and, when `now` is given, dcterms:modified. */
export function patchCoreXml(xml: string, now: Date | undefined): string {
  const set = (src: string, tag: string, value: string): string => {
    const re = new RegExp(`<${tag}\\b([^>]*?)(?:/>|>[\\s\\S]*?</${tag}>)`);
    if (re.test(src)) return src.replace(re, (_w, attrs: string) => `<${tag}${attrs}>${value}</${tag}>`);
    return src.replace(/<\/cp:coreProperties>\s*$/, `<${tag}>${value}</${tag}></cp:coreProperties>`);
  };
  let out = set(xml, 'dc:creator', EXPORT_AUTHOR);
  out = set(out, 'cp:lastModifiedBy', EXPORT_AUTHOR);
  if (now) {
    const iso = `${now.toISOString().slice(0, 19)}Z`;
    const re = /<dcterms:modified\b([^>]*?)(?:\/>|>[\s\S]*?<\/dcterms:modified>)/;
    out = re.test(out)
      ? out.replace(re, (_w, attrs: string) => `<dcterms:modified${attrs}>${iso}</dcterms:modified>`)
      : out.replace(
          /<\/cp:coreProperties>\s*$/,
          `<dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified></cp:coreProperties>`,
        );
  }
  return out;
}

/** Shared-string indices referenced by t="s" cells of a worksheet fragment. */
function referencedStrings(xml: string, into: Set<number>): void {
  const re = /<c\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m[2] === '/') continue;
    const end = xml.indexOf('</c>', re.lastIndex);
    if (end < 0) break;
    const body = xml.slice(re.lastIndex, end);
    re.lastIndex = end + 4;
    if (!/\st="s"/.test(m[1] as string)) continue;
    const v = /<v>\s*(\d+)\s*<\/v>/.exec(body);
    if (v) into.add(Number(v[1]));
  }
}

function countStringCells(xml: string): number {
  return (xml.match(/<c\b[^>]*?\st="s"/g) ?? []).length;
}

/**
 * Shared strings for filter-original: entries still referenced (by the other sheets and the Data sheet's structural
 * rows) keep their index and their XML verbatim; entries that only served the dropped data rows are blanked so the
 * excluded rows' text does not travel in the file. New strings are appended.
 */
class ScrubbedStrings {
  private readonly items: string[] = [];
  private readonly index = new Map<string, number>();
  private readonly head: string;

  constructor(xml: string, keep: ReadonlySet<number>) {
    const open = /<sst\b[^>]*>/.exec(xml);
    if (!open) throw new Error('sharedStrings part is not a well-formed <sst> element');
    this.head = xml.slice(0, open.index + open[0].length);
    const table = new SharedStringsTable(xml);
    const re = /<si\b[^>]*?(?:\/>|>[\s\S]*?<\/si>)/g;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(xml)) !== null) {
      if (keep.has(i)) {
        this.items.push(m[0]);
        const text = table.get(i) ?? '';
        if (!this.index.has(text)) this.index.set(text, i);
      } else {
        this.items.push('<si><t/></si>');
      }
      i += 1;
    }
    while (this.items.length > 0 && !keep.has(this.items.length - 1)) this.items.pop();
  }

  add(text: string): number {
    const clean = stripInvalidXmlChars(text);
    const hit = this.index.get(clean);
    if (hit !== undefined) return hit;
    const i = this.items.length;
    this.items.push(`<si><t xml:space="preserve">${escapeXmlText(encodeExcelEscapes(clean))}</t></si>`);
    this.index.set(clean, i);
    return i;
  }

  serialize(refCount: number): string {
    let head = this.head;
    head = setXmlAttr(head, 'sst', 'count', String(refCount));
    head = setXmlAttr(head, 'sst', 'uniqueCount', String(this.items.length));
    return `${head}${this.items.join('')}</sst>`;
  }
}

function setXmlAttr(xml: string, tag: string, attr: string, value: string): string {
  return xml.replace(new RegExp(`<${tag}\\b[^>]*>`), (open) => {
    const re = new RegExp(`(\\s${attr}\\s*=\\s*)(?:"[^"]*"|'[^']*')`);
    return re.test(open) ? open.replace(re, `$1"${value}"`) : open.replace(/\s*(\/?)>$/, ` ${attr}="${value}"$1>`);
  });
}

// ---- the build -------------------------------------------------------------------------------------------------

class ExportBaseError extends Error {}

interface BaseFile {
  pkg: OoxmlPackage;
  info: WorkbookInfo;
  dataPath: string;
  sstPath: string;
  layout: SourceSheetLayout;
  reference: ReferenceData;
  /** Parts the whitelist removed from the source (known metadata / decoration). */
  removed: string[];
  templateVersion: string;
  instructionsVersion: string | null;
}

const listParts = (names: readonly string[]): string =>
  names.length <= 4 ? names.join(', ') : `${names.slice(0, 4).join(', ')} and ${names.length - 4} more`;

/**
 * Opens a base workbook, applies the package whitelist (F-05) and checks it is the known template. Throws
 * ExportBaseError with a reason otherwise.
 */
function openBase(bytes: Uint8Array): BaseFile {
  const opened = openWorkbook(bytes);
  if (!opened.ok) throw new ExportBaseError(`not a valid .xlsx (${opened.reason})`);
  const parsed = parseInvestc(bytes);
  const errors = parsed.issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) throw new ExportBaseError(`structure not recognised (${errors[0]?.code})`);
  if (parsed.templateVersion === null || !KNOWN_TEMPLATE_VERSIONS.includes(parsed.templateVersion)) {
    throw new ExportBaseError(`template version ${parsed.templateVersion ?? 'unknown'} is not a known version`);
  }
  const clean = sanitizeInvestcPackage(opened.pkg, expectedSheetPaths(opened.info.sheets));
  if (clean.unknown.length > 0) {
    throw new ExportBaseError(`it contains parts VSS does not carry over: ${listParts(clean.unknown)}`);
  }
  const pkg = clean.pkg;
  const info = readWorkbookInfo(pkg);
  const { separatorRow: sep, individualsHeaderRow: hdr } = parsed.layout;
  if (sep === null || hdr === null) throw new ExportBaseError('separator or individuals header row not found');
  const dataPath = info.sheets.find((s) => s.name === SHEET_DATA)?.path ?? null;
  if (dataPath === null || !pkg.parts.has(dataPath)) throw new ExportBaseError('Data sheet part not found');
  const sstPath = info.sharedStringsPath ?? 'xl/sharedStrings.xml';
  if (!pkg.parts.has(sstPath)) throw new ExportBaseError('shared strings part not found');
  return {
    pkg,
    info,
    dataPath,
    sstPath,
    layout: { sep, hdr },
    reference: parsed.reference,
    removed: clean.removed,
    templateVersion: parsed.templateVersion,
    instructionsVersion: parsed.instructionsVersion,
  };
}

interface Selection {
  units: ObservedUnit[];
  people: ObservedPerson[];
}

/** X-07: units referenced by the supplied people, in supplied order, first of any duplicate name. */
function select(
  units: readonly ObservedUnit[],
  people: readonly ObservedPerson[],
  issues: ValidationIssue[],
): Selection {
  const used = new Set(people.map((p) => normalizeUnitName(p.unitName)).filter((k) => k !== ''));
  const written = new Set<string>();
  const out: ObservedUnit[] = [];
  for (const u of units) {
    const key = normalizeUnitName(u.name);
    if (!used.has(key)) continue;
    if (written.has(key)) {
      issues.push(
        issue('UNIT_DUPLICATE', 'warning', u.rowRef, 'name', `Unit "${key}" was supplied twice; written once.`),
      );
      continue;
    }
    written.add(key);
    out.push(u);
  }
  for (const p of people) {
    const key = normalizeUnitName(p.unitName);
    if (key !== '' && !written.has(key)) {
      issues.push(
        issue('UNIT_NOT_DECLARED', 'warning', p.rowRef, 'unitName', `Unit "${key}" is not among the exported units.`),
      );
    }
  }
  return { units: out, people: [...people] };
}

function build(
  base: BaseFile,
  mode: ExportMode,
  sel: Selection,
  now: Date | undefined,
  issues: ValidationIssue[],
): Uint8Array {
  const { pkg, dataPath, sstPath, layout } = base;
  const sheetXml = partText(pkg, dataPath) as string;
  const stylesXml = partText(pkg, stylesPath(pkg));
  const dobStyle = findDobStyle(sheetXml, stylesXml, layout.hdr);
  if (dobStyle === null) throw new UnsupportedSheetError('no date style found for the DOB column');
  const v = vocab(base.reference);
  const unitRows = sel.units.map((u) => unitRow(u, v, issues));
  const personRows = sel.people.map((p) => personRow(p, v, issues));

  const worksheetPaths = base.info.sheets.map((s) => s.path).filter((p): p is string => p !== null);
  const sstXml = partText(pkg, sstPath) as string;
  let strings: { add(s: string): number; serialize(count: number): string };
  if (mode === 'regenerate') {
    const t = new SharedStringsTable(sstXml);
    strings = { add: (s) => t.add(s), serialize: (c) => t.serialize(c) };
  } else {
    const keep = new Set<number>();
    for (const p of worksheetPaths) if (p !== dataPath) referencedStrings(partText(pkg, p) ?? '', keep);
    const parts = splitSheet(sheetXml);
    for (const [r, x] of parts.rows) if (r < 4 || (r >= layout.sep && r <= layout.hdr)) referencedStrings(x, keep);
    strings = new ScrubbedStrings(sstXml, keep);
  }

  const res = rewriteDataSheet({
    sheetXml,
    source: layout,
    units: unitRows,
    people: personRows,
    personStyleOverride: new Map([[P.dob, dobStyle]]),
    str: (s) => strings.add(s),
  });
  for (const ref of res.droppedMerges) {
    issues.push(issue('HEADER_MISMATCH', 'info', null, ref, `Merged cells ${ref} inside the data rows were not kept.`));
  }

  const patcher = new WorkbookPatcher(pkg);
  patcher.replacePart(dataPath, res.xml);
  let refCount = countStringCells(res.xml);
  for (const p of worksheetPaths) if (p !== dataPath) refCount += countStringCells(partText(pkg, p) ?? '');
  patcher.replacePart(sstPath, strings.serialize(refCount));

  const core = corePath(pkg);
  if (core !== null) {
    const xml = partText(pkg, core);
    if (xml !== null) {
      const next = patchCoreXml(xml, now);
      if (next !== xml) patcher.replacePart(core, next);
    }
  }
  return patcher.toBytes();
}

/** Exports an INVESTc request workbook holding exactly the supplied (pre-filtered) units and people. */
export function exportInvestc(input: ExportInput): ExportResult {
  const issues: ValidationIssue[] = [];
  const sel = select(input.units, input.people, issues);
  const regenerate = (whyNeeded: string | null): Uint8Array => {
    if (!input.template) throw new TemplateMissingError(whyNeeded);
    let base: BaseFile;
    try {
      base = openBase(input.template);
    } catch (e) {
      throw new Error(`export template unusable: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    return build(base, 'regenerate', sel, input.now, issues);
  };

  let bytes: Uint8Array | null = null;
  let modeUsed: ExportMode = 'regenerate';
  let reason: string | null = null;
  if (input.mode === 'filter-original') {
    const rowIssues: ValidationIssue[] = [];
    if (!input.source) {
      reason = 'no original workbook was supplied';
    } else {
      try {
        const base = openBase(input.source);
        bytes = build(base, 'filter-original', sel, input.now, rowIssues);
        if (base.removed.length > 0) {
          rowIssues.push(
            issue(
              'TEMPLATE_VERSION_UNKNOWN',
              'info',
              null,
              null,
              `${base.removed.length} part(s) of the original workbook that can hold other information (comments, custom XML, pictures, printer settings, document properties) were not carried over.`,
            ),
          );
        }
        modeUsed = 'filter-original';
      } catch (e) {
        if (!(e instanceof ExportBaseError) && !(e instanceof UnsupportedSheetError)) throw e;
        reason = e.message;
      }
    }
    if (bytes === null) {
      issues.push(
        issue(
          'TEMPLATE_VERSION_UNKNOWN',
          'info',
          null,
          null,
          `The original workbook could not be filtered (${reason}); a fresh workbook was generated from the vault template instead.`,
        ),
      );
    } else {
      issues.push(...rowIssues);
    }
  }
  if (bytes === null) bytes = regenerate(input.mode === 'filter-original' ? reason : null);

  // X-01 self-check: the output must parse cleanly.
  const check = parseInvestc(bytes);
  for (const i of check.issues) {
    if (i.severity === 'error')
      issues.push(issue(i.code, 'error', i.rowRef, i.field, `Export self-check: ${i.message}`));
  }
  return { bytes, issues, stats: { units: sel.units.length, people: sel.people.length }, modeUsed };
}

export interface ExtractedTemplate {
  bytes: Uint8Array;
  templateVersion: string;
  instructionsVersion: string | null;
  /** Parts the whitelist removed. */
  removed: string[];
}

/**
 * Turns any INVESTc workbook of a known version (a blank one or a filled-in request) into a blank template for the
 * vault: the package whitelist is applied, every unit and individual row is removed, the shared string table is
 * rebuilt from the strings still referenced, and the document properties are reset to the safe set (author VSS).
 * Throws Error with a user-facing reason when the file cannot serve as a template.
 */
export function extractBlankTemplate(bytes: Uint8Array, now?: Date): ExtractedTemplate {
  const fail = (e: unknown): never => {
    throw new Error(`This workbook cannot be used as a template: ${e instanceof Error ? e.message : String(e)}.`, {
      cause: e,
    });
  };
  let base: BaseFile | null = null;
  let out: Uint8Array | null = null;
  try {
    base = openBase(bytes);
    out = build(base, 'filter-original', { units: [], people: [] }, now, []);
  } catch (e) {
    fail(e);
  }
  const b = base as BaseFile;
  return {
    bytes: compactSharedStrings(out as Uint8Array),
    templateVersion: b.templateVersion,
    instructionsVersion: b.instructionsVersion,
    removed: b.removed,
  };
}

/** Rewrites the shared string table without unreferenced (blanked) entries; indices of every sheet are remapped. */
function compactSharedStrings(bytes: Uint8Array): Uint8Array {
  const opened = openWorkbook(bytes);
  if (!opened.ok) return bytes;
  const { pkg, info } = opened;
  const sstPath = info.sharedStringsPath ?? 'xl/sharedStrings.xml';
  const sstXml = partText(pkg, sstPath);
  if (sstXml === null) return bytes;
  const items: string[] = [];
  const re = /<si\b[^>]*?(?:\/>|>[\s\S]*?<\/si>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sstXml)) !== null) items.push(m[0]);
  const used = new Set<number>();
  const sheetPaths = info.sheets.map((s) => s.path).filter((p): p is string => p !== null && pkg.parts.has(p));
  for (const p of sheetPaths) referencedStrings(partText(pkg, p) ?? '', used);
  const order = [...used].filter((i) => i < items.length).sort((a, b) => a - b);
  const remap = new Map(order.map((old, i) => [old, i]));
  const patcher = new WorkbookPatcher(pkg);
  let refCount = 0;
  for (const p of sheetPaths) {
    const xml = partText(pkg, p) as string;
    const next = xml.replace(/(<c\b[^>]*?\st="s"[^>]*?>)<v>\s*(\d+)\s*<\/v>/g, (_w, open: string, idx: string) => {
      refCount += 1;
      return `${open}<v>${remap.get(Number(idx)) ?? 0}</v>`;
    });
    if (next !== xml) patcher.replacePart(p, next);
  }
  let head = /^[\s\S]*?<sst\b[^>]*>/.exec(sstXml)?.[0] ?? '<sst>';
  head = setXmlAttr(head, 'sst', 'count', String(refCount));
  head = setXmlAttr(head, 'sst', 'uniqueCount', String(order.length));
  patcher.replacePart(sstPath, `${head}${order.map((i) => items[i]).join('')}</sst>`);
  return patcher.toBytes();
}

/** `INVESTc_<slug>_<YYYY-MM-DD>.xlsx`; the date is the local calendar date of `date`. */
export function suggestExportFilename(eventName: string, date: Date): string {
  const cleaned = cleanExportText(eventName)
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  const slug = Array.from(cleaned).slice(0, 60).join('').replace(/-+$/g, '') || 'request';
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `INVESTc_${slug}_${y}-${m}-${d}.xlsx`;
}
