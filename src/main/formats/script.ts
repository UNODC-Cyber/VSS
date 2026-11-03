import type { Script } from '../../shared/domain/types.ts';

const SCRIPT_TESTS: readonly [Exclude<Script, 'Other' | 'Mixed'>, RegExp][] = [
  ['Latn', /\p{Script=Latin}/u],
  ['Thai', /\p{Script=Thai}/u],
  ['Khmr', /\p{Script=Khmer}/u],
  ['Laoo', /\p{Script=Lao}/u],
  ['Mymr', /\p{Script=Myanmar}/u],
  ['Hani', /\p{Script=Han}/u],
];

/** Dominant script of a name: one script, 'Mixed' when letters of several scripts occur, 'Other' otherwise. */
export function detectScript(text: string): Script {
  const found = new Set<Script>();
  let otherLetters = false;
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue;
    const hit = SCRIPT_TESTS.find(([, re]) => re.test(ch));
    if (hit) found.add(hit[0]);
    else otherLetters = true;
  }
  if (found.size === 0) return 'Other';
  if (found.size > 1 || otherLetters) return 'Mixed';
  return [...found][0] as Script;
}
