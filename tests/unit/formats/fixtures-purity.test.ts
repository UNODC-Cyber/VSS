import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WorkbookPatcher, decodeUtf8 } from '../../../src/main/formats/ooxml/index.ts';
import { FIXTURES_DIR, generateFixtures } from '../../../tools/fixtures/generate.ts';
import { blankStrings } from '../../../tools/fixtures/investc-workbook.ts';
import { checkPurity, checkWorkbook } from '../../../tools/fixtures/purity-check.ts';
import { buildResponseWorkbook } from '../../../tools/fixtures/response-builder.ts';
import { TEMPLATE } from './helpers.ts';

const allowlist = new Set<string>(
  (
    JSON.parse(readFileSync(new URL('../../../fixtures/purity-allowlist.json', import.meta.url), 'utf8')) as {
      strings: string[];
    }
  ).strings,
);

describe('fixture purity gate', () => {
  it('every committed workbook passes (strings allowlisted or generator-produced, metadata clean)', () => {
    expect(checkPurity()).toEqual([]);
  });

  it('committed fixtures are exactly what the generator produces (deterministic, seeded)', () => {
    const { files } = generateFixtures();
    expect(files.length).toBe(27);
    for (const f of files) {
      const onDisk = readFileSync(`${FIXTURES_DIR}/${f.path}`);
      const want = typeof f.data === 'string' ? Buffer.from(f.data, 'utf8') : Buffer.from(f.data);
      expect(Buffer.compare(onDisk, want), `${f.path} is stale: run node tools/fixtures/generate.ts`).toBe(0);
    }
    const again = generateFixtures();
    expect(again.files.map((f) => f.path)).toEqual(files.map((f) => f.path));
  });

  it('the gate rejects a string that is neither allowlisted nor generated', () => {
    const built = buildResponseWorkbook({
      line1: 'Final Results as of 1/1/2026',
      line2: 'Post: Somewhere Real',
      line3: 'Batch ID: SYNTH-0000000001',
      line4: 'Assistance: x',
      sections: [],
    });
    expect(checkWorkbook('x.xlsx', built.bytes, allowlist, built.strings)).toEqual([]);
    const v = checkWorkbook('x.xlsx', built.bytes, allowlist, new Set());
    expect(v.some((x) => x.kind === 'string' && x.detail.includes('Somewhere Real'))).toBe(true);
  });

  it('the gate rejects personal metadata and private parts', () => {
    const p = WorkbookPatcher.fromBytes(TEMPLATE());
    p.addPart('customXml/item1.xml', '<x/>');
    p.addPart('docMetadata/LabelInfo.xml', '<x/>');
    p.addPart('xl/printerSettings/printerSettings1.bin', new Uint8Array([1]));
    const core = decodeUtf8(p.get('docProps/core.xml') as Uint8Array).replace(
      '<dc:creator>VSS</dc:creator>',
      '<dc:creator>Some Person</dc:creator>',
    );
    p.replacePart('docProps/core.xml', core);
    const wb = decodeUtf8(p.get('xl/workbook.xml') as Uint8Array).replace(
      '<bookViews>',
      '<x15ac:absPath url="C:\\Users\\x"/><bookViews>',
    );
    p.replacePart('xl/workbook.xml', wb);
    const v = checkWorkbook('t.xlsx', p.toBytes(), allowlist, new Set());
    const kinds = v.map((x) => `${x.kind}:${x.detail}`);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'part:forbidden part customXml/item1.xml',
        'part:forbidden part docMetadata/LabelInfo.xml',
        'part:forbidden part xl/printerSettings/printerSettings1.bin',
        'metadata:workbook.xml carries an absPath',
        'metadata:dc:creator is not "VSS"',
      ]),
    );
  });

  it('the generated blank workbook is clean and the allowlist is exactly its strings', () => {
    const bytes = TEMPLATE();
    expect(checkWorkbook('template', bytes, allowlist, new Set())).toEqual([]);
    expect([...allowlist].sort()).toEqual(blankStrings());
    const names = new WorkbookPatcher(WorkbookPatcher.fromBytes(bytes).toPackage()).partNames();
    expect(names.some((n) => /customXml|docMetadata|printerSettings|drawings|media/.test(n))).toBe(false);
  });

  it('only xlsx, expected json, the allowlist, READMEs and the demo manifest live under fixtures/ (no template folder)', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(`${dir}/${e.name}`).map((x) => `${e.name}/${x}`) : [e.name],
      );
    for (const f of walk(FIXTURES_DIR)) {
      expect(f, f).toMatch(
        /\.(xlsx|expected\.json)$|^purity-allowlist\.json$|^(demo\/)?README\.md$|^demo\/manifest\.json$/,
      );
    }
  });
});
