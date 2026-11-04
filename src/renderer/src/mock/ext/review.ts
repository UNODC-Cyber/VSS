/**
 * LANE K mock (docs/PLAN-ALPHA.md section 14): person suggestions, review list context, manual validation, edit in
 * place, set-disposition, and the review kinds the base mock leaves unresolved (unmatched response rows). Mirrors the
 * real service closely enough for the renderer tests and the mock journey; never links anything automatically.
 * Everything it stores is synthetic mock data.
 */
import type { DcResponse, Person, ResponseRow, ReviewItem, VettingRecord } from '@shared/domain/types';
import type {
  PersonSuggestion,
  PersonSummary,
  Result,
  ReviewCounts,
  ReviewItemDetail,
  ReviewResolveRequest,
  ReviewSubject,
} from '@shared/ipc/contract';
import { appendAudit, makePerson, nameKey, newId, rawDate } from '../db';
import { mockFail, mockOk } from './types';
import type { MockExtension } from './types';

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const PARTICLES = new Set(['bin', 'binti', 'van', 'von', 'de', 'da', 'al', 'el']);
/** Same token rules as the real service: commas / whitespace split, particles dropped unless nothing else is left. */
export function mockTokens(text: string): string[] {
  const all = [
    ...new Set(
      fold(text)
        .split(/[\s,;]+/)
        .filter(Boolean),
    ),
  ];
  const core = all.filter((t) => !PARTICLES.has(t));
  return core.length > 0 ? core : all;
}

