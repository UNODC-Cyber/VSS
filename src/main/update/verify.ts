/**
 * Pure verification of signed release manifests (no I/O, no Electron). See docs/RELEASE-RUNBOOK.md.
 *
 * release-manifest.json = canonical JSON of
 *   {formatVersion:2, version, date, notBefore, notAfter, files:[{name, sha512, size}]}.
 * notBefore / notAfter (YYYY-MM-DD, UTC, inclusive) are the signed validity window (security review F-12): an
 * installed app accepts the manifest only inside it, so a captured older release cannot be replayed indefinitely.
 * The window is at most MAX_VALIDITY_DAYS; the maintainer re-signs (new window, same assets) to extend it.
 * release-manifest.sig.ed25519 / release-manifest.sig.mldsa65 = base64 detached signatures over those exact bytes.
 * BOTH signatures must verify, under the SAME trusted key slot (current or next). Only then is the JSON parsed.
 */
import { parseCanonical } from './canonical';
import {
  decodeBase64Strict,
  ED25519_PUBLIC_KEY_BYTES,
  ed25519Verify,
  keyIdOf,
  MLDSA_CONTEXT_MANIFEST,
  MLDSA_CONTEXT_ROTATION,
  MLDSA65_PUBLIC_KEY_BYTES,
  mldsa65Verify,
} from './crypto';
import { isUpgrade, parseSemver } from './semver';

export { compareSemver, isUpgrade, parseSemver } from './semver';
export type { SemVer, UpgradeOptions } from './semver';

export const MANIFEST_FILE = 'release-manifest.json';
export const SIG_ED25519_FILE = 'release-manifest.sig.ed25519';
export const SIG_MLDSA65_FILE = 'release-manifest.sig.mldsa65';
export const MANIFEST_MAX_BYTES = 64 * 1024;
export const SIGNATURE_MAX_BYTES = 8 * 1024;

export interface ManifestFile {
  name: string;
  /** Lowercase hex SHA-512 (128 chars). */
  sha512: string;
  size: number;
}
export interface ReleaseManifest {
  formatVersion: 2;
  version: string;
  /** YYYY-MM-DD (UTC): release / signing date. */
  date: string;
  /** First and last day (YYYY-MM-DD, UTC, inclusive) on which an installed app accepts this manifest. */
  notBefore: string;
  notAfter: string;
  files: ManifestFile[];
}

export const MANIFEST_FORMAT_VERSION = 2;
/** Longest signed validity window (days). Documented in docs/RELEASE-RUNBOOK.md. */
export const MAX_VALIDITY_DAYS = 180;
/** Tolerance for a slightly wrong client clock when checking the window. */
export const VALIDITY_SKEW_MS = 24 * 3600 * 1000;

/** One hybrid public key pair (base64). */
export interface UpdateKeySet {
  id: string;
  ed25519: string;
  mldsa65: string;
  /** True for the TEST/PLACEHOLDER keys shipped in the repo. Release CI refuses to build with these. */
  placeholder?: boolean;
}
export interface TrustedUpdateKeys {
  current: UpdateKeySet;
  /** Pre-distributed successor key (rotation without a signed statement). */
  next: UpdateKeySet | null;
}

export type VerifyFailure =
  | 'MANIFEST_TOO_LARGE'
  | 'SIGNATURE_MISSING'
  | 'SIGNATURE_MALFORMED'
  | 'SIGNATURE_INVALID'
  | 'MANIFEST_NOT_CANONICAL'
  | 'MANIFEST_INVALID'
  | 'VERSION_MISMATCH'
  | 'NOT_NEWER'
  | 'FILE_MISSING'
  | 'SIZE_MISMATCH'
  | 'HASH_MISMATCH'
  | 'KEYS_INVALID'
  | 'MANIFEST_NOT_YET_VALID'
  | 'MANIFEST_EXPIRED';

export type VerifyResult<T> = { ok: true; value: T } | { ok: false; reason: VerifyFailure; message: string };

