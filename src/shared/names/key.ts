/** NameKey construction (see types.ts). Order-independent: every array in a NameKey is sorted. */
import type { NameKey, PersonName } from '../domain/types';
import { DEFAULT_NAME_CONFIG, type NameConfig } from './config';
import { doubleMetaphone } from './metaphone';
import { detectScript, tokenize } from './normalize';

export type NameInput = string | PersonName | readonly string[];

function rawTokens(input: NameInput): string[] {
  if (typeof input === 'string') return tokenize(input);
  if (Array.isArray(input)) return (input as readonly string[]).flatMap((s) => tokenize(s));
  const n = input as PersonName;
  const surname = isUnknownSurname(n.surname) ? [] : tokenize(n.surname);
  return [...surname, ...n.given.flatMap((g) => tokenize(g))];
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Build the matching key of a name.
 * - variants are canonicalised (mohd -> muhammad), then each token is classified:
 *   strip-honorific (dropped), particle or ambiguous honorific (-> particles), else core.
 * - hyphenated tokens are split into their parts; the joined form (without hyphen) is added to fullTokens only.
 * - if nothing is left in core, particles (then stripped honorifics) are used as core so a name never has an empty key.
 */
export function buildNameKey(input: NameInput, config: NameConfig = DEFAULT_NAME_CONFIG): NameKey {
  const tokens = rawTokens(input);
  const core: string[] = [];
  const particles: string[] = [];
  const stripped: string[] = [];
  const joined: string[] = [];
  const searchable = new Set<string>();

  for (const tok of tokens) {
    const parts = tok.split('-').filter((p) => p !== '');
    if (parts.length > 1) {
      joined.push(parts.join(''));
      searchable.add(parts.join(''));
    }
    for (const p of parts) {
      const c = config.variantOf.get(p) ?? p;
      if (config.strip.has(c)) {
        stripped.push(c);
        continue;
      }
      searchable.add(p);
      searchable.add(c);
      if (config.particleLike.has(c)) particles.push(c);
      else core.push(c);
    }
  }
  if (core.length === 0) {
    if (particles.length > 0) core.push(...particles.splice(0));
    else core.push(...stripped);
    for (const c of core) searchable.add(c);
  }
  core.sort(byCodeUnit);
  particles.sort(byCodeUnit);
  const fullTokens = [...core, ...particles, ...joined].sort(byCodeUnit);
  const phonetic: string[] = [];
  for (const c of core) {
    if (detectScript(c) !== 'Latn') continue;
    const [p] = doubleMetaphone(c);
    if (p !== '') phonetic.push(p);
  }
  phonetic.sort(byCodeUnit);
  return {
    fullTokens,
    coreTokens: core,
    particles,
    phonetic,
    folded: [...searchable].sort(byCodeUnit).join(' '),
  };
}

/** Canonical string of the core multiset; the core_key blocking key. */
export function coreKeyOf(key: NameKey): string {
  return key.coreTokens.join(' ');
}

const UNKNOWN_SURNAMES = new Set(['unknown', 'unk', 'nil', 'none', 'na', 'n/a', 'fnu', 'lnu', 'nfn', 'nln']);

/** True for DC/requestor placeholders used when a surname is not known ("UNKNOWN", "FNU", "LNU"...). */
export function isUnknownSurname(surname: string): boolean {
  const t = tokenize(surname);
  return t.length === 0 || (t.length === 1 && UNKNOWN_SURNAMES.has(t[0] ?? ''));
}

/** Core tokens of a name's surname field; [] when the surname is empty or a placeholder. */
export function surnameCoreTokens(name: PersonName, config: NameConfig = DEFAULT_NAME_CONFIG): string[] {
  if (isUnknownSurname(name.surname)) return [];
  return buildNameKey(name.surname, config).coreTokens;
}
