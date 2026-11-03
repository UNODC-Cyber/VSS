/**
 * Vault directory format (WP-03).
 *
 *   <dir>/vault.json   public header (this module)
 *   <dir>/vss.db       SQLite3MC database encrypted with the raw 32-byte DEK (WP-04)
 *
 * vault.json (version 1):
 *   { format: 'vss-vault', version: 1, vaultId, createdAt, slots: [KeySlot], headerMac, failedAttempts, lastFailureAt }
 *
 * - DEK: 32 random bytes; never stored in clear.
 * - Key slot (only type 'password' is implemented; FIDO2 slot types are deferred): the DEK is wrapped with
 *   AES-256-GCM under KEK = HKDF-SHA-512(ikm = Argon2id(password, salt), salt, 'vss-kek-v1'), with
 *   AAD = canonical JSON of {format, version, vaultId, slot header without the wrap}. Any change to the slot's id,
 *   label, type, kdf params, salt or to the vault id makes the unwrap fail.
 * - headerMac = HMAC-SHA-512 keyed by HKDF-SHA-512(DEK, '', 'vss-hdr') over canonical JSON of
 *   {format, version, vaultId, createdAt, slots}; verified after every unlock (mismatch => VAULT_TAMPERED).
 * - failedAttempts / lastFailureAt are deliberately outside the MAC (written without the DEK).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { aesGcmOpen, aesGcmSeal, GCM_IV_BYTES, GCM_TAG_BYTES } from './aead';
import { canonicalJson } from './canonical-json';
import { CryptoError } from './errors';
import { DEFAULT_KDF, derivePasswordKey, hkdfSha512, isValidKdfParams, KDF_LIMITS, kdfCost } from './kdf';
import type { Argon2idParams } from './kdf';
import { effectiveFailures, lockedOutUntil, recordFailure, resetFailures } from './lockout';
import type { FailureState } from './lockout';
import { secureCopy, zeroize } from './zeroize';

export const VAULT_FILE = 'vault.json';
export const DB_FILE = 'vss.db';
export const VAULT_FORMAT = 'vss-vault';
export const VAULT_VERSION = 1;
export const MAX_SLOTS = 8;
export const DEK_BYTES = 32;
export const SALT_BYTES = 32;
const KEK_INFO = 'vss-kek-v1';
const HDR_INFO = 'vss-hdr';

// ---------------------------------------------------------------------------------------------------------------
// Header schema
// ---------------------------------------------------------------------------------------------------------------

/** Strict base64 of exactly `n` decoded bytes (canonical encoding only, so the MAC input is not malleable). */
const b64Bytes = (n: number) =>
  z.string().refine((s) => {
    const b = Buffer.from(s, 'base64');
    return b.length === n && b.toString('base64') === s;
  });
const hex32 = z.string().regex(/^[0-9a-f]{32}$/);
const isoTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/);
/** True when `s` contains a C0 control character or DEL. */
export const hasControlChars = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
};
// Labels are public but must stay printable and short.
const label = z
  .string()
  .min(1)
  .max(128)
  .refine((s) => !hasControlChars(s));

const kdfSchema = z.custom<Argon2idParams>((v) => isValidKdfParams(v));

const passwordSlotSchema = z.strictObject({
  id: hex32,
  label,
  type: z.literal('password'),
  createdAt: isoTime,
  kdf: kdfSchema,
  salt: b64Bytes(SALT_BYTES),
  wrap: z.strictObject({
    alg: z.literal('A256GCM'),
    iv: b64Bytes(GCM_IV_BYTES),
    ct: b64Bytes(DEK_BYTES + GCM_TAG_BYTES),
  }),
});
export type KeySlot = z.infer<typeof passwordSlotSchema>;

const headerSchema = z.strictObject({
  format: z.literal(VAULT_FORMAT),
  version: z.literal(VAULT_VERSION),
  vaultId: hex32,
  createdAt: isoTime,
  slots: z.array(passwordSlotSchema).min(1).max(MAX_SLOTS),
  headerMac: b64Bytes(64),
  failedAttempts: z.number().int().min(0).max(1_000_000),
  lastFailureAt: isoTime.nullable(),
});
export type VaultHeader = z.infer<typeof headerSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Key material
// ---------------------------------------------------------------------------------------------------------------

