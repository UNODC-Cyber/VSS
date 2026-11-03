/** Semantic Versioning 2.0.0 parsing and precedence (https://semver.org/spec/v2.0.0.html). Build metadata is ignored. */

export interface SemVer {
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease: readonly string[];
  build: readonly string[];
  raw: string;
}

const NUM = '0|[1-9]\\d*';
const PRE_ID = `(?:${NUM}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`;
const SEMVER_RE = new RegExp(
  `^(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$`,
);

/** Strict parse (no leading "v", no whitespace). Returns null when invalid. */
export function parseSemver(raw: string): SemVer | null {
  if (typeof raw !== 'string' || raw.length > 256) return null;
  const m = SEMVER_RE.exec(raw);
  if (!m) return null;
  return {
    major: BigInt(m[1]!),
    minor: BigInt(m[2]!),
    patch: BigInt(m[3]!),
    prerelease: m[4] ? m[4].split('.') : [],
    build: m[5] ? m[5].split('.') : [],
    raw,
  };
}

const isNumeric = (id: string): boolean => /^\d+$/.test(id);

function cmpBig(a: bigint, b: bigint): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpIdent(a: string, b: string): -1 | 0 | 1 {
  const an = isNumeric(a);
  const bn = isNumeric(b);
  if (an && bn) return cmpBig(BigInt(a), BigInt(b));
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SemVer precedence: -1 if a < b, 0 if equal precedence, 1 if a > b. */
export function compareSemver(a: SemVer, b: SemVer): -1 | 0 | 1 {
  const core = cmpBig(a.major, b.major) || cmpBig(a.minor, b.minor) || cmpBig(a.patch, b.patch);
  if (core) return core;
  const ap = a.prerelease;
  const bp = b.prerelease;
  if (ap.length === 0 && bp.length === 0) return 0;
  if (ap.length === 0) return 1;
  if (bp.length === 0) return -1;
  for (let i = 0; i < Math.min(ap.length, bp.length); i++) {
    const c = cmpIdent(ap[i]!, bp[i]!);
    if (c) return c;
  }
  return cmpBig(BigInt(ap.length), BigInt(bp.length));
}

export interface UpgradeOptions {
  /** Accept prerelease candidates. Default false: prereleases are ignored. */
  allowPrerelease?: boolean;
}

/**
 * True only when `candidate` is a valid SemVer strictly greater than `current`. Prerelease candidates are ignored
 * unless `allowPrerelease`. Invalid strings never count as an upgrade.
 */
export function isUpgrade(candidate: string, current: string, opts: UpgradeOptions = {}): boolean {
  const c = parseSemver(candidate);
  const cur = parseSemver(current);
  if (!c || !cur) return false;
  if (c.prerelease.length > 0 && !opts.allowPrerelease) return false;
  return compareSemver(c, cur) > 0;
}
