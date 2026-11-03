import type { ObservedPerson, ObservedUnit } from '../../../src/shared/domain/types.ts';
import { decodeUtf8, equalBytes, readZip } from '../../../src/main/formats/ooxml/index.ts';

/** Semantic projection of parsed rows: row references dropped (they move), DOB compared by its parsed date. */
export function semanticUnits(units: readonly ObservedUnit[]): Omit<ObservedUnit, 'rowRef'>[] {
  return units.map(({ rowRef: _r, ...u }) => u);
}

export function semanticPeople(people: readonly ObservedPerson[]): Record<string, unknown>[] {
  return people.map(({ rowRef: _r, dob, ...p }) => ({ ...p, dob: dob.parsed ?? dob.value }));
}

export function parts(bytes: Uint8Array): Map<string, Uint8Array> {
  return readZip(bytes).parts;
}

export function partXml(bytes: Uint8Array, name: string): string {
  const p = parts(bytes).get(name);
  if (!p) throw new Error(`no part ${name}`);
  return decodeUtf8(p);
}

/** Part names whose bytes differ between two packages (including parts present in only one). */
export function changedParts(a: Uint8Array, b: Uint8Array): string[] {
  const pa = parts(a);
  const pb = parts(b);
  const names = new Set([...pa.keys(), ...pb.keys()]);
  return [...names]
    .filter((n) => {
      const x = pa.get(n);
      const y = pb.get(n);
      return !x || !y || !equalBytes(x, y);
    })
    .sort();
}