const fail = (reason: VerifyFailure, message: string): { ok: false; reason: VerifyFailure; message: string } => ({
  ok: false,
  reason,
  message,
});

const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/;
const SHA512_RE = /^[0-9a-f]{128}$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const hasExactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => Object.prototype.hasOwnProperty.call(o, x));
};

/** Structural validation of a parsed manifest. Returns an error message or null. */
const dayMs = (d: string): number => Date.parse(`${d}T00:00:00.000Z`);

export function validateManifest(value: unknown): string | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['date', 'files', 'formatVersion', 'notAfter', 'notBefore', 'version'])
  ) {
    return 'Manifest must have exactly formatVersion, version, date, notBefore, notAfter, files';
  }
  if (value.formatVersion !== MANIFEST_FORMAT_VERSION) return 'Unsupported manifest formatVersion';
  if (typeof value.version !== 'string' || !parseSemver(value.version)) return 'Manifest version is not SemVer 2.0.0';
  if (typeof value.date !== 'string' || !DATE_RE.test(value.date)) return 'Manifest date must be YYYY-MM-DD';
  for (const k of ['notBefore', 'notAfter'] as const) {
    const v = value[k];
    if (typeof v !== 'string' || !DATE_RE.test(v) || !Number.isFinite(dayMs(v)))
      return `Manifest ${k} must be YYYY-MM-DD`;
  }
  const nb = dayMs(value.notBefore as string);
  const na = dayMs(value.notAfter as string);
  if (na < nb) return 'Manifest notAfter is before notBefore';
  if ((na - nb) / 86_400_000 > MAX_VALIDITY_DAYS) return `Manifest validity window exceeds ${MAX_VALIDITY_DAYS} days`;
  if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > 256) {
    return 'Manifest files must be a non-empty list';
  }
  const seen = new Set<string>();
  for (const f of value.files as unknown[]) {
    if (!isPlainObject(f) || !hasExactKeys(f, ['name', 'sha512', 'size'])) return 'Invalid file entry';
    if (typeof f.name !== 'string' || !FILE_NAME_RE.test(f.name) || f.name.includes('..')) return 'Invalid file name';
    if (seen.has(f.name.toLowerCase())) return 'Duplicate file name';
    seen.add(f.name.toLowerCase());
    if (typeof f.sha512 !== 'string' || !SHA512_RE.test(f.sha512)) return 'Invalid sha512';
    if (typeof f.size !== 'number' || !Number.isSafeInteger(f.size) || f.size < 0) return 'Invalid size';
  }
  return null;
}

interface DecodedKeySet {
  id: string;
  ed25519: Uint8Array;
  mldsa65: Uint8Array;
}

/** Decodes a key set and checks that its id matches its key material. */
export function decodeKeySet(k: UpdateKeySet): DecodedKeySet | null {
  const ed = decodeBase64Strict(k.ed25519);
  const pq = decodeBase64Strict(k.mldsa65);
  if (!ed || !pq) return null;
  if (ed.length !== ED25519_PUBLIC_KEY_BYTES || pq.length !== MLDSA65_PUBLIC_KEY_BYTES) return null;
  if (keyIdOf(ed, pq) !== k.id) return null;
  return { id: k.id, ed25519: ed, mldsa65: pq };
}

function decodeSig(sig: Uint8Array | string | null | undefined): Uint8Array | null | 'missing' {
  if (sig === null || sig === undefined) return 'missing';
  if (sig.length === 0) return 'missing';
  if (sig.length > SIGNATURE_MAX_BYTES) return null;
  return decodeBase64Strict(sig);
}

