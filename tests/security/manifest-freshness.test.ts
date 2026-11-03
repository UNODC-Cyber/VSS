/**
 * Security review F-12: signed release manifests carry a validity window (notBefore / notAfter, at most
 * MAX_VALIDITY_DAYS). Installed apps refuse a manifest outside it, so a captured older (but still "newer than
 * installed") release cannot be offered forever. The signed key-rotation hook is unchanged. Test keys only.
 */
import { describe, expect, it } from 'vitest';
import {
  checkManifestFreshness,
  MAX_VALIDITY_DAYS,
  VALIDITY_SKEW_MS,
  verifyKeyRotation,
  verifyManifest,
} from '../../src/main/update/verify';
import type { ReleaseManifest } from '../../src/main/update/verify';
import { canonicalBytes } from '../../src/main/update/canonical';
import { ed25519Sign, encodeBase64, MLDSA_CONTEXT_ROTATION, mldsa65Sign } from '../../src/main/update/crypto';
import { makeKey, makeManifest, signBytes, signManifest } from '../unit/update/helpers';

const KEY = makeKey();
const NEXT = makeKey();
const trusted = { current: KEY.pub, next: null };
const day = (d: string) => Date.parse(`${d}T00:00:00.000Z`);

describe('F-12 manifest validity window', () => {
  it('a signed manifest without the window (formatVersion 1) is refused', () => {
    const { notBefore: _a, notAfter: _b, ...rest } = makeManifest('1.2.0');
    const v1 = { ...rest, formatVersion: 1 };
    const s = signBytes(KEY, canonicalBytes(v1));
    expect(verifyManifest(s.bytes, s.sigEd, s.sigPq, trusted)).toMatchObject({ ok: false, reason: 'MANIFEST_INVALID' });
  });

  it('a window longer than the ceiling, or reversed, is refused even when signed', () => {
    const long: ReleaseManifest = { ...makeManifest('1.2.0'), notBefore: '2026-11-03', notAfter: '2027-11-03' };
    const s = signManifest(KEY, long);
    expect(verifyManifest(s.bytes, s.sigEd, s.sigPq, trusted)).toMatchObject({ ok: false, reason: 'MANIFEST_INVALID' });
    const rev: ReleaseManifest = { ...makeManifest('1.2.0'), notBefore: '2026-11-03', notAfter: '2026-11-01' };
    const r = signManifest(KEY, rev);
    expect(verifyManifest(r.bytes, r.sigEd, r.sigPq, trusted)).toMatchObject({ ok: false, reason: 'MANIFEST_INVALID' });
    expect(MAX_VALIDITY_DAYS).toBe(180);
  });

  it('freshness: inside the window ok; before / after it refused (one day of clock skew tolerated)', () => {
    const m: ReleaseManifest = { ...makeManifest('1.2.0'), notBefore: '2026-11-03', notAfter: '2027-01-31' };
    expect(checkManifestFreshness(m, day('2026-12-01')).ok).toBe(true);
    expect(checkManifestFreshness(m, day('2026-11-03') - VALIDITY_SKEW_MS + 1).ok).toBe(true);
    expect(checkManifestFreshness(m, day('2026-11-01'))).toMatchObject({ ok: false, reason: 'MANIFEST_NOT_YET_VALID' });
    expect(checkManifestFreshness(m, day('2027-02-01') + VALIDITY_SKEW_MS - 1).ok).toBe(true);
    expect(checkManifestFreshness(m, day('2027-02-03'))).toMatchObject({ ok: false, reason: 'MANIFEST_EXPIRED' });
  });

  it('the signed key-rotation hook still verifies', () => {
    const stmt = canonicalBytes({
      date: '2026-11-03',
      formatVersion: 1,
      newKeys: { ed25519: NEXT.pub.ed25519, id: NEXT.pub.id, mldsa65: NEXT.pub.mldsa65 },
      purpose: 'vss-key-rotation',
    });
    const sigEd = encodeBase64(ed25519Sign(KEY.seeds.ed25519Seed, stmt));
    const sigPq = encodeBase64(mldsa65Sign(KEY.seeds.mldsa65Seed, stmt, MLDSA_CONTEXT_ROTATION));
    const r = verifyKeyRotation(stmt, sigEd, sigPq, trusted);
    expect(r.ok && r.value.id).toBe(NEXT.pub.id);
  });
});