/** Unlocked key material. Call dispose() on lock; every getter throws afterwards. */
export class KeyMaterial {
  #dek: Buffer | null;
  readonly vaultId: string;
  /** Slot that unlocked (or created) the vault. */
  readonly slotId: string;

  constructor(dek: Uint8Array, vaultId: string, slotId: string) {
    if (dek.length !== DEK_BYTES) throw new CryptoError('BAD_REQUEST');
    this.#dek = secureCopy(dek);
    this.vaultId = vaultId;
    this.slotId = slotId;
  }

  get disposed(): boolean {
    return this.#dek === null;
  }

  /** The live 32-byte DEK buffer (not a copy). Do not retain beyond the KeyMaterial's lifetime. */
  get dek(): Buffer {
    if (!this.#dek) throw new CryptoError('KEY_DISPOSED');
    return this.#dek;
  }

  /**
   * 64 lowercase hex chars for SQLite3MC: `PRAGMA key="x'<hex>'"`. JS strings cannot be wiped: build the pragma
   * immediately, do not store or log it.
   */
  dbKeyHex(): string {
    return this.dek.toString('hex');
  }

  /** Zero-fill the DEK. Idempotent. */
  dispose(): void {
    if (this.#dek) this.#dek.fill(0);
    this.#dek = null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

export const vaultFilePath = (dir: string) => join(dir, VAULT_FILE);
export const dbFilePath = (dir: string) => join(dir, DB_FILE);
const nowIso = (ms: number) => new Date(ms).toISOString();
const randomHex = (n: number) => randomBytes(n).toString('hex');

type Clock = () => number;
const realClock: Clock = () => Date.now();

function slotAad(h: Pick<VaultHeader, 'format' | 'version' | 'vaultId'>, s: KeySlot): Buffer {
  const { wrap: _wrap, ...slotHeader } = s;
  return Buffer.from(
    canonicalJson({ format: h.format, version: h.version, vaultId: h.vaultId, slot: slotHeader }),
    'utf8',
  );
}

function macInput(h: Pick<VaultHeader, 'format' | 'version' | 'vaultId' | 'createdAt' | 'slots'>): Buffer {
  return Buffer.from(
    canonicalJson({ format: h.format, version: h.version, vaultId: h.vaultId, createdAt: h.createdAt, slots: h.slots }),
    'utf8',
  );
}

function computeMac(dek: Uint8Array, h: Parameters<typeof macInput>[0]): Buffer {
  const key = hkdfSha512(dek, Buffer.alloc(0), HDR_INFO, 64);
  try {
    return createHmac('sha512', key).update(macInput(h)).digest();
  } finally {
    zeroize(key);
  }
}

function verifyMac(dek: Uint8Array, h: VaultHeader): boolean {
  const expected = computeMac(dek, h);
  const actual = Buffer.from(h.headerMac, 'base64');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function deriveKek(password: string, salt: Uint8Array, kdf: Argon2idParams): Promise<Buffer> {
  const ikm = await derivePasswordKey(password, salt, kdf);
  try {
    return hkdfSha512(ikm, salt, KEK_INFO, 32);
  } finally {
    zeroize(ikm);
  }
}

async function makePasswordSlot(
  h: Pick<VaultHeader, 'format' | 'version' | 'vaultId'>,
  dek: Uint8Array,
  password: string,
  opts: { label: string; kdf: Argon2idParams; createdAt: string; id?: string },
): Promise<KeySlot> {
  if (!isValidKdfParams(opts.kdf)) throw new CryptoError('BAD_REQUEST');
  if (!label.safeParse(opts.label).success) throw new CryptoError('BAD_REQUEST');
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(GCM_IV_BYTES);
  const draft: KeySlot = {
    id: opts.id ?? randomHex(16),
    label: opts.label,
    type: 'password',
    createdAt: opts.createdAt,
    kdf: { ...opts.kdf },
    salt: salt.toString('base64'),
    wrap: { alg: 'A256GCM', iv: iv.toString('base64'), ct: '' },
  };
  const kek = await deriveKek(password, salt, draft.kdf);
  try {
    draft.wrap.ct = aesGcmSeal(kek, iv, dek, slotAad(h, draft)).toString('base64');
  } finally {
    zeroize(kek);
  }
  return draft;
}

/** Try to unwrap the DEK from one slot. Returns null on any failure. */
async function tryUnwrap(h: VaultHeader, s: KeySlot, password: string): Promise<Buffer | null> {
  const salt = Buffer.from(s.salt, 'base64');
  const kek = await deriveKek(password, salt, s.kdf);
  try {
    const dek = aesGcmOpen(kek, Buffer.from(s.wrap.iv, 'base64'), Buffer.from(s.wrap.ct, 'base64'), slotAad(h, s));
    if (dek && dek.length !== DEK_BYTES) {
      zeroize(dek);
      return null;
    }
    return dek;
  } finally {
    zeroize(kek);
  }
}

function sealHeader(
  dek: Uint8Array,
  body: Pick<VaultHeader, 'format' | 'version' | 'vaultId' | 'createdAt' | 'slots'>,
  failures: FailureState = { count: 0, lastAt: null },
): VaultHeader {
  return {
    ...body,
    headerMac: computeMac(dek, body).toString('base64'),
    failedAttempts: failures.count,
    lastFailureAt: failures.lastAt === null ? null : nowIso(failures.lastAt),
  };
}

function serialise(h: VaultHeader): string {
  // Human-readable on disk; the MAC is over canonical JSON, not these bytes.
  return `${JSON.stringify(h, null, 2)}\n`;
}

/** Atomic replace: write a sibling temp file then rename over the target. */
function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.${randomHex(6)}.tmp`;
  try {
    writeFileSync(tmp, data, { encoding: 'utf8', flag: 'wx' });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Parse and structurally validate a vault.json. Does NOT verify the MAC (needs the DEK). */
export function parseHeader(text: string): VaultHeader {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CryptoError('VAULT_CORRUPT');
  }
  const r = headerSchema.safeParse(raw);
  if (!r.success) throw new CryptoError('VAULT_CORRUPT');
  const ids = new Set(r.data.slots.map((s) => s.id));
  if (ids.size !== r.data.slots.length) throw new CryptoError('VAULT_CORRUPT');
  // F-08: a wrong password tries every slot, so the slots together must stay within twice one derivation's ceiling.
  if (r.data.slots.reduce((sum, s) => sum + kdfCost(s.kdf), 0) > 2 * KDF_LIMITS.maxCost)
    throw new CryptoError('VAULT_CORRUPT');
  return r.data;
}

export function readHeader(dir: string): VaultHeader {
  const p = vaultFilePath(dir);
  let text: string;
  try {
    text = readFileSync(p, 'utf8');
  } catch {
    throw new CryptoError('VAULT_NOT_FOUND');
  }
  return parseHeader(text);
}

export function vaultExists(dir: string): boolean {
  return existsSync(vaultFilePath(dir));
}

/**
 * The back-off state stored in vault.json. It is outside the MAC (it must be writable without the DEK), so it is a
 * UX throttle, not a security boundary: Argon2id and the password policy are (security review F-07). A stored
 * time in the future (an edited file, or a clock that was wrong when the failure happened) is clamped to `now`, so
 * the longest possible wait is MAX_DELAY_MS from now and never "until year 9999".
 */
function persistedFailures(h: VaultHeader, now: number, dir?: string): FailureState {
  const parsed = h.lastFailureAt ? Date.parse(h.lastFailureAt) : NaN;
  const st = { count: h.failedAttempts, lastAt: Number.isFinite(parsed) ? Math.min(parsed, now) : null };
  // Write the clamped time back once, so the wait counts down from here instead of restarting at every read.
  if (dir !== undefined && Number.isFinite(parsed) && parsed > now) persistFailureState(dir, st);
  return st;
}

/** Back-off state for status display. */
export function lockoutStatus(
  dir: string,
  now: Clock = realClock,
): { failedAttempts: number; lockedOutUntil: number | null } {
  const h = readHeader(dir);
  const st = effectiveFailures(h.vaultId, persistedFailures(h, now(), dir));
  return { failedAttempts: st.count, lockedOutUntil: lockedOutUntil(st, now()) };
}

/** Rewrite only the non-MAC failure fields (best effort: a write failure must not change the unlock outcome). */
function persistFailureState(dir: string, st: FailureState): void {
  try {
    const cur = readHeader(dir);
    writeAtomic(
      vaultFilePath(dir),
      serialise({ ...cur, failedAttempts: st.count, lastFailureAt: st.lastAt === null ? null : nowIso(st.lastAt) }),
    );
  } catch {
    // ignore: in-memory counter still applies
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------------------------

export interface CreateVaultOptions {
  dir: string;
  password: string;
  /** Slot label (public). Default 'Password'. */
  label?: string;
  /** Argon2id params for the password slot; default DEFAULT_KDF (use autoTune() to pick). */
  kdf?: Argon2idParams;
  now?: Clock;
}

/** Create vault.json in `dir` (created if missing). Fails with VAULT_EXISTS if vault.json or vss.db is present. */
export async function createVault(opts: CreateVaultOptions): Promise<KeyMaterial> {
  if (typeof opts.password !== 'string' || opts.password.length === 0) throw new CryptoError('BAD_REQUEST');
  const now = opts.now ?? realClock;
  mkdirSync(opts.dir, { recursive: true });
  if (existsSync(vaultFilePath(opts.dir)) || existsSync(dbFilePath(opts.dir))) throw new CryptoError('VAULT_EXISTS');
  const dek = randomBytes(DEK_BYTES);
  try {
    const createdAt = nowIso(now());
    const base = { format: VAULT_FORMAT, version: VAULT_VERSION, vaultId: randomHex(16), createdAt } as const;
    const slot = await makePasswordSlot(base, dek, opts.password, {
      label: opts.label ?? 'Password',
      kdf: opts.kdf ?? DEFAULT_KDF,
      createdAt,
    });
    const header = sealHeader(dek, { ...base, slots: [slot] });
    try {
      writeFileSync(vaultFilePath(opts.dir), serialise(header), { encoding: 'utf8', flag: 'wx' });
    } catch {
      throw new CryptoError('VAULT_EXISTS');
    }
    resetFailures(header.vaultId);
    return new KeyMaterial(dek, header.vaultId, slot.id);
  } finally {
    zeroize(dek);
  }
}

export interface UnlockOptions {
  dir: string;
  password: string;
  now?: Clock;
}

interface Unlocked {
  header: VaultHeader;
  slot: KeySlot;
  dek: Buffer;
}

/**
 * Credential checks on one vault directory run strictly one after another, so concurrent attempts cannot all read
 * the same failure count and bypass the back-off.
 */
const queues = new Map<string, Promise<unknown>>();
function serialised<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(dir).toLowerCase();
  const prev = queues.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

function unlockInternal(opts: UnlockOptions): Promise<Unlocked> {
  return serialised(opts.dir, () => unlockSerial(opts));
}

async function unlockSerial(opts: UnlockOptions): Promise<Unlocked> {
  const now = opts.now ?? realClock;
  const header = readHeader(opts.dir);
  const persisted = persistedFailures(header, now(), opts.dir);
  const until = lockedOutUntil(effectiveFailures(header.vaultId, persisted), now());
  if (until !== null) throw new CryptoError('RATE_LIMITED', until);

  let found: { slot: KeySlot; dek: Buffer } | null = null;
  if (typeof opts.password === 'string' && opts.password.length > 0) {
    for (const slot of header.slots) {
      const dek = await tryUnwrap(header, slot, opts.password);
      if (dek) {
        found = { slot, dek };
        break;
      }
    }
  }
  if (!found) {
    const st = recordFailure(header.vaultId, persisted, now());
    persistFailureState(opts.dir, st);
    throw new CryptoError('BAD_CREDENTIALS');
  }
  if (!verifyMac(found.dek, header)) {
    zeroize(found.dek);
    throw new CryptoError('VAULT_TAMPERED');
  }
  resetFailures(header.vaultId);
  if (header.failedAttempts !== 0 || header.lastFailureAt !== null) {
    persistFailureState(opts.dir, { count: 0, lastAt: null });
  }
  return { header, slot: found.slot, dek: found.dek };
}

/**
 * Unlock with the password. Every credential failure raises the same CryptoError('BAD_CREDENTIALS'); a header whose
 * MAC does not verify after a successful unwrap raises VAULT_TAMPERED; back-off raises RATE_LIMITED (retryAt set).
 */
export async function unlock(opts: UnlockOptions): Promise<KeyMaterial> {
  const u = await unlockInternal(opts);
  try {
    return new KeyMaterial(u.dek, u.header.vaultId, u.slot.id);
  } finally {
    zeroize(u.dek);
  }
}

export interface ChangePasswordOptions {
  dir: string;
  currentPassword: string;
  newPassword: string;
  /** New Argon2id params; default: keep the slot's current params. */
  kdf?: Argon2idParams;
  now?: Clock;
}

/** Rewrap the DEK of the slot that `currentPassword` opens with `newPassword` (fresh salt and IV). DEK unchanged. */
export async function changePassword(opts: ChangePasswordOptions): Promise<void> {
  if (typeof opts.newPassword !== 'string' || opts.newPassword.length === 0) throw new CryptoError('BAD_REQUEST');
  // Whole read-modify-write inside the per-directory queue so a concurrent failure-count write cannot revert it.
  return serialised(opts.dir, async () => {
    const u = await unlockSerial({ dir: opts.dir, password: opts.currentPassword, now: opts.now });
    try {
      const { header, slot, dek } = u;
      const replacement = await makePasswordSlot(header, dek, opts.newPassword, {
        id: slot.id,
        label: slot.label,
        createdAt: slot.createdAt,
        kdf: opts.kdf ?? slot.kdf,
      });
      const slots = header.slots.map((s) => (s.id === slot.id ? replacement : s));
      writeAtomic(vaultFilePath(opts.dir), serialise(sealHeader(dek, { ...header, slots })));
    } finally {
      zeroize(u.dek);
    }
  });
}

export interface RotateDekOptions {
  dir: string;
  /** Current password (authenticates the rotation). */
  password: string;
  /** Password for the rewrapped slot; default: the current one (pure re-key). */
  newPassword?: string;
  kdf?: Argon2idParams;
  now?: Clock;
}

export interface DekRotation {
  /** Key material for the new DEK. Owned by the caller (dispose it on lock). */
  next: KeyMaterial;
  /** Slots that could not be rewrapped (credentials not supplied) and will be dropped on commit. */
  droppedSlotIds: string[];
  /**
   * Apply the rotation, crash-safe (security review F-03). Order:
   *   1. write `vault.json.rotation` (old DEK and new DEK, each wrapped under the other) and `vault.json.next`
   *      (the new header), both fsynced;
   *   2. `rekeyDb(oldKeyHex, newKeyHex)` (SQLite3MC `PRAGMA rekey`);
   *   3. rename `vault.json.next` over `vault.json`, delete the rotation record.
   * If `rekeyDb` throws, both pending files are removed and the vault keeps the old DEK. If the process dies in
   * between, `recoverRotation` (run before the next unlock) completes or rolls back with either password.
   */
  commit(rekeyDb: (oldKeyHex: string, newKeyHex: string) => void | Promise<void>): Promise<void>;
  /** Discard without changing anything (disposes `next`). */
  abort(): void;
}

export const pendingRotationPath = (dir: string) => `${vaultFilePath(dir)}.next`;
export const rotationRecordPath = (dir: string) => `${vaultFilePath(dir)}.rotation`;
const ROTATION_FORMAT = 'vss-rotation';
const ROTATION_INFO = 'vss-rotation-v1';

const wrapSchema = z.strictObject({ iv: b64Bytes(GCM_IV_BYTES), ct: b64Bytes(DEK_BYTES + GCM_TAG_BYTES) });
const rotationSchema = z.strictObject({
  format: z.literal(ROTATION_FORMAT),
  version: z.literal(1),
  vaultId: hex32,
  /** new DEK wrapped under a key derived from the old DEK. */
  oldToNew: wrapSchema,
  /** old DEK wrapped under a key derived from the new DEK. */
  newToOld: wrapSchema,
});
type RotationRecord = z.infer<typeof rotationSchema>;

const rotationAad = (vaultId: string) =>
  Buffer.from(canonicalJson({ format: ROTATION_FORMAT, version: 1, vaultId }), 'utf8');

function wrapDek(wrappingDek: Uint8Array, dek: Uint8Array, vaultId: string): RotationRecord['oldToNew'] {
  const key = hkdfSha512(wrappingDek, Buffer.alloc(0), ROTATION_INFO, 32);
  const iv = randomBytes(GCM_IV_BYTES);
  try {
    return { iv: iv.toString('base64'), ct: aesGcmSeal(key, iv, dek, rotationAad(vaultId)).toString('base64') };
  } finally {
    zeroize(key);
  }
}

function unwrapDek(wrappingDek: Uint8Array, w: RotationRecord['oldToNew'], vaultId: string): Buffer | null {
  const key = hkdfSha512(wrappingDek, Buffer.alloc(0), ROTATION_INFO, 32);
  try {
    const dek = aesGcmOpen(key, Buffer.from(w.iv, 'base64'), Buffer.from(w.ct, 'base64'), rotationAad(vaultId));
    if (dek && dek.length !== DEK_BYTES) {
      zeroize(dek);
      return null;
    }
    return dek;
  } finally {
    zeroize(key);
  }
}

/** Write + fsync (the rotation files must be on disk before the DB is re-keyed). */
function writeDurable(path: string, data: string): void {
  const fd = openSync(path, 'w');
  try {
    writeSync(fd, data, 0, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

const serialiseRecord = (r: RotationRecord): string => `${JSON.stringify(r, null, 2)}\n`;

/**
 * Prepare a DEK rotation: authenticates with `password`, generates a fresh DEK and a new header in which the
 * authenticating slot is rewrapped with `newPassword` (default: the same password); other slots, if any, are
 * dropped because their credentials are not available. Nothing on disk changes until commit().
 */
export async function rotateDek(opts: RotateDekOptions): Promise<DekRotation> {
  const newPassword = opts.newPassword ?? opts.password;
  if (typeof newPassword !== 'string' || newPassword.length === 0) throw new CryptoError('BAD_REQUEST');
  const u = await unlockInternal({ dir: opts.dir, password: opts.password, now: opts.now });
  const newDek = randomBytes(DEK_BYTES);
  try {
    const { header, slot } = u;
    const now = opts.now ?? realClock;
    const replacement = await makePasswordSlot(header, newDek, newPassword, {
      id: slot.id,
      label: slot.label,
      createdAt: nowIso(now()),
      kdf: opts.kdf ?? slot.kdf,
    });
    const nextHeader = sealHeader(newDek, { ...header, slots: [replacement] });
    const record: RotationRecord = {
      format: ROTATION_FORMAT,
      version: 1,
      vaultId: header.vaultId,
      oldToNew: wrapDek(u.dek, newDek, header.vaultId),
      newToOld: wrapDek(newDek, u.dek, header.vaultId),
    };
    const next = new KeyMaterial(newDek, header.vaultId, replacement.id);
    const old = new KeyMaterial(u.dek, header.vaultId, slot.id);
    const droppedSlotIds = header.slots.filter((s) => s.id !== slot.id).map((s) => s.id);
    let done = false;
    return {
      next,
      droppedSlotIds,
      commit(rekeyDb) {
        if (done) return Promise.reject(new CryptoError('BAD_REQUEST'));
        done = true;
        return serialised(opts.dir, async () => {
          const pending = pendingRotationPath(opts.dir);
          const rec = rotationRecordPath(opts.dir);
          try {
            writeDurable(rec, serialiseRecord(record));
            writeDurable(pending, serialise(nextHeader));
            try {
              await rekeyDb(old.dbKeyHex(), next.dbKeyHex());
            } catch (e) {
              rmSync(pending, { force: true });
              rmSync(rec, { force: true });
              throw e;
            }
            renameSync(pending, vaultFilePath(opts.dir));
            rmSync(rec, { force: true });
          } finally {
            old.dispose();
          }
        });
      },
      abort() {
        done = true;
        old.dispose();
        next.dispose();
      },
    };
  } finally {
    zeroize(u.dek, newDek);
  }
}

/** True when a password change / DEK rotation was interrupted and `recoverRotation` has work to do. */
export function rotationPending(dir: string): boolean {
  return existsSync(pendingRotationPath(dir)) || existsSync(rotationRecordPath(dir));
}

export type RotationRecovery = 'none' | 'completed' | 'rolled-back' | 'cleaned';

export interface RecoverRotationOptions {
  dir: string;
  /** The old or the new password: either one recovers. */
  password: string;
  /** True when `keyHex` opens the database (and it reads cleanly). */
  probe(keyHex: string): boolean;
  now?: Clock;
}

/** DEK of `h` for `password` (MAC verified), or null. */
async function unwrapHeader(h: VaultHeader, password: string): Promise<Buffer | null> {
  if (typeof password !== 'string' || password.length === 0) return null;
  for (const slot of h.slots) {
    const dek = await tryUnwrap(h, slot, password);
    if (!dek) continue;
    if (verifyMac(dek, h)) return dek;
    zeroize(dek);
    return null;
  }
  return null;
}

/**
 * Finish or undo an interrupted DEK rotation (F-03). Needs the old OR the new password: the rotation record lets
 * either DEK recover the other. Whichever DEK opens the database decides: the new one means the rotation reached
 * the DB, so the new header replaces vault.json; the old one means the DB was never re-keyed, so the pending files
 * go. A wrong password counts as a failed unlock attempt (same back-off).
 */
export function recoverRotation(opts: RecoverRotationOptions): Promise<RotationRecovery> {
  return serialised(opts.dir, async () => {
    const now = opts.now ?? realClock;
    const pending = pendingRotationPath(opts.dir);
    const rec = rotationRecordPath(opts.dir);
    const hasNext = existsSync(pending);
    const hasRec = existsSync(rec);
    if (!hasNext && !hasRec) return 'none';
    // Record without header: the crash came before the rekey started or after the rename finished; in both cases
    // vault.json matches the DB.
    if (!hasNext) {
      rmSync(rec, { force: true });
      return 'cleaned';
    }
    const cur = readHeader(opts.dir);
    let nextHeader: VaultHeader;
    try {
      nextHeader = parseHeader(readFileSync(pending, 'utf8'));
      if (nextHeader.vaultId !== cur.vaultId) throw new CryptoError('VAULT_CORRUPT');
    } catch {
      // A torn or foreign .next was never acted on (it is fsynced before the rekey starts).
      rmSync(pending, { force: true });
      rmSync(rec, { force: true });
      return 'rolled-back';
    }
    let record: RotationRecord | null = null;
    if (hasRec) {
      try {
        const r = rotationSchema.safeParse(JSON.parse(readFileSync(rec, 'utf8')));
        if (r.success && r.data.vaultId === cur.vaultId) record = r.data;
      } catch {
        record = null;
      }
    }
    const persisted = persistedFailures(cur, now(), opts.dir);
    const until = lockedOutUntil(effectiveFailures(cur.vaultId, persisted), now());
    if (until !== null) throw new CryptoError('RATE_LIMITED', until);

    let oldDek = await unwrapHeader(cur, opts.password);
    let newDek = await unwrapHeader(nextHeader, opts.password);
    try {
      if (record && oldDek && !newDek) newDek = unwrapDek(oldDek, record.oldToNew, cur.vaultId);
      if (record && newDek && !oldDek) oldDek = unwrapDek(newDek, record.newToOld, cur.vaultId);
      if (!oldDek && !newDek) {
        persistFailureState(opts.dir, recordFailure(cur.vaultId, persisted, now()));
        throw new CryptoError('BAD_CREDENTIALS');
      }
      if (newDek && opts.probe(newDek.toString('hex'))) {
        renameSync(pending, vaultFilePath(opts.dir));
        rmSync(rec, { force: true });
        resetFailures(cur.vaultId);
        return 'completed';
      }
      if (oldDek && opts.probe(oldDek.toString('hex'))) {
        rmSync(pending, { force: true });
        rmSync(rec, { force: true });
        return 'rolled-back';
      }
      // Neither key opens the DB: keep every file for manual recovery (restore a backup).
      throw new CryptoError('VAULT_CORRUPT');
    } finally {
      if (oldDek) zeroize(oldDek);
      if (newDek) zeroize(newDek);
    }
  });
}
