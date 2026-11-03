/** Name configuration: shipped JSON defaults, compiled into lookup sets. Callers may build their own via createNameConfig. */
import honorifics from './config/honorifics.json';
import particles from './config/particles.json';
import variants from './config/variants.json';
import { foldToken } from './normalize';

export interface NameConfigSource {
  /** Titles/ranks never part of a name: removed from core and full tokens. */
  strip: readonly string[];
  /** Titles that are also real name tokens: removed from core, kept as particles. */
  ambiguous: readonly string[];
  particles: readonly string[];
  /** Pairs of particles a writer may substitute (counted as one particle difference). */
  equivalents: readonly (readonly string[])[];
  variants: readonly { canonical: string; variants: readonly string[] }[];
}

export interface NameConfig {
  readonly strip: ReadonlySet<string>;
  readonly particleLike: ReadonlySet<string>;
  readonly variantOf: ReadonlyMap<string, string>;
  /** particle -> equivalence-group id */
  readonly equivalentGroup: ReadonlyMap<string, number>;
}

export function createNameConfig(src: NameConfigSource): NameConfig {
  const f = (s: string): string => foldToken(s);
  const variantOf = new Map<string, string>();
  for (const g of src.variants) {
    const canonical = f(g.canonical);
    for (const v of g.variants) variantOf.set(f(v), canonical);
  }
  const equivalentGroup = new Map<string, number>();
  src.equivalents.forEach((group, i) => {
    for (const p of group) equivalentGroup.set(f(p), i);
  });
  return {
    strip: new Set(src.strip.map(f)),
    particleLike: new Set([...src.particles.map(f), ...src.ambiguous.map(f)]),
    variantOf,
    equivalentGroup,
  };
}

export const DEFAULT_NAME_CONFIG_SOURCE: NameConfigSource = {
  strip: honorifics.strip,
  ambiguous: honorifics.ambiguous,
  particles: particles.particles,
  equivalents: particles.equivalents,
  variants: variants.groups,
};

export const DEFAULT_NAME_CONFIG: NameConfig = createNameConfig(DEFAULT_NAME_CONFIG_SOURCE);

/** Entries flagged for domain verification in the shipped config (for reporting / UI). */
export const VERIFY_ITEMS: readonly string[] = [
  ...honorifics.verify.map((v) => `honorific:${v}`),
  ...particles.verify.map((v) => `particle:${v}`),
  ...variants.groups.filter((g) => g.verify).map((g) => `variant:${g.canonical}<-${g.variants.join('|')}`),
];
