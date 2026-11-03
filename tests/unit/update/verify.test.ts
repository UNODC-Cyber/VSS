import { describe, expect, it } from 'vitest';
import { canonicalBytes } from '../../../src/main/update/canonical';
import {
  encodeBase64,
  ed25519Sign,
  MLDSA_CONTEXT_ROTATION,
  mldsa65Sign,
  sha512Hex,
} from '../../../src/main/update/crypto';
import {
  checkManifestVersion,
  decodeKeySet,
  findManifestFile,
  verifyFileHash,
  verifyKeyRotation,
  verifyManifest,
} from '../../../src/main/update/verify';
import type { TrustedUpdateKeys } from '../../../src/main/update/verify';
import { INSTALLER_BYTES, INSTALLER_NAME, makeKey, makeManifest, signBytes, signManifest, tamperSig } from './helpers';

const A = makeKey();
const B = makeKey();
const trusted: TrustedUpdateKeys = { current: A.pub, next: null };

describe('verifyManifest', () => {
  it('accepts a valid hybrid-signed manifest', () => {
    const s = signManifest(A, makeManifest());
    const r = verifyManifest(s.bytes, s.sigEd, s.sigPq, trusted);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.keyId).toBe(A.pub.id);
      expect(r.value.manifest.version).toBe('1.2.0');
    }
  });
  it('accepts signature files as raw bytes with a trailing newline', () => {
    const s = signManifest(A, makeManifest());
    const enc = (t: string): Uint8Array => new TextEncoder().encode(`${t}\n`);
    expect(verifyManifest(s.bytes, enc(s.sigEd), enc(s.sigPq), trusted).ok).toBe(true);
  });
  it('rejects a tampered manifest', () => {
    const s = signManifest(A, makeManifest());
    const tampered = new Uint8Array(s.bytes);
    const i = tampered.indexOf('2'.charCodeAt(0));
    tampered[i] = '3'.charCodeAt(0);
    const r = verifyManifest(tampered, s.sigEd, s.sigPq, trusted);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('SIGNATURE_INVALID');
  });
  it('rejects a tampered Ed25519 signature', () => {
    const s = signManifest(A, makeManifest());
    const r = verifyManifest(s.bytes, tamperSig(s.sigEd), s.sigPq, trusted);
    expect(r).toMatchObject({ ok: false, reason: 'SIGNATURE_INVALID' });
  });
  it('rejects a tampered ML-DSA-65 signature', () => {
    const s = signManifest(A, makeManifest());
    const r = verifyManifest(s.bytes, s.sigEd, tamperSig(s.sigPq), trusted);
    expect(r).toMatchObject({ ok: false, reason: 'SIGNATURE_INVALID' });
  });
  it('rejects when only one signature is present', () => {
    const s = signManifest(A, makeManifest());
    expect(verifyManifest(s.bytes, s.sigEd, null, trusted)).toMatchObject({ ok: false, reason: 'SIGNATURE_MISSING' });
    expect(verifyManifest(s.bytes, '', s.sigPq, trusted)).toMatchObject({ ok: false, reason: 'SIGNATURE_MISSING' });
    expect(verifyManifest(s.bytes, undefined, s.sigPq, trusted)).toMatchObject({ ok: false });
  });
  it('rejects swapped / malformed signatures', () => {
    const s = signManifest(A, makeManifest());
    expect(verifyManifest(s.bytes, s.sigPq, s.sigEd, trusted).ok).toBe(false);
    expect(verifyManifest(s.bytes, 'not base64!', s.sigPq, trusted)).toMatchObject({ reason: 'SIGNATURE_MALFORMED' });
  });
  it('rejects a signature from an untrusted key', () => {
    const s = signManifest(B, makeManifest());
    expect(verifyManifest(s.bytes, s.sigEd, s.sigPq, trusted)).toMatchObject({
      ok: false,
      reason: 'SIGNATURE_INVALID',
    });
  });
  it('rejects mixing algorithms across key slots (Ed25519 from A, ML-DSA from B)', () => {
    const m = makeManifest();
    const sa = signManifest(A, m);
    const sb = signManifest(B, m);
    const both: TrustedUpdateKeys = { current: A.pub, next: B.pub };
    expect(verifyManifest(sa.bytes, sa.sigEd, sb.sigPq, both).ok).toBe(false);
  });
  it('accepts the pre-distributed next key (rotation)', () => {
    const s = signManifest(B, makeManifest());
    const r = verifyManifest(s.bytes, s.sigEd, s.sigPq, { current: A.pub, next: B.pub });
    expect(r).toMatchObject({ ok: true, value: { keyId: B.pub.id } });
  });
  it('rejects key sets whose id does not match their material', () => {
    const bad = { ...A.pub, id: B.pub.id };
    expect(decodeKeySet(bad)).toBeNull();
    const s = signManifest(A, makeManifest());
    expect(verifyManifest(s.bytes, s.sigEd, s.sigPq, { current: bad, next: null })).toMatchObject({
      reason: 'KEYS_INVALID',
    });
  });
  it('rejects signed but non-canonical or invalid manifests', () => {
    const pretty = new TextEncoder().encode(JSON.stringify(makeManifest(), null, 2));
    const s = signBytes(A, pretty);
    expect(verifyManifest(s.bytes, s.sigEd, s.sigPq, trusted)).toMatchObject({ reason: 'MANIFEST_NOT_CANONICAL' });
    const extra = signBytes(A, canonicalBytes({ ...makeManifest(), extra: 1 }));
    expect(verifyManifest(extra.bytes, extra.sigEd, extra.sigPq, trusted)).toMatchObject({
      reason: 'MANIFEST_INVALID',
    });
    const traversal = makeManifest();
    traversal.files[0]!.name = '..\\evil.exe';
    const t = signManifest(A, traversal);
    expect(verifyManifest(t.bytes, t.sigEd, t.sigPq, trusted)).toMatchObject({ reason: 'MANIFEST_INVALID' });
  });
  it('rejects oversize input before verifying', () => {
    expect(verifyManifest(new Uint8Array(70 * 1024), 'AA==', 'AA==', trusted)).toMatchObject({
      reason: 'MANIFEST_TOO_LARGE',
    });
  });
});