/** Verifies both detached signatures over `message` under the same slot. Returns the matching key id. */
export function verifyHybrid(
  message: Uint8Array,
  sigEd: Uint8Array | string | null | undefined,
  sigPq: Uint8Array | string | null | undefined,
  keys: TrustedUpdateKeys,
  pqContext: Uint8Array,
): VerifyResult<string> {
  const ed = decodeSig(sigEd);
  const pq = decodeSig(sigPq);
  if (ed === 'missing' || pq === 'missing') return fail('SIGNATURE_MISSING', 'Both signatures are required');
  if (!ed || !pq) return fail('SIGNATURE_MALFORMED', 'Signature is not valid base64');
  const slots = [keys.current, keys.next].filter((k): k is UpdateKeySet => k !== null);
  let anyKey = false;
  for (const slot of slots) {
    const k = decodeKeySet(slot);
    if (!k) continue;
    anyKey = true;
    // Evaluate both (no short-circuit) so a failure does not reveal which algorithm rejected first.
    const okEd = ed25519Verify(k.ed25519, message, ed);
    const okPq = mldsa65Verify(k.mldsa65, message, pq, pqContext);
    if (okEd && okPq) return { ok: true, value: k.id };
  }
  if (!anyKey) return fail('KEYS_INVALID', 'No valid trusted update key');
  return fail('SIGNATURE_INVALID', 'Release signature verification failed');
}

/**
 * Verifies the hybrid signatures over the manifest bytes, then parses (canonical form required) and validates it.
 * Signature checks happen BEFORE any parsing of attacker-controlled JSON.
 */
export function verifyManifest(
  manifestBytes: Uint8Array,
  sigEd: Uint8Array | string | null | undefined,
  sigPq: Uint8Array | string | null | undefined,
  keys: TrustedUpdateKeys,
): VerifyResult<{ manifest: ReleaseManifest; keyId: string }> {
  if (manifestBytes.length === 0 || manifestBytes.length > MANIFEST_MAX_BYTES) {
    return fail('MANIFEST_TOO_LARGE', 'Manifest is empty or too large');
  }
  const sig = verifyHybrid(manifestBytes, sigEd, sigPq, keys, MLDSA_CONTEXT_MANIFEST);
  if (!sig.ok) return sig;
  const parsed = parseCanonical(manifestBytes);
  if (parsed === null) return fail('MANIFEST_NOT_CANONICAL', 'Manifest is not canonical JSON');
  const invalid = validateManifest(parsed.value);
  if (invalid) return fail('MANIFEST_INVALID', invalid);
  return { ok: true, value: { manifest: parsed.value as ReleaseManifest, keyId: sig.value } };
}

export interface VersionPolicy {
  /** Running app version. */
  currentVersion: string;
  /** Version announced by the update feed (electron-updater). The manifest must name exactly this version. */
  expectedVersion: string;
  allowPrerelease?: boolean;
}

/** Anti-downgrade / anti-replay: the signed version must equal the offered one and be newer than the running one. */
export function checkManifestVersion(manifest: ReleaseManifest, policy: VersionPolicy): VerifyResult<true> {
  if (manifest.version !== policy.expectedVersion) {
    return fail('VERSION_MISMATCH', 'Signed manifest is for a different version than the one offered');
  }
  if (!isUpgrade(manifest.version, policy.currentVersion, { allowPrerelease: policy.allowPrerelease ?? false })) {
    return fail('NOT_NEWER', 'Signed manifest version is not newer than the installed version');
  }
  return { ok: true, value: true };
}

/**
 * Freshness (F-12): `now` must fall inside the signed window [notBefore 00:00, notAfter 24:00) UTC, with
 * VALIDITY_SKEW_MS of tolerance either side for a slightly wrong clock.
 */
export function checkManifestFreshness(manifest: ReleaseManifest, now: number): VerifyResult<true> {
  const from = dayMs(manifest.notBefore) - VALIDITY_SKEW_MS;
  const until = dayMs(manifest.notAfter) + 86_400_000 + VALIDITY_SKEW_MS;
  if (!Number.isFinite(from) || !Number.isFinite(until)) return fail('MANIFEST_INVALID', 'Invalid validity window');
  if (now < from) return fail('MANIFEST_NOT_YET_VALID', 'Signed manifest is not valid yet (check the clock)');
  if (now >= until) return fail('MANIFEST_EXPIRED', 'Signed manifest has expired; the release must be re-signed');
  return { ok: true, value: true };
}

