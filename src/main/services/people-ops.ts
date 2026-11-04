/**
 * Mutation primitives shared by the requests, responses and review services. None of these audit or open their own
 * top-level transaction: callers run them inside ctx.tx() and append exactly one audit event per public call.
 */
import type {
  ObservedPerson,
  PersonName,
  RequestItem,
  ResponseRow,
  RowMatch,
  Ulid,
  VettingRecord,
} from '@shared/domain/types';
import { buildNameKey, coreKeyOf } from '@shared/names/key';
import { foldIdentifier } from '@shared/names/normalize';
import type { PersonInput } from '../db/repos';
import { dobFromRaw } from '../matching/dob';
import { observedName, parseSex } from '../matching/records';
import { applyExportPolicy, isManual, snapshotFor } from './vetting-status';
import { blankToNull, fail } from './vetting-common';
import type { Ctx } from './vetting-common';

export function keysOf(name: PersonName): { coreKey: string | null; fullKey: string | null } {
  const k = buildNameKey(name);
  return { coreKey: coreKeyOf(k) || null, fullKey: k.fullTokens.join(' ') || null };
}

export function personInputFromObserved(o: ObservedPerson, itemId: Ulid, createdByRequestId: Ulid | null): PersonInput {
  const canonical = observedName(o);
  const dob = dobFromRaw(o.dob);
  const issuing = blankToNull(o.nationality);
  const identifiers: PersonInput['identifiers'] = [];
  for (const [type, value] of [
    ['passport', o.passport],
    ['national-id', o.nationalId],
  ] as const) {
    const f = foldIdentifier(value);
    if (f !== '')
      identifiers.push({
        type,
        value: value.trim(),
        valueFolded: f,
        issuingCountry: issuing,
        sourceKind: 'request-item',
        sourceId: itemId,
      });
  }
  return {
    canonical,
    ...keysOf(canonical),
    dob: dob.date,
    dobPrecision: dob.precision,
    sex: parseSex(o.sex),
    pob: { city: blankToNull(o.pobCity), state: blankToNull(o.pobState), country: blankToNull(o.pobCountry) },
    nationality: issuing,
    createdByRequestId,
    identifiers,
  };
}

export function personInputFromRow(row: ResponseRow, createdByRequestId: Ulid | null): PersonInput {
  const dob = dobFromRaw(row.dob);
  return {
    canonical: row.name,
    ...keysOf(row.name),
    dob: dob.date,
    dobPrecision: dob.precision,
    sex: null,
    pob: row.pob,
    nationality: null,
    createdByRequestId,
  };
}

/** Add `name` as an alias unless the person already carries a name with the same full token set. */
export function addAliasIfNew(ctx: Ctx, personId: Ulid, name: PersonName, sourceKind: string, sourceId: Ulid): boolean {
  const p = ctx.repos.persons.get(personId);
  if (!p) return fail('NOT_FOUND', 'Person not found');
  const full = buildNameKey(name).fullTokens.join(' ');
  if (full === '') return false;
  if ([p.canonical, ...p.aliases].some((n) => buildNameKey(n).fullTokens.join(' ') === full)) return false;
  ctx.repos.persons.addAlias(personId, {
    ...name,
    coreKey: keysOf(name).coreKey,
    sourceKind,
    sourceId,
    seenAt: ctx.nowIso(),
  });
  return true;
}

/** Add the passport / national ID seen on an observation when the person does not hold that value yet. */
export function addIdentifiersIfNew(ctx: Ctx, personId: Ulid, o: ObservedPerson, sourceId: Ulid): number {
  const p = ctx.repos.persons.get(personId);
  if (!p) return fail('NOT_FOUND', 'Person not found');
  let n = 0;
  for (const [type, value] of [
    ['passport', o.passport],
    ['national-id', o.nationalId],
  ] as const) {
    const f = foldIdentifier(value);
    if (f === '' || p.identifiers.some((i) => i.type === type && i.valueFolded === f)) continue;
    ctx.repos.persons.addIdentifier(personId, {
      type,
      value: value.trim(),
      valueFolded: f,
      issuingCountry: blankToNull(o.nationality),
      sourceKind: 'request-item',
      sourceId,
    });
    n++;
  }
  return n;
}

export const isIndividualSection = (s: ResponseRow['section']): boolean =>
  s === 'approved-individual' || s === 'nonapproved-individual';
export const isApprovedSection = (s: ResponseRow['section']): boolean =>
  s === 'approved-individual' || s === 'approved-unit';
export const isLinkedDecision = (m: RowMatch): boolean => m.decision === 'auto' || m.decision === 'confirmed';

