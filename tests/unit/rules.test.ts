import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RULES, RULE_IDS } from '@shared/formats/rules';

const doc = readFileSync(new URL('../../docs/FILE-FORMATS.md', import.meta.url), 'utf8');

describe('rule registry', () => {
  it('every registered id appears in docs/FILE-FORMATS.md', () => {
    for (const id of RULE_IDS) expect(doc, id).toContain(id);
  });
  it('every rule id in the document is registered', () => {
    const inDoc = new Set(doc.match(/\b[RXS]-\d{2}\b/g) ?? []);
    expect([...inDoc].sort()).toEqual([...RULE_IDS].sort());
  });
  it('ids are unique and well formed', () => {
    expect(new Set(RULE_IDS).size).toBe(RULE_IDS.length);
    for (const r of RULES) {
      expect(r.id).toMatch(/^[RXS]-\d{2}$/);
      expect(r.description.length).toBeGreaterThan(10);
      expect({ R: 'request', X: 'export', S: 'response' }[r.id[0] as 'R' | 'X' | 'S']).toBe(r.group);
    }
  });
});