export function findManifestFile(manifest: ReleaseManifest, name: string): VerifyResult<ManifestFile> {
  const f = manifest.files.find((x) => x.name === name);
  return f ? { ok: true, value: f } : fail('FILE_MISSING', 'Installer is not listed in the signed manifest');
}

/** Compares the measured size and SHA-512 of a file with its manifest entry. */
export function verifyFileHash(entry: ManifestFile, actual: { sha512Hex: string; size: number }): VerifyResult<true> {
  if (actual.size !== entry.size) return fail('SIZE_MISMATCH', 'Downloaded file size does not match the manifest');
  const a = actual.sha512Hex.toLowerCase();
  let diff = a.length ^ entry.sha512.length;
  for (let i = 0; i < Math.min(a.length, entry.sha512.length); i++)
    diff |= a.charCodeAt(i) ^ entry.sha512.charCodeAt(i);
  if (diff !== 0) return fail('HASH_MISMATCH', 'Downloaded file hash does not match the manifest');
  return { ok: true, value: true };
}

// ---------------------------------------------------------------------------------------------------------------
// Signed key rotation (hook). Not yet consumed by the service: a future release may fetch
// `key-rotation.json` + `.sig.ed25519` + `.sig.mldsa65`, verify it here with the CURRENT keys, persist the new key set,
// and use it as `next`. Until then rotation uses the pre-distributed `next` slot (docs/RELEASE-RUNBOOK.md).
// ---------------------------------------------------------------------------------------------------------------

export interface KeyRotationStatement {
  formatVersion: 1;
  purpose: 'vss-key-rotation';
  date: string;
  newKeys: { id: string; ed25519: string; mldsa65: string };
}

/** Verifies a rotation statement signed by BOTH algorithms of a currently trusted slot; returns the new key set. */
export function verifyKeyRotation(
  statementBytes: Uint8Array,
  sigEd: Uint8Array | string | null | undefined,
  sigPq: Uint8Array | string | null | undefined,
  keys: TrustedUpdateKeys,
): VerifyResult<UpdateKeySet> {
  if (statementBytes.length === 0 || statementBytes.length > MANIFEST_MAX_BYTES) {
    return fail('MANIFEST_TOO_LARGE', 'Statement is empty or too large');
  }
  const sig = verifyHybrid(statementBytes, sigEd, sigPq, keys, MLDSA_CONTEXT_ROTATION);
  if (!sig.ok) return sig;
  const v = parseCanonical(statementBytes)?.value ?? null;
  if (v === null) return fail('MANIFEST_NOT_CANONICAL', 'Statement is not canonical JSON');
  if (
    !isPlainObject(v) ||
    !hasExactKeys(v, ['date', 'formatVersion', 'newKeys', 'purpose']) ||
    v.formatVersion !== 1 ||
    v.purpose !== 'vss-key-rotation' ||
    typeof v.date !== 'string' ||
    !DATE_RE.test(v.date) ||
    !isPlainObject(v.newKeys) ||
    !hasExactKeys(v.newKeys, ['ed25519', 'id', 'mldsa65'])
  ) {
    return fail('MANIFEST_INVALID', 'Invalid key rotation statement');
  }
  const nk = v.newKeys as Record<string, unknown>;
  if (typeof nk.id !== 'string' || typeof nk.ed25519 !== 'string' || typeof nk.mldsa65 !== 'string') {
    return fail('MANIFEST_INVALID', 'Invalid key rotation statement');
  }
  const candidate: UpdateKeySet = { id: nk.id, ed25519: nk.ed25519, mldsa65: nk.mldsa65 };
  if (!decodeKeySet(candidate)) return fail('KEYS_INVALID', 'Rotated key set is malformed');
  return { ok: true, value: candidate };
}