/**
 * Disposition a row states: its classified DISP (lane C, `dispClass`; a reviewer may have set or corrected it, lane K).
 * A row whose disposition is unclear ('unknown') never yields a vetting record: callers check first, this guards.
 */
export function rowDisposition(row: ResponseRow): 'approved' | 'non-approved' {
  if (row.dispClass === 'approved' || row.dispClass === 'non-approved') return row.dispClass;
  return fail('CONFLICT', 'The disposition of this row is unclear; set it first');
}

/** Vetting record exactly as stated by a DC row: cert date and expiry from the file, never computed. */
export function recordFromRow(
  ctx: Ctx,
  row: ResponseRow,
  personId: Ulid,
  unitId: Ulid | null,
  requestId: Ulid | null,
): Omit<VettingRecord, 'id'> {
  return {
    personId,
    unitId,
    requestId,
    responseRowId: row.id,
    // S-06 (lane C): the classified DISP; never a record for a row whose dispClass is 'unknown'.
    disposition: rowDisposition(row),
    certDate: row.certDate.parsed,
    expiresAt: row.expires.parsed,
    expiryAssumed: false,
    source: 'dc-file',
    recordedAt: ctx.nowIso(),
    recordedBy: ctx.actor(),
    note: '',
  };
}

/** Create the vetting records of linked individual rows answering `item` that have none yet. Returns the count. */
export function materializeRecordsForItem(ctx: Ctx, item: RequestItem): number {
  if (!item.personId) return 0;
  let n = 0;
  for (const row of ctx.repos.responses.rowsByRequestItem(item.id)) {
    if (!isIndividualSection(row.section) || !isLinkedDecision(row.match)) continue;
    ctx.repos.responses.setRowMatch(row.id, row.match, { requestItemId: item.id, personId: item.personId });
    if (row.dispClass === 'unknown' || ctx.repos.vetting.listByResponseRow(row.id).length > 0) continue;
    ctx.repos.vetting.insert(recordFromRow(ctx, row, item.personId, item.unitId, item.requestId));
    const resp = ctx.repos.responses.getHeader(row.responseId);
    if (resp) addAliasIfNew(ctx, item.personId, row.name, `response:${resp.id}`, item.id);
    n++;
  }
  return n;
}

/** Recompute prior + export decision of an item (manual decisions are kept). */
export function refreshItemPolicy(ctx: Ctx, itemId: Ulid): RequestItem {
  const item = ctx.repos.requests.getItem(itemId);
  if (!item) return fail('NOT_FOUND', 'Request item not found');
  const prior = item.personId ? snapshotFor(ctx, item.personId) : null;
  const patch: Parameters<Ctx['repos']['requests']['updateItem']>[1] = { prior };
  if (!isManual(item.exportDecision)) {
    const o = applyExportPolicy({ linkState: item.linkState, prior, unitId: item.unitId }, ctx.settings().exportPolicy);
    patch.exportDecision = o.decision;
    patch.exportReason = o.reason;
  }
  return ctx.repos.requests.updateItem(itemId, patch);
}

/** Link a request item to a person (explicit or confirmed); learns aliases/identifiers and resolves its link reviews. */
export function linkItemToPerson(
  ctx: Ctx,
  itemId: Ulid,
  personId: Ulid,
  linkState: 'confirmed' | 'new-person' | 'auto',
): RequestItem {
  const item = ctx.repos.requests.getItem(itemId);
  if (!item) return fail('NOT_FOUND', 'Request item not found');
  const person = ctx.repos.persons.get(personId);
  if (!person || person.state !== 'active') return fail('CONFLICT', 'Person is not active');
  ctx.repos.requests.updateItem(itemId, { personId, linkState });
  addAliasIfNew(ctx, personId, observedName(item.observed), 'request-item', itemId);
  addIdentifiersIfNew(ctx, personId, item.observed, itemId);
  for (const r of ctx.repos.reviews.openForSubject(itemId))
    if (r.kind === 'request-item-link') ctx.repos.reviews.resolve(r.id, 'resolved', 'linked', ctx.nowIso());
  const linked = ctx.repos.requests.getItem(itemId)!;
  materializeRecordsForItem(ctx, linked);
  return refreshItemPolicy(ctx, itemId);
}

/** Create a person from a request item's observation (explicit user action) and link it. */
export function createPersonForItem(ctx: Ctx, itemId: Ulid): RequestItem {
  const item = ctx.repos.requests.getItem(itemId);
  if (!item) return fail('NOT_FOUND', 'Request item not found');
  const p = ctx.repos.persons.insert({
    ...personInputFromObserved(item.observed, item.id, item.requestId),
    at: ctx.nowIso(),
  });
  return linkItemToPerson(ctx, itemId, p.id, 'new-person');
}
