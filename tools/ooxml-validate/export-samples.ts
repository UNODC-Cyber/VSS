/**
 * Writes the exporter's output for every synthetic request fixture into a folder, for the external validators
 * (X-08: OpenXML SDK, LibreOffice headless). Synthetic data only.
 *
 *   node tools/ooxml-validate/export-samples.ts <out-dir>
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exportInvestc } from '../../src/main/formats/investc/export.ts';
import { parseInvestc } from '../../src/main/formats/investc/parse.ts';
import { generateBlankTemplate } from '../fixtures/investc-workbook.ts';

const FIXTURE_NOW = new Date('2026-11-03T00:00:00Z');

export interface Sample {
  name: string;
  bytes: Uint8Array;
}

/** Full selection in both modes, a subset (first unit's people) in both modes, and an empty export. */
export function buildSamples(requestsDir: string): Sample[] {
  const out: Sample[] = [];
  const files = readdirSync(requestsDir)
    .filter((f) => /^req-.*\.xlsx$/.test(f))
    .sort();
  for (const f of files) {
    const id = f.replace(/\.xlsx$/, '');
    const source = new Uint8Array(readFileSync(join(requestsDir, f)));
    const parsed = parseInvestc(source);
    for (const mode of ['regenerate', 'filter-original'] as const) {
      const full = exportInvestc({
        mode,
        template: generateBlankTemplate(),
        source,
        units: parsed.units,
        people: parsed.people,
        now: FIXTURE_NOW,
      });
      out.push({ name: `${id}.${mode}.full.xlsx`, bytes: full.bytes });
      const firstUnit = parsed.people[0]?.unitName;
      const subset = parsed.people.filter((p) => p.unitName === firstUnit);
      const sub = exportInvestc({
        mode,
        template: generateBlankTemplate(),
        source,
        units: parsed.units,
        people: subset,
        now: FIXTURE_NOW,
      });
      out.push({ name: `${id}.${mode}.subset.xlsx`, bytes: sub.bytes });
    }
  }
  out.push({
    name: 'empty.regenerate.xlsx',
    bytes: exportInvestc({ mode: 'regenerate', template: generateBlankTemplate(), units: [], people: [] }).bytes,
  });
  return out;
}

export function writeSamples(outDir: string): string[] {
  const requests = fileURLToPath(new URL('../../fixtures/requests/', import.meta.url));
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const s of buildSamples(requests)) {
    const p = join(outDir, s.name);
    writeFileSync(p, s.bytes);
    written.push(p);
  }
  return written;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node tools/ooxml-validate/export-samples.ts <out-dir>');
    process.exit(2);
  }
  const files = writeSamples(resolve(dir));
  console.log(`wrote ${files.length} sample workbooks to ${resolve(dir)}`);
}
