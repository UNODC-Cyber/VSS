/**
 * Owner-only check (never in CI): when VSS_DEMO_PRIVATE_DIR points at the folder of private example workbooks, every
 * DC response there parses with zero errors and zero warnings, and every request workbook is refused by the response
 * importer with LOOKS_LIKE_REQUEST. Structure-only assertions: no cell value, file name or count is printed on failure
 * beyond issue codes, and nothing is written anywhere (same rules as tests/security/demo-dataset.test.ts).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFinalResults } from '../../../src/main/formats/dc/index.ts';

const PRIVATE_DIR = process.env['VSS_DEMO_PRIVATE_DIR'] ?? '';
const havePrivate = PRIVATE_DIR !== '' && existsSync(PRIVATE_DIR);

describe('private example workbooks (owner machine only)', () => {
  it.skipIf(!havePrivate)('every response parses cleanly and every request is refused plainly', () => {
    const files = readdirSync(PRIVATE_DIR)
      .filter((f) => /\.xlsx$/i.test(f))
      .sort();
    expect(files.length).toBeGreaterThan(0);
    let responses = 0;
    let requests = 0;
    files.forEach((f, i) => {
      const r = parseFinalResults(new Uint8Array(readFileSync(join(PRIVATE_DIR, f))));
      const label = `file #${i + 1}`; // never the file name
      if (r.fileKindGuess === 'investc-request') {
        requests++;
        expect(
          r.issues.map((x) => x.code),
          label,
        ).toEqual(['LOOKS_LIKE_REQUEST']);
        return;
      }
      responses++;
      expect(r.fileKindGuess, label).toBe('dc-response');
      expect(
        r.issues.filter((x) => x.severity !== 'info').map((x) => x.code),
        label,
      ).toEqual([]);
      expect(r.draft.rows.length, label).toBeGreaterThan(0);
      expect(r.draft.batchId, label).not.toBeNull();
      expect(r.draft.resultsAsOf, label).not.toBeNull();
      expect(r.draft.rows.filter((x) => x.dispClass === 'unknown').length, label).toBe(0);
    });
    expect(responses + requests).toBe(files.length);
  });
});