describe('version policy (downgrade / replay)', () => {
  it('accepts the offered newer version', () => {
    expect(checkManifestVersion(makeManifest('1.2.0'), { currentVersion: '1.1.0', expectedVersion: '1.2.0' }).ok).toBe(
      true,
    );
  });
  it('rejects a downgrade or same version', () => {
    expect(
      checkManifestVersion(makeManifest('1.0.0'), { currentVersion: '1.1.0', expectedVersion: '1.0.0' }),
    ).toMatchObject({
      reason: 'NOT_NEWER',
    });
    expect(
      checkManifestVersion(makeManifest('1.1.0'), { currentVersion: '1.1.0', expectedVersion: '1.1.0' }),
    ).toMatchObject({
      reason: 'NOT_NEWER',
    });
  });
  it('rejects replay of an older validly signed manifest for a newer offer', () => {
    const old = signManifest(A, makeManifest('1.1.0'));
    const r = verifyManifest(old.bytes, old.sigEd, old.sigPq, trusted);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(
        checkManifestVersion(r.value.manifest, { currentVersion: '1.1.0', expectedVersion: '1.2.0' }),
      ).toMatchObject({ reason: 'VERSION_MISMATCH' });
    }
  });
  it('ignores prereleases unless allowed', () => {
    const m = makeManifest('1.2.0-rc.1');
    expect(checkManifestVersion(m, { currentVersion: '1.1.0', expectedVersion: '1.2.0-rc.1' }).ok).toBe(false);
    expect(
      checkManifestVersion(m, { currentVersion: '1.1.0', expectedVersion: '1.2.0-rc.1', allowPrerelease: true }).ok,
    ).toBe(true);
  });
});

describe('file checks', () => {
  const m = makeManifest();
  it('finds the installer entry and rejects a missing one', () => {
    expect(findManifestFile(m, INSTALLER_NAME).ok).toBe(true);
    expect(findManifestFile(m, 'other.exe')).toMatchObject({ reason: 'FILE_MISSING' });
  });
  it('verifies size and SHA-512', () => {
    const entry = m.files[0]!;
    expect(verifyFileHash(entry, { sha512Hex: sha512Hex(INSTALLER_BYTES), size: INSTALLER_BYTES.length }).ok).toBe(
      true,
    );
    expect(verifyFileHash(entry, { sha512Hex: sha512Hex(INSTALLER_BYTES), size: entry.size + 1 })).toMatchObject({
      reason: 'SIZE_MISMATCH',
    });
    expect(verifyFileHash(entry, { sha512Hex: sha512Hex(new Uint8Array([9])), size: entry.size })).toMatchObject({
      reason: 'HASH_MISMATCH',
    });
  });
});

describe('verifyKeyRotation (hook)', () => {
  const statement = {
    formatVersion: 1,
    purpose: 'vss-key-rotation',
    date: '2026-11-03',
    newKeys: { id: B.pub.id, ed25519: B.pub.ed25519, mldsa65: B.pub.mldsa65 },
  };
  const bytes = canonicalBytes(statement);
  const sigEd = encodeBase64(ed25519Sign(A.seeds.ed25519Seed, bytes));
  const sigPq = encodeBase64(mldsa65Sign(A.seeds.mldsa65Seed, bytes, MLDSA_CONTEXT_ROTATION));
  it('accepts a statement signed by the current key', () => {
    expect(verifyKeyRotation(bytes, sigEd, sigPq, trusted)).toMatchObject({ ok: true, value: { id: B.pub.id } });
  });
  it('rejects a statement signed by the new key itself', () => {
    const s = signBytes(B, bytes);
    expect(verifyKeyRotation(bytes, s.sigEd, s.sigPq, trusted).ok).toBe(false);
  });
  it('a manifest signature is not valid as a rotation signature (domain separation)', () => {
    const s = signBytes(A, bytes); // signed with the MANIFEST context
    expect(verifyKeyRotation(bytes, s.sigEd, s.sigPq, trusted)).toMatchObject({ reason: 'SIGNATURE_INVALID' });
  });
});
