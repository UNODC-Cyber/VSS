// Lane K renderer fixtures: a DC response row without candidates in the mock DB (synthetic data only).
import type { DcResponse, ResponseRow } from '../../../src/shared/domain/types';
import { nameKey, newId, rawDate } from '../../../src/renderer/src/mock/db';
import type { MockControl } from '../../../src/renderer/src/mock/mockApi';

export function addUnmatchedRow(
  ctl: MockControl,
  nameRaw = 'UNLISTED, Person',
  over: Partial<ResponseRow> = {},
  requestId: string | null = null,
): { row: ResponseRow; reviewId: string; resp: DcResponse } {
  const [surname = '', given = ''] = nameRaw.split(', ');
  const respId = newId();
  const row: ResponseRow = {
    id: newId(),
    responseId: respId,
    rowRef: 'S9',
    section: 'approved-individual',
    disp: 'APPROVED',
    nameRaw,
    name: { surname, given: given.split(' ').filter(Boolean), raw: nameRaw, script: 'Latn' },
    nameKey: nameKey(surname, given.split(' ')),
    dob: rawDate('1975-01-01'),
    pob: { city: null, state: null, country: 'Exampleland' },
    unitType: 'Other',
    unitName: 'Sample Other Agency C',
    certDate: rawDate('2026-10-20'),
    expires: rawDate('2027-10-20'),
    match: { candidates: [], decision: 'none', chosen: null, decidedBy: null, decidedAt: null },
    dispClass: 'approved',
    sectionSource: 'label',
    ...over,
  };
  const resp: DcResponse = {
    id: respId,
    batchId: 'BATCH-T',
    post: 'Example Post',
    resultsAsOf: '2026-10-20',
    assistanceLine: 'Synthetic line',
    sourceFile: {
      id: newId(),
      originalName: 'resp.xlsx',
      sha256: 'd'.repeat(64),
      bytes: 1,
      storedAt: '2026-10-21T08:00:00.000Z',
    },
    importedAt: '2026-10-21T08:00:00.000Z',
    requestId,
    rows: [row],
  };
  ctl.db.responses.push(resp);
  const reviewId = newId();
  ctl.db.reviews.push({
    id: reviewId,
    kind: 'unmatched-response-row',
    createdAt: '2026-10-21T08:00:00.000Z',
    subjectIds: [row.id],
    candidates: [],
    state: 'open',
    resolution: null,
  });
  return { row, reviewId, resp };
}
