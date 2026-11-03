import { readFileSync } from 'node:fs';
import { WorkbookPatcher, decodeUtf8 } from '../../../src/main/formats/ooxml/index.ts';
import { generateBlankTemplate } from '../../../tools/fixtures/investc-workbook.ts';

const root = new URL('../../../fixtures/', import.meta.url);

export const fixtureBytes = (rel: string): Uint8Array => new Uint8Array(readFileSync(new URL(rel, root)));
export const fixtureJson = <T = unknown>(rel: string): T => JSON.parse(readFileSync(new URL(rel, root), 'utf8')) as T;
/** The test-only blank workbook written from scratch by tools/fixtures/investc-workbook.ts. */
export const TEMPLATE = (): Uint8Array => generateBlankTemplate();

/** Applies a text transform to one part and returns the new workbook bytes. */
export function mutatePart(bytes: Uint8Array, part: string, fn: (xml: string) => string): Uint8Array {
  const p = WorkbookPatcher.fromBytes(bytes);
  const before = decodeUtf8(p.get(part) as Uint8Array);
  const after = fn(before);
  if (after === before) throw new Error(`mutation of ${part} changed nothing`);
  p.replacePart(part, after);
  return p.toBytes();
}

export interface IssueLike {
  rule?: string;
  code: string;
  severity: string;
  rowRef: string | null;
  field: string | null;
}

/** Comparable projection of issues: rule, code, severity, row, field; sorted. */
export function project(issues: readonly IssueLike[]): string[] {
  return issues.map((i) => `${i.rule ?? ''}|${i.code}|${i.severity}|${i.rowRef ?? ''}|${i.field ?? ''}`).sort();
}

/** Replaces the text of one shared string (the sst items are `<t>` or `<t xml:space="preserve">`). */
export function replaceSharedString(xml: string, from: string, to: string): string {
  return xml.replace(`>${from}</t>`, `>${to}</t>`);
}