export const reviewMock: MockExtension = ({ db, emit, api: base }) => {
  /** Rows as the DC stated them before the first correction (mock's original_json). */
  const originals = new Map<string, ResponseRow>();
  const notes = new Map<string, string>();

  const findRow = (id: string): { resp: DcResponse; row: ResponseRow } | null => {
    for (const resp of db.responses) {
      const row = resp.rows.find((r) => r.id === id);
      if (row) return { resp, row };
    }
    return null;
  };
  const findItem = (id: string) => {
    for (const req of db.requests) {
      const item = req.items.find((i) => i.id === id);
      if (item) return { req, item };
    }
    return null;
  };
  const counts = (): ReviewCounts => {
    const byKind: ReviewCounts['byKind'] = {};
    const open = db.reviews.filter((r) => r.state === 'open');
    for (const r of open) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    return { open: open.length, byKind };
  };
  const push = (): void => emit('review:counts', counts());
  const locked = (): Result<never> | null =>
    db.vault.locked ? mockFail('VAULT_LOCKED', 'The vault is locked.') : null;

  /** The real import opens an 'unmatched-response-row' item for every row without a candidate; so does the mock. */
  function syncUnmatched(): void {
    for (const resp of db.responses)
      for (const row of resp.rows)
        if (row.match.decision === 'none' && !db.reviews.some((r) => r.subjectIds.includes(row.id)))
          db.reviews.push({
            id: newId(),
            kind: 'unmatched-response-row',
            createdAt: resp.importedAt,
            subjectIds: [row.id],
            candidates: [],
            state: 'open',
            resolution: null,
          });
  }

  const nameOf = (p: Person): string => `${p.canonical.surname}, ${p.canonical.given.join(' ')}`;
  const hay = (p: Person): string =>
    fold([nameOf(p), ...p.aliases.map((a) => a.raw), p.dob ?? '', ...p.identifiers.map((i) => i.value)].join(' '));

  async function summaries(ids: string[]): Promise<PersonSummary[]> {
    const all = await base.persons.list({ offset: 0, limit: 10_000 });
    if (!all.ok) return [];
    const byId = new Map(all.value.items.map((s) => [s.id, s]));
    return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  }

  function recordFromRow(row: ResponseRow, personId: string, requestId: string | null, unitId: string | null): void {
    const rec: VettingRecord = {
      id: newId(),
      personId,
      unitId,
      requestId,
      responseRowId: row.id,
      disposition: row.dispClass === 'non-approved' ? 'non-approved' : 'approved',
      certDate: row.certDate.parsed,
      expiresAt: row.expires.parsed,
      expiryAssumed: false,
      source: 'dc-file',
      recordedAt: new Date().toISOString(),
      recordedBy: 'mock-user',
      note: '',
    };
    db.records.push(rec);
  }

  function personFromRow(row: ResponseRow): Person {
    const p = makePerson(row.name.surname, row.name.given, row.dob.parsed);
    db.persons.push(p);
    return p;
  }

  function linkRowToPerson(resp: DcResponse, row: ResponseRow, personId: string, itemId: string | null): void {
    row.match = {
      ...row.match,
      decision: 'confirmed',
      chosen: itemId ?? personId,
      decidedBy: 'mock-user',
      decidedAt: new Date().toISOString(),
    };
    const f = itemId ? findItem(itemId) : null;
    if (f) {
      f.item.personId = personId;
      f.item.linkState = 'confirmed';
    }
    if (!db.records.some((r) => r.responseRowId === row.id))
      recordFromRow(row, personId, resp.requestId, f?.item.unitId ?? null);
  }

  function rowSubjectFor(id: string, row: ResponseRow, resp: DcResponse): ReviewSubject {
    const s = (r: ResponseRow) => ({
      displayName: r.nameRaw,
      dob: r.dob.parsed,
      dobRaw: r.dob.value,
      pobCountry: r.pob.country,
      unitName: r.unitName,
    });
    const orig = originals.get(id);
    return {
      id,
      kind: 'response-row',
      ...s(row),
      sex: null,
      identifiers: [],
      source: `Response ${resp.batchId}, row ${row.rowRef}`,
      edited: !!orig,
      ...(orig ? { original: s(orig) } : {}),
    };
  }

  const close = (rv: ReviewItem, resolution: string, state: 'resolved' | 'dismissed' = 'resolved'): void => {
    rv.state = state;
    rv.resolution = resolution;
  };

  return {
    persons: {
      suggest: async (req) => {
        const l = locked();
        if (l) return l;
        syncUnmatched();
        let subjectId = req.forSubject.id;
        let stored: ReviewItem['candidates'] = [];
        const self = new Set<string>();
        if (req.forSubject.kind === 'review-item') {
          const rv = db.reviews.find((r) => r.id === req.forSubject.id);
          if (!rv) return mockFail('NOT_FOUND', 'Review item not found.');
          subjectId = rv.subjectIds[0] ?? '';
          stored = rv.candidates;
          for (const s of rv.subjectIds) if (db.persons.some((p) => p.id === s)) self.add(s);
        }
        const fr = findRow(subjectId);
        const fi = findItem(subjectId);
        const surname = fold(fr?.row.name.surname ?? fi?.item.observed.surname ?? '');
        const requestId = fr?.resp.requestId ?? fi?.req.id ?? null;
        const hits = new Map<string, Omit<PersonSuggestion, 'person'>>();
        const add = (id: string | null | undefined, h: Omit<PersonSuggestion, 'person'>) => {
          if (id && !self.has(id) && !hits.has(id)) hits.set(id, h);
        };
        for (const c of stored)
          add(c.targetKind === 'person' ? c.targetId : findItem(c.targetId)?.item.personId, {
            tier: c.tier,
            evidence: c.evidence,
            why: 'candidate',
          });
        const active = db.persons.filter((p) => p.state === 'active');
        if (surname)
          for (const p of active)
            if (fold(p.canonical.surname) === surname)
              add(p.id, { tier: 'T3', evidence: ['NAME_SURNAME_EQUAL'], why: 'candidate' });
        const rq = requestId ? db.requests.find((r) => r.id === requestId) : undefined;
        for (const i of rq?.items ?? []) add(i.personId, { tier: null, evidence: [], why: 'recent' });
        // Search the typed text, else the subject's own name; typed text also narrows the list (as the service).
        const typed = req.text && req.text.trim() !== '' ? req.text : null;
        const subjectName = fr?.row.nameRaw ?? (fi ? `${fi.item.observed.surname} ${fi.item.observed.name1}` : '');
        const tokens = mockTokens(typed ?? subjectName);
        let found: Person[] = [];
        if (tokens.length > 0) {
          found = active.filter((p) => tokens.every((t) => hay(p).includes(t)));
          if (found.length === 0) found = active.filter((p) => tokens.some((t) => hay(p).includes(t)));
        }
        if (typed) for (const id of [...hits.keys()]) if (!found.some((p) => p.id === id)) hits.delete(id);
        for (const p of found) add(p.id, { tier: null, evidence: [], why: 'search' });
        const limit = Math.min(Math.max(req.limit ?? 20, 1), 50);
        const ids = [...hits.keys()].filter((id) => active.some((p) => p.id === id)).slice(0, limit);
        const sums = await summaries(ids);
        return mockOk(sums.map((person) => ({ person, ...hits.get(person.id)! })));
      },
    },
    review: {
      counts: () => {
        syncUnmatched();
        return base.review.counts();
      },
      list: async (q) => {
        syncUnmatched();
        const r = await base.review.list(q);
        if (!r.ok) return r;
        for (const s of r.value.items) {
          const first = s.subjectIds[0] ?? '';
          const fr = findRow(first);
          const fi = findItem(first);
          s.context = fr
            ? { responseId: fr.resp.id, batchId: fr.resp.batchId }
            : fi
              ? { requestId: fi.req.id, eventName: fi.req.eventName }
              : null;
          if (fr) {
            s.subjectName = fr.row.nameRaw;
            s.subjectDob = fr.row.dob.parsed;
            s.unitName = fr.row.unitName || null;
          }
        }
        return r;
      },
      get: (req) => {
        syncUnmatched();
        return reviewGet(req.id);
      },
      resolve: async (req: ReviewResolveRequest) => {
        const l = locked();
        if (l) return l;
        const rv = db.reviews.find((x) => x.id === req.id);
        const a = req.resolution;
        const fr = rv ? findRow(rv.subjectIds[0] ?? '') : null;
        const own = rv && fr && (rv.kind === 'unmatched-response-row' || rv.kind === 'disposition-unclear');
        if (!rv || !own || !fr || (a.action !== 'link' && a.action !== 'new-person' && a.action !== 'set-disposition'))
          return base.review.resolve(req);
        if (rv.state !== 'open') return mockFail('CONFLICT', 'Review item is already closed.');
        if (a.action === 'set-disposition') {
          if (!originals.has(fr.row.id)) originals.set(fr.row.id, structuredClone(fr.row));
          fr.row.dispClass = a.disposition;
          close(rv, `set-disposition:${a.disposition}`);
        } else if (a.action === 'new-person') {
          linkRowToPerson(fr.resp, fr.row, personFromRow(fr.row).id, null);
          close(rv, 'new-person');
        } else {
          const item = findItem(a.targetId);
          const personId = item ? item.item.personId : a.targetId;
          if (!personId || !db.persons.some((p) => p.id === personId && p.state === 'active'))
            return mockFail('NOT_FOUND', 'Target not found.');
          linkRowToPerson(fr.resp, fr.row, personId, item ? a.targetId : null);
          close(rv, 'linked');
        }
        appendAudit(db, 'review.resolve', 'review', rv.id, 0, { action: a.action });
        push();
        return mockOk(counts());
      },
      manualValidate: (req) => {
        const l = locked();
        if (l) return Promise.resolve(l);
        if (req.reason.trim().length < 3)
          return Promise.resolve(mockFail('REASON_REQUIRED', 'A reason of at least 3 characters is required.'));
        const rv = db.reviews.find((x) => x.id === req.id);
        if (!rv) return Promise.resolve(mockFail('NOT_FOUND', 'Review item not found.'));
        if (rv.state !== 'open') return Promise.resolve(mockFail('CONFLICT', 'Review item is already closed.'));
        const fr = rv.subjectIds.map(findRow).find((x) => x !== null) ?? null;
        if (!fr) return Promise.resolve(mockFail('BAD_REQUEST', 'Manual validation needs a response row.'));
        if (fr.row.dispClass === 'unknown')
          return Promise.resolve(mockFail('BAD_REQUEST', 'Set the disposition first.'));
        if (db.records.some((r) => r.responseRowId === fr.row.id))
          return Promise.resolve(mockFail('CONFLICT', 'The row is already linked; unlink it first.'));
        const t = req.target;
        let personId: string;
        let itemId: string | null = null;
        if (t.kind === 'person') {
          if (!db.persons.some((p) => p.id === t.personId && p.state === 'active'))
            return Promise.resolve(mockFail('NOT_FOUND', 'Person not found.'));
          personId = t.personId;
        } else if (t.kind === 'request-item') {
          const f = findItem(t.itemId);
          if (!f) return Promise.resolve(mockFail('NOT_FOUND', 'Request item not found.'));
          personId = f.item.personId ?? personFromRow(fr.row).id;
          itemId = f.item.id;
        } else personId = personFromRow(fr.row).id;
        linkRowToPerson(fr.resp, fr.row, personId, itemId);
        close(rv, 'manual-validate');
        notes.set(rv.id, req.reason.trim());
        appendAudit(db, 'review.manual-validate', 'review', rv.id, 0, {
          targetKind: t.kind,
          reasonLength: req.reason.trim().length,
        });
        push();
        return Promise.resolve(mockOk(counts()));
      },
      editSubject: async (req) => {
        const l = locked();
        if (l) return l;
        if (req.reason.trim().length < 3)
          return mockFail('REASON_REQUIRED', 'A reason of at least 3 characters is required.');
        const rv = db.reviews.find((x) => x.id === req.id);
        if (!rv) return mockFail('NOT_FOUND', 'Review item not found.');
        const s = req.subject;
        if (s.kind === 'person') {
          const p = db.persons.find((x) => x.id === s.personId);
          if (!p) return mockFail('NOT_FOUND', 'Person not found.');
          Object.assign(p, s.patch, { updatedAt: new Date().toISOString() });
        } else {
          const fr = findRow(s.rowId);
          if (!fr || !rv.subjectIds.includes(s.rowId))
            return mockFail('BAD_REQUEST', 'The row is not part of this item.');
          if (db.records.some((r) => r.responseRowId === s.rowId))
            return mockFail('CONFLICT', 'The row is already linked; unlink it first.');
          const p = s.patch;
          if (Object.keys(p).length === 0) {
            const orig = originals.get(s.rowId);
            if (!orig) return mockFail('BAD_REQUEST', 'The row has not been corrected.');
            Object.assign(fr.row, structuredClone(orig));
            originals.delete(s.rowId);
          } else {
            if (!originals.has(s.rowId)) originals.set(s.rowId, structuredClone(fr.row));
            const row = fr.row;
            if (p.nameRaw !== undefined) {
              const [surname = '', given = ''] = p.nameRaw.split(',').map((x) => x.trim());
              row.nameRaw = p.nameRaw;
              row.name = { surname, given: given.split(' ').filter(Boolean), raw: p.nameRaw, script: 'Latn' };
              row.nameKey = nameKey(surname, row.name.given);
            }
            if (p.dob !== undefined) row.dob = rawDate(p.dob);
            if (p.pob !== undefined) row.pob = { ...p.pob };
            if (p.unitName !== undefined) row.unitName = p.unitName;
            if (p.certDate !== undefined) row.certDate = rawDate(p.certDate);
            if (p.expires !== undefined) row.expires = rawDate(p.expires);
            if (p.dispClass !== undefined) row.dispClass = p.dispClass;
          }
          rematch(rv, fr.resp, fr.row);
        }
        appendAudit(db, 'review.edit-subject', 'review', rv.id, 0, { subjectKind: s.kind });
        return reviewGet(rv.id);
      },
    },
  };

  /** Candidates of a corrected row against its request, shown again as pending (never auto). */
  function rematch(rv: ReviewItem, resp: DcResponse, row: ResponseRow): void {
    const rq = resp.requestId ? db.requests.find((r) => r.id === resp.requestId) : undefined;
    const cands = (rq?.items ?? [])
      .filter((i) => fold(i.observed.surname) === fold(row.name.surname))
      .map((i) => ({
        targetKind: 'request-item' as const,
        targetId: i.id,
        tier: (i.observed.dob.parsed === row.dob.parsed ? 'T2' : 'T3') as 'T2' | 'T3',
        evidence: ['NAME_SURNAME_EQUAL' as const],
        score: 0.7,
      }));
    row.match = {
      candidates: cands,
      decision: cands.length ? 'pending' : 'none',
      chosen: null,
      decidedBy: null,
      decidedAt: null,
    };
    if (rv.state === 'open') rv.candidates = cands;
  }

  async function reviewGet(id: string): Promise<Result<ReviewItemDetail>> {
    const r = await base.review.get({ id });
    if (!r.ok) return r;
    const rv = db.reviews.find((x) => x.id === id)!;
    const subjects = r.value.subjects.map((s) => {
      const fr = findRow(s.id);
      return fr ? rowSubjectFor(s.id, fr.row, fr.resp) : s;
    });
    for (const id2 of rv.subjectIds) {
      const fr = findRow(id2);
      if (fr && !subjects.some((x) => x.id === id2)) subjects.unshift(rowSubjectFor(id2, fr.row, fr.resp));
    }
    return mockOk({ item: structuredClone(rv), subjects, context: r.value.context ?? null });
  }
};
