// Lane K test fixtures: persons, request items and DC response rows built straight through the repositories.
// Every name, date, unit and identifier is synthetic.
import type { PersonName, ResponseRow, ResponseSection, ReviewKind } from '@shared/domain/types';
import { buildNameKey, coreKeyOf } from '@shared/names/key';
import { personNameFromRequest, splitDcName } from '@shared/names/personName';
import type { ResponseRowInput } from '../../../src/main/db/repos/response';
import { itemInput, observed, personInput, requestInput } from '../db/helpers';
import type { Harness } from './helpers';

export function personNamed(
  h: Harness,
  surname: string,
  given: string[],
  over: Parameters<typeof personInput>[0] = {},
) {
  const canonical: PersonName = personNameFromRequest(surname, ...given);
  const k = buildNameKey(canonical);
  return h.fx.repos.persons.insert({
    ...personInput({ canonical, coreKey: coreKeyOf(k) || null, fullKey: k.fullTokens.join(' ') || null, ...over }),
    at: '2026-10-01T08:00:00.000Z',
  } as Parameters<Harness['fx']['repos']['persons']['insert']>[0]);
}

const raw = (iso: string | null) =>
  iso
    ? { kind: 'text' as const, value: iso, parsed: iso, ambiguousDayMonth: false }
    : { kind: 'empty' as const, value: '', parsed: null, ambiguousDayMonth: false };

export function rowInput(nameRaw: string, over: Partial<ResponseRowInput> = {}): ResponseRowInput {
  const name = splitDcName(nameRaw);
  return {
    rowRef: 'Results!B12',
    section: 'approved-individual' as ResponseSection,
    disp: 'APPROVED',
    nameRaw,
    name,
    nameKey: buildNameKey(name),
    dob: raw('1990-03-12'),
    pob: { city: null, state: null, country: 'Testland' },
    unitType: 'Police',
    unitName: 'Synthetic Unit One',
    certDate: raw('2026-10-20'),
    expires: raw('2027-10-20'),
    match: { candidates: [], decision: 'none', chosen: null, decidedBy: null, decidedAt: null },
    ...over,
  };
}

/** A request with one unlinked item (synthetic observation). */
export function requestWithItem(h: Harness, surname = 'Testsurname', name1 = 'Synthetic') {
  const unit = h.fx.repos.units.insert({
    name: 'Synthetic Unit One',
    type: 'Police',
    country: 'Testland',
  } as Parameters<Harness['fx']['repos']['units']['insert']>[0]);
  const req = h.fx.repos.requests.insert(
    requestInput({ status: 'sent-to-dc', sentToDcAt: '2026-10-10T08:00:00.000Z' }),
    [itemInput({ observed: observed({ surname, name1, rowRef: 'Data!A20' }), unitId: unit.id })],
  );
  return { req, item: req.items[0]!, unit };
}

/** A DC response (optionally answering `requestId`) with the given rows and one review item per row. */
export function responseWithRows(
  h: Harness,
  rows: ResponseRowInput[],
  opts: { requestId?: string | null; kind?: ReviewKind } = {},
) {
  const f = h.fx.repos.files.put({ originalName: 'synthetic-response.xlsx', content: new TextEncoder().encode('x') });
  const resp = h.fx.repos.responses.insert(
    {
      batchId: 'SYN-BATCH-1',
      post: 'Synthetic Post',
      resultsAsOf: '2026-10-20',
      assistanceLine: 'Synthetic line',
      sourceFileId: f.id,
      importedAt: '2026-10-21T08:00:00.000Z',
      requestId: opts.requestId ?? null,
    },
    rows,
  );
  const reviews = resp.rows.map((r: ResponseRow) =>
    h.fx.repos.reviews.insert({
      kind: opts.kind ?? 'unmatched-response-row',
      subjectIds: [r.id],
      candidates: r.match.candidates,
      createdAt: '2026-10-21T08:00:00.000Z',
    }),
  );
  return { resp, rows: resp.rows, reviews };
}

/** Snapshot of everything a suggestion must never change. */
export function identityState(h: Harness) {
  const q = (sql: string) => JSON.stringify(h.fx.db.prepare(sql).all());
  return {
    rows: q('SELECT id, match_json, request_item_id, person_id FROM response_row ORDER BY id'),
    items: q('SELECT id, person_id, link_state FROM request_item ORDER BY id'),
    persons: q('SELECT id, state, merged_into FROM person ORDER BY id'),
    records: q('SELECT id FROM vetting_record ORDER BY id'),
    reviews: q('SELECT id, state, resolution FROM review_item ORDER BY id'),
    audit: h.auditCount(),
  };
}
