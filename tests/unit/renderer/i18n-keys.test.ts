/**
 * The English catalogue is assembled from one file per lane (docs/PLAN-ALPHA.md section 16). A top-level key in two
 * parts would be overwritten silently by the spread in locales/en.ts, so duplicates fail here.
 */
import { describe, expect, it } from 'vitest';
import { en, enParts } from '../../../src/renderer/src/locales/en';

function leafPaths(o: unknown, prefix = ''): string[] {
  if (typeof o !== 'object' || o === null) return [prefix];
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => leafPaths(v, prefix ? `${prefix}.${k}` : k));
}

describe('i18n catalogue parts', () => {
  it('no top-level key is defined by two parts', () => {
    const owner = new Map<string, string>();
    const dupes: string[] = [];
    for (const [part, strings] of Object.entries(enParts)) {
      for (const key of Object.keys(strings)) {
        const prev = owner.get(key);
        if (prev) dupes.push(`${key} (${prev}, ${part})`);
        else owner.set(key, part);
      }
    }
    expect(dupes).toEqual([]);
  });

  it('no leaf key is defined by two parts, and en holds every leaf of every part', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    let total = 0;
    for (const strings of Object.values(enParts)) {
      for (const p of leafPaths(strings)) {
        if (p === '') continue;
        total++;
        if (seen.has(p)) dupes.push(p);
        seen.add(p);
      }
    }
    expect(dupes).toEqual([]);
    expect(leafPaths(en).length).toBe(total);
  });

  it('every lane has its own part', () => {
    expect(Object.keys(enParts).sort()).toEqual(
      [
        'alpha',
        'authority',
        'base',
        'crash',
        'danger',
        'emailTemplates',
        'lifecycle',
        'picker',
        'requestors',
        'ui',
        'wizard',
      ].sort(),
    );
  });
});
