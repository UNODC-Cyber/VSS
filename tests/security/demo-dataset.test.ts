/**
 * Guard for the synthetic demo dataset (fixtures/demo/, written by tools/fixtures/demo-dataset.ts).
 *
 * 1. Deterministic: two in-memory runs are byte-identical and equal the committed files.
 * 2. The workbooks re-parse with the repository parsers and give the counts the manifest states.
 * 3. The real import flow (encrypted temp DB, services) gives the matched / unanswered / unidentified / review counts
 *    of the manifest for both request/response pairs.
 * 4. Privacy: when the owner points VSS_DEMO_PRIVATE_DIR at a folder of private example workbooks (never in CI), every
 *    name token, date of birth, document number, unit name and event / place string of those files is hashed in memory
 *    and compared with the hashes of everything in the demo dataset. Nothing private is stored in this test, printed on
 *    failure (only categories and hash prefixes are reported) or written anywhere.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseFinalResults } from '../../src/main/formats/dc/parse';
import { parseInvestc } from '../../src/main/formats/investc/parse';
import { validateRequest } from '../../src/main/formats/investc/validate';
import { BUNDLED_COUNTRIES_POB, BUNDLED_COUNTRIES_UNIT } from '../../src/main/formats/investc/bundled-reference';
import { NAME_PARTICLES } from '../../src/main/formats/investc/names';
import { serialToIso } from '../../src/main/formats/ooxml/dates';
import { loadSharedStrings, loadSheet, openWorkbook } from '../../src/main/formats/ooxml/workbook';
import { DEMO_DIR, DEMO_FILES, generateDemoDataset } from '../../tools/fixtures/demo-dataset.ts';
import { harness, once, unwrap, type Harness } from '../unit/services/helpers';

const demo = generateDemoDataset();
const { manifest } = demo;
const fileBytes = (name: string): Uint8Array => {
  const f = demo.files.find((x) => x.path === `demo/${name}`);
  if (!f || typeof f.data === 'string') throw new Error(`no workbook ${name}`);
  return f.data;
};

describe('demo dataset: determinism', () => {
  it('two runs are byte-identical and equal the committed files', () => {
    const again = generateDemoDataset();
    expect(again.files.map((f) => f.path)).toEqual(demo.files.map((f) => f.path));
    for (const [i, f] of demo.files.entries()) {
      const a = typeof f.data === 'string' ? Buffer.from(f.data) : Buffer.from(f.data);
      const g = again.files[i]!.data;
      expect(Buffer.compare(a, typeof g === 'string' ? Buffer.from(g) : Buffer.from(g))).toBe(0);
      const onDisk = readFileSync(resolve(DEMO_DIR, '..', f.path));
      expect(Buffer.compare(onDisk, a), `${f.path} is stale: run npm run fixtures:demo`).toBe(0);
    }
    expect(demo.files).toHaveLength(5);
  });
});

describe('demo dataset: parsers', () => {
  it.each([
    [DEMO_FILES.request1, 0],
    [DEMO_FILES.request2, 1],
  ])('%s parses without errors and has the manifest counts', (name, pairIndex) => {
    const pair = manifest.pairs[pairIndex]!;
    const parsed = parseInvestc(fileBytes(name));
    expect(parsed.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(parsed.units).toHaveLength(pair.counts.requestUnits);
    expect(parsed.people).toHaveLength(pair.counts.requestPeople);
    const issues = validateRequest(parsed, null, new Date('2026-11-04T00:00:00Z'));
    // Nobody is marked head of unit, exactly as in the source exchange: one warning per unit and nothing else.
    expect(issues.map((i) => i.code)).toEqual(Array(pair.counts.requestUnits).fill('HEAD_OF_UNIT_NONE'));
    const rows = manifest.people.filter((p) => p.request === name).map((p) => p.requestRow);
    expect(parsed.people.map((p) => p.rowRef)).toEqual(rows);
  });

  it.each([
    [DEMO_FILES.response1, 0],
    [DEMO_FILES.response2, 1],
  ])('%s parses (not blocked) with the manifest sections and rows', (name, pairIndex) => {
    const pair = manifest.pairs[pairIndex]!;
    const r = parseFinalResults(fileBytes(name));
    expect(r.blocked).toBe(false);
    expect(r.draft.batchId).toBe(pair.batchId);
    const units = r.draft.rows.filter((x) => x.section === 'approved-unit');
    const people = r.draft.rows.filter((x) => x.section === 'approved-individual');
    expect(units).toHaveLength(pair.counts.responseUnitRows);
    expect(people).toHaveLength(pair.counts.responseIndividualRows);
    expect(r.draft.rows.filter((x) => x.section.startsWith('nonapproved'))).toEqual([]);
    const named = manifest.people.filter((p) => p.response === name).map((p) => p.responseRow);
    for (const ref of named) expect(r.draft.rows.map((x) => x.rowRef)).toContain(ref);
  });
});

describe('demo dataset: import flow outcomes', () => {
  let h: Harness;
  afterEach(() => h?.cleanup());

  it.each([0, 1])('pair %i gives the manifest counts', async (i) => {
    const pair = manifest.pairs[i]!;
    const req = manifest.requests[i]!;
    h = harness('2026-11-04T09:00:00.000Z');
    const p = unwrap(await h.svc.requests.importFile(req.file, fileBytes(req.file)));
    expect(p.items).toHaveLength(pair.counts.requestPeople);
    const s = await once(h, () =>
      h.svc.requests.importCommit({
        previewId: p.previewId,
        requestor: manifest.requestor,
        eventName: req.eventName,
        eventStart: req.eventStart,
        eventEnd: req.eventEnd,
        eventLocation: req.eventLocation,
        notes: '',
      }),
    );
    await once(h, () =>
      h.svc.requests.export({ requestId: s.id, mode: 'filter-original', destPath: `/out/${s.id}.xlsx` }),
    );
    await once(h, () => h.svc.requests.markSentToDc({ id: s.id, at: '2026-11-05T08:00:00.000Z' }));
    h.setNow('2026-11-20T08:00:00.000Z');
    const pv = unwrap(await h.svc.responses.importFile(pair.response, fileBytes(pair.response), s.id));
    expect(pv.canCommit).toBe(true);
    expect(pv.autoMatchedCount).toBe(pair.counts.autoMatched);
    expect(pv.needsReviewCount).toBe(pair.pendingReview.length);
    const individualsUnidentified = manifest.people.filter(
      (x) => pair.unidentified.includes(x.id) && x.responseSection === 'approved-individual',
    ).length;
    expect(pv.unmatchedCount).toBe(individualsUnidentified);
    expect(pv.unansweredItemIds).toHaveLength(pair.counts.unanswered);
    // The rows the matcher links are the invented people the manifest names, by response row.
    const byRow = new Map(pv.rows.map((r) => [r.rowRef, r]));
    for (const id of pair.autoMatched) {
      const ref = manifest.people.find((x) => x.id === id)!.responseRow!;
      expect(byRow.get(ref)?.decision, id).toBe('auto');
    }
    for (const id of pair.pendingReview) {
      const ref = manifest.people.find((x) => x.id === id)!.responseRow!;
      expect(byRow.get(ref)?.decision, id).toBe('pending');
    }
    const out = await once(h, () => h.svc.responses.importCommit({ previewId: pv.previewId, requestId: s.id }));
    expect(out.reviewItemsCreated).toBe(pair.counts.reviewQueue);
    const byKind = Object.fromEntries(Object.entries(h.fx.repos.reviews.counts().byKind).filter(([, n]) => n > 0));
    expect(byKind).toEqual(pair.reviewByKind);
  });
});

// ---- privacy -------------------------------------------------------------------------------------------------------

const PRIVATE_DIR = process.env['VSS_DEMO_PRIVATE_DIR'] ?? '';
const havePrivate = PRIVATE_DIR !== '' && existsSync(PRIVATE_DIR);

const h16 = (s: string): string => createHash('sha256').update(s).digest('hex');
const fold = (s: string): string => s.normalize('NFKC').toLowerCase();
const words = (s: string): string[] => fold(s).match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
const GENERIC = new Set([...NAME_PARTICLES, 'unknown', 'bin', 'binti', 'a', 'l', 'p'].map(fold));
const nameTokens = (s: string): string[] => words(s).filter((t) => t.length >= 3 && !GENERIC.has(t));
/** Country names are reference data (the demo workbooks carry the whole list), never a distinctive phrase. */
const COUNTRIES = new Set([...BUNDLED_COUNTRIES_POB, ...BUNDLED_COUNTRIES_UNIT].map((c) => words(c).join(' ')));
/** Folded word sequence of a phrase (unit, place, event), or null when it is too short or generic to be distinctive. */
const phrase = (s: string): string | null => {
  const t = words(s).join(' ');
  return t.replace(/ /g, '').length >= 3 && !COUNTRIES.has(t) ? t : null;
};
const isoForms = (text: string): string[] => {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(text);
  if (!m) return [];
  const [a, b, y] = [Number(m[1]), Number(m[2]), m[3]];
  const f = (mm: number, dd: number): string => `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  return [f(a, b), f(b, a)];
};

interface Hashes {
  name: Set<string>;
  phrase: Set<string>;
  dob: Set<string>;
  id: Set<string>;
}
const empty = (): Hashes => ({ name: new Set(), phrase: new Set(), dob: new Set(), id: new Set() });

/** Hashes of the sensitive values of one private workbook (request or response); values never leave this function. */
function privateHashes(bytes: Uint8Array, into: Hashes): void {
  const addPhrase = (s: string | null | undefined): void => {
    const p = s ? phrase(s) : null;
    if (p) into.phrase.add(h16(p));
  };
  const req = parseInvestc(bytes);
  if (req.people.length > 0 || req.units.length > 0) {
    for (const u of req.units) [u.name, u.alias, u.location, u.description, u.parentOrg].forEach(addPhrase);
    for (const p of req.people) {
      for (const f of [p.surname, p.name1, p.name2, p.name3, p.name4, p.fatherName, p.motherName])
        nameTokens(f).forEach((t) => into.name.add(h16(t)));
      if (p.dob.parsed) into.dob.add(h16(p.dob.parsed));
      for (const v of [p.passport, p.nationalId]) if (v.trim().length >= 3) into.id.add(h16(fold(v.trim())));
      [p.pobCity, p.pobState, p.unitName].forEach(addPhrase);
    }
    return;
  }
  const resp = parseFinalResults(bytes);
  const d = resp.draft;
  if (d.batchId) into.id.add(h16(fold(d.batchId)));
  addPhrase(d.post);
  for (const part of (d.assistanceLine ?? '').split(/\s+-\s+|,/)) if (!/^\s*[\d/]+\s*$/.test(part)) addPhrase(part);
  for (const r of d.rows) {
    nameTokens(r.nameRaw).forEach((t) => into.name.add(h16(t)));
    isoForms(r.dob.value).forEach((x) => into.dob.add(h16(x)));
    [r.pob.city, r.pob.state, r.unitName].forEach(addPhrase);
  }
}

/** Everything in the demo dataset: word tokens, every word n-gram, and DOB readings of every date-like value. */
function demoHashes(): { tokens: Set<string>; dobs: Set<string> } {
  const tokens = new Set<string>();
  const dobs = new Set<string>();
  const addText = (s: string): void => {
    const t = words(s);
    for (let i = 0; i < t.length; i++) {
      let acc = '';
      for (let n = 0; n < 40 && i + n < t.length; n++) {
        acc = n === 0 ? t[i]! : `${acc} ${t[i + n]!}`;
        tokens.add(h16(acc));
      }
    }
    for (const m of s.matchAll(/\d{1,2}\/\d{1,2}\/\d{4}/g)) isoForms(m[0]).forEach((x) => dobs.add(h16(x)));
    for (const m of s.matchAll(/\d{4}-\d{2}-\d{2}/g)) dobs.add(h16(m[0]));
  };
  for (const f of demo.files) {
    if (typeof f.data === 'string') {
      addText(f.data);
      continue;
    }
    const opened = openWorkbook(f.data);
    if (!opened.ok) throw new Error(`demo workbook ${f.path} does not open`);
    const sst = loadSharedStrings(opened.pkg, opened.info);
    sst.toArray().forEach(addText);
    for (const ref of opened.info.sheets) {
      const sheet = loadSheet(opened.pkg, ref, sst);
      if (!sheet) continue;
      for (const r of sheet.rowNumbers())
        for (const c of sheet.rowCells(r)) {
          if (c.kind === 'string') addText(c.text);
          if (c.kind === 'number' && c.num !== undefined) {
            const iso = serialToIso(c.num);
            if (iso) dobs.add(h16(iso));
          }
        }
    }
  }
  for (const extra of ['README.md']) {
    const p = join(DEMO_DIR, extra);
    if (existsSync(p)) addText(readFileSync(p, 'utf8'));
  }
  addText(readFileSync(new URL('../../tools/fixtures/demo-dataset.ts', import.meta.url), 'utf8'));
  return { tokens, dobs };
}

describe('demo dataset: privacy', () => {
  it('hash helpers see through case, spacing and particles (self-test, made-up values)', () => {
    const into = empty();
    nameTokens('  Zorbiq bin QUANTEL a/p').forEach((t) => into.name.add(h16(t)));
    expect([...into.name].sort()).toEqual([h16('quantel'), h16('zorbiq')].sort());
    expect(isoForms('3/4/1901')).toEqual(['1901-03-04', '1901-04-03']);
    expect(phrase('Example  Unit, Nowhere')).toBe('example unit nowhere');
  });

  it.skipIf(!havePrivate)('no private name, DOB, ID, unit, event or place appears in the demo dataset', () => {
    const priv = empty();
    const files = readdirSync(PRIVATE_DIR).filter((f) => /\.xlsx$/i.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) privateHashes(new Uint8Array(readFileSync(join(PRIVATE_DIR, f))), priv);
    expect(priv.name.size).toBeGreaterThan(0);
    const d = demoHashes();
    const leaks: string[] = [];
    for (const [kind, set] of [
      ['name', priv.name],
      ['phrase', priv.phrase],
      ['id', priv.id],
    ] as const)
      for (const x of set) if (d.tokens.has(x)) leaks.push(`${kind}:${x.slice(0, 10)}`);
    for (const x of priv.dob) if (d.dobs.has(x)) leaks.push(`dob:${x.slice(0, 10)}`);
    expect(leaks).toEqual([]);
  });
});
