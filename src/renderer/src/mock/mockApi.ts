/**
 * Complete in-memory implementation of `VssApi` for development, unit tests and Playwright journeys.
 * Enabled only by `?mock=1` in a development build (see main.tsx); excluded from production bundles.
 * All data is synthetic. Behaviour mirrors the contract in src/shared/ipc/contract.ts closely enough that every
 * screen can be exercised, but it is NOT the real backend: matching, parsing and export are faked from fixtures.
 */
import { addDays, daysBetween, deriveSnapshot, isRequestAwaitingResponse } from '@shared/domain/status';
import type {
  DcResponse,
  ExportDecision,
  IsoDate,
  MatchCandidate,
  Person,
  RequestItem,
  ResponseRow,
  VettingRecord,
  VettingRequest,
  VettingStatus,
  VettingStatusSnapshot,
} from '@shared/domain/types';
import type {
  Ack,
  BackupConfigPublic,
  BackupFileInfo,
  BackupListResult,
  Dashboard,
  EmailDraft,
  ExpiryWatchRow,
  ImportPreview,
  ImportPreviewItem,
  Page,
  PersonDetail,
  PersonSummary,
  RequestSummary,
  ResponsePreview,
  TemplateInfo,
  TemplateList,
  ResponseSummary,
  Result,
  ReviewCounts,
  ReviewSubject,
  UnitDetail,
  UnitSummary,
  UpdateState,
  VaultStatus,
  VssApi,
  VssError,
  VssErrorCode,
  VssEventMap,
  VssEventName,
} from '@shared/ipc/contract';
import {
  appendAudit,
  emptyDb,
  isoDay,
  isoTime,
  makePerson,
  nameKey,
  newId,
  observedFor,
  observedUnit,
  rawDate,
  seed,
} from './db';
import type { MockDb } from './db';
import { mockTemplate } from './db';

export interface MockOptions {
  /** Initial vault state. Default 'no-vault'. */
  state?: 'no-vault' | 'locked' | 'unlocked';
  /** Load demo data. Default true. */
  seed?: boolean;
  /** Vault password for 'locked'/'unlocked'. Default 'correct horse battery staple'. */
  password?: string;
  /** Run the 1 s idle timer. Default true. */
  idleTimer?: boolean;
}

export interface MockControl {
  api: VssApi;
  db: MockDb;
  emit: <E extends VssEventName>(name: E, payload: VssEventMap[E]) => void;
  /** Advance the idle clock by n seconds (drives warning + auto-lock). */
  fastForwardIdle: (seconds: number) => void;
  dispose: () => void;
}

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (code: VssErrorCode, message: string): Result<never> => ({
  ok: false,
  error: { code, message } as VssError,
});
const ACK: Ack = { ok: true };

export const MOCK_PASSWORD = 'correct horse battery staple';

function page<T>(all: T[], offset: number, limit: number): Page<T> {
  return { items: all.slice(offset, offset + limit), total: all.length, offset, limit };
}
function today(): IsoDate {
  return isoDay(0);
}
function includes(hay: string, needle: string | undefined): boolean {
  return !needle || hay.toLowerCase().includes(needle.toLowerCase());
}

export function createMockApi(opts: MockOptions = {}): MockControl {
  const db = emptyDb();
  const password = opts.password ?? MOCK_PASSWORD;
  const listeners = new Map<VssEventName, Set<(p: never) => void>>();
  const previews = new Map<string, ImportPreview>();
  const respPreviews = new Map<string, { preview: ResponsePreview; requestId: string | null }>();
  const answered = new Set<string>();
  let idleSeconds = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let clipTimer: ReturnType<typeof setTimeout> | null = null;
  let update: UpdateState = {
    phase: 'idle',
    currentVersion: '0.1.0',
    availableVersion: null,
    releaseNotes: null,
    downloadedBytes: 0,
    totalBytes: null,
    checkedAt: null,
    message: null,
  };
  let peer = { enabled: false, listening: false, ownFingerprint: null as string | null, peers: [] as never[] };

  const initial = opts.state ?? 'no-vault';
  if (initial !== 'no-vault') {
    db.vault.exists = true;
    db.vault.password = password;
    db.vault.path = 'mock://vault/vault.json';
    db.vault.slots = [{ id: 'slot-pw', kind: 'password', label: 'Password', createdAt: isoTime(-90) }];
    if (opts.seed !== false) seed(db);
    db.vault.locked = initial === 'locked';
  }

  function emit<E extends VssEventName>(name: E, payload: VssEventMap[E]): void {
    for (const l of listeners.get(name) ?? []) (l as (p: VssEventMap[E]) => void)(payload);
  }

  function status(): VaultStatus {
    const limit = db.settings.autoLockMinutes * 60;
    return {
      state: !db.vault.exists ? 'no-vault' : db.vault.locked ? 'locked' : 'unlocked',
      vaultPath: db.vault.path,
      slots: db.vault.slots,
      autoLockInSeconds: db.vault.locked ? null : Math.max(0, limit - idleSeconds),
      failedAttempts: db.vault.failed,
      lockedOutUntil: db.vault.lockedOutUntil,
    };
  }

  function lockNow(reason: VssEventMap['vault:locked']['reason']): void {
    if (db.vault.locked) return;
    db.vault.locked = true;
    idleSeconds = 0;
    stopTimer();
    appendAudit(db, 'vault.locked', 'vault', null, 0, { reason });
    emit('vault:locked', { reason });
  }
  function startTimer(): void {
    stopTimer();
    if (opts.idleTimer === false) return;
    timer = setInterval(() => tickIdle(1), 1000);
  }
  function stopTimer(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }
  function tickIdle(sec: number): void {
    if (db.vault.locked) return;
    idleSeconds += sec;
    const remaining = db.settings.autoLockMinutes * 60 - idleSeconds;
    if (remaining <= 0) lockNow('idle');
    else if (remaining <= 30) emit('vault:lock-warning', { secondsRemaining: remaining });
  }
  function unlockedStatus(): VaultStatus {
    db.vault.locked = false;
    db.vault.failed = 0;
    db.vault.lockedOutUntil = null;
    idleSeconds = 0;
    startTimer();
    const s = status();
    appendAudit(db, 'vault.unlocked', 'vault', null);
    emit('vault:unlocked', s);
    emit('review:counts', reviewCounts());
    return s;
  }

  const locked = (): Result<never> | null => (db.vault.locked ? fail('VAULT_LOCKED', 'The vault is locked.') : null);
  function gate<T>(fn: () => Result<T>): Promise<Result<T>> {
    const l = locked();
    return Promise.resolve(l ?? fn());
  }

  // ---- derived data -----------------------------------------------------------------------------------------
  function snapshotFor(personId: string): VettingStatusSnapshot {
    const recs = db.records.filter((r) => r.personId === personId);
    const pending = db.requests.some(
      (r) => isRequestAwaitingResponse(r.status) && r.items.some((i) => i.personId === personId),
    );
    return deriveSnapshot({
      records: recs,
      pending,
      asOf: today(),
      expiringWithinDays: db.settings.exportPolicy.expiringWithinDays,
    });
  }
  function personName(p: Person): string {
    return `${p.canonical.surname}, ${p.canonical.given.join(' ')}`;
  }
  function itemName(i: RequestItem): string {
    return `${i.observed.surname}, ${[i.observed.name1, i.observed.name2, i.observed.name3, i.observed.name4].filter(Boolean).join(' ')}`;
  }
  function personSummary(p: Person): PersonSummary {
    const snap = snapshotFor(p.id);
    const unit = db.units.find((u) => u.id === snap.unitId);
    return {
      id: p.id,
      displayName: personName(p),
      dob: p.dob,
      dobPrecision: p.dobPrecision,
      sex: p.sex,
      nationality: p.nationality,
      status: snap.status,
      certDate: snap.certDate,
      expiresAt: snap.expiresAt,
      currentUnitName: unit?.name ?? null,
      requestCount: db.requests.filter((r) => r.items.some((i) => i.personId === p.id)).length,
      hasOpenReview: db.reviews.some((r) => r.state === 'open' && r.subjectIds.includes(p.id)),
    };
  }
  function summary(r: VettingRequest): RequestSummary {
    const sentOpen = r.sentToDcAt && !r.respondedAt;
    return {
      id: r.id,
      kind: r.kind,
      receivedAt: r.receivedAt,
      requestor: r.requestor,
      eventName: r.eventName,
      eventStart: r.eventStart,
      eventEnd: r.eventEnd,
      status: r.status,
      sentToDcAt: r.sentToDcAt,
      respondedAt: r.respondedAt,
      responseKind: r.responseKind,
      batchId: r.batchId,
      itemCount: r.items.length,
      unitCount: r.units.length,
      openIssueCount: r.items.reduce((n, i) => n + i.issues.length, 0),
      errorCount: r.items.reduce((n, i) => n + i.issues.filter((x) => x.severity === 'error').length, 0),
      unresolvedLinkCount: r.items.filter((i) => i.linkState === 'pending-review').length,
      answeredCount:
        r.respondedAt && r.responseKind === 'email-clearance'
          ? r.items.length
          : r.items.filter((i) => answered.has(i.id)).length || (r.respondedAt ? r.items.length : 0),
      agingDays: sentOpen ? Math.max(0, daysBetween(r.sentToDcAt!.slice(0, 10), today())) : null,
    };
  }
  function reviewCounts(): ReviewCounts {
    const open = db.reviews.filter((r) => r.state === 'open');
    const byKind: ReviewCounts['byKind'] = {};
    for (const r of open) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    return { open: open.length, byKind };
  }
  function pushCounts(): void {
    emit('review:counts', reviewCounts());
  }
  function findItem(itemId: string): { req: VettingRequest; item: RequestItem } | null {
    for (const req of db.requests) {
      const item = req.items.find((i) => i.id === itemId);
      if (item) return { req, item };
    }
    return null;
  }
  function createPersonFrom(item: RequestItem): Person {
    const o = item.observed;
    const p = makePerson(o.surname, [o.name1, o.name2, o.name3, o.name4].filter(Boolean), o.dob.parsed, {
      sex: o.sex === 'M' || o.sex === 'F' ? o.sex : null,
      nationality: o.nationality || null,
    });
    db.persons.push(p);
    appendAudit(db, 'person.created', 'person', p.id);
    return p;
  }
  function recordFor(
    personId: string,
    disposition: VettingRecord['disposition'],
    certDate: IsoDate | null,
    expiresAt: IsoDate | null,
    source: VettingRecord['source'],
    requestId: string | null,
    unitId: string | null,
    note: string,
    expiryAssumed = false,
  ): VettingRecord {
    const rec: VettingRecord = {
      id: newId(),
      personId,
      unitId,
      requestId,
      responseRowId: null,
      disposition,
      certDate,
      expiresAt,
      expiryAssumed,
      source,
      recordedAt: new Date().toISOString(),
      recordedBy: 'mock-user',
      note,
    };
    db.records.push(rec);
    appendAudit(db, 'record.created', 'person', personId, 0, { disposition, source });
    return rec;
  }
  function refreshPrior(req: VettingRequest): void {
    for (const i of req.items) {
      if (!i.personId) continue;
      const s = snapshotFor(i.personId);
      i.prior = s.status === 'unknown' ? null : s;
    }
  }

  // ---- fixtures -------------------------------------------------------------------------------------------
  function buildRequestPreview(path: string): ImportPreview {
    const uA = db.units[0];
    const find = (sn: string) => db.persons.find((p) => p.canonical.surname === sn);
    const alder = find('Alder');
    const cedar = find('Cedar');
    const unitA = uA?.name ?? 'Sample Police Unit A';
    const mk = (
      rowRef: string,
      displayName: string,
      unitName: string,
      dob: string,
      over: Partial<ImportPreviewItem>,
    ): ImportPreviewItem => ({
      rowRef,
      displayName,
      unitName,
      dob,
      dobRaw: dob,
      issues: [],
      suggestedPersonId: null,
      linkState: 'unlinked',
      candidates: [],
      prior: null,
      exportDecision: 'include',
      exportReason: 'Not previously vetted',
      ...over,
    });
    const cand = (
      id: string,
      tier: MatchCandidate['tier'],
      evidence: MatchCandidate['evidence'],
      score: number,
    ): MatchCandidate => ({
      targetKind: 'person',
      targetId: id,
      tier,
      evidence,
      score,
    });
    const items: ImportPreviewItem[] = [
      mk('R1', 'Alder, Terra', unitA, '1980-03-12', {
        suggestedPersonId: alder?.id ?? null,
        linkState: 'auto',
        candidates: alder ? [cand(alder.id, 'T1', ['NAME_CORE_EQUAL', 'DOB_EQUAL', 'UNIT_EQUAL'], 0.99)] : [],
        prior: { status: 'approved', expiresAt: isoDay(245) },
        exportDecision: 'exclude',
        exportReason: 'Approved, valid until ' + isoDay(245),
      }),
      mk('R2', 'Moss, Quillan', 'Sample Military Unit B', '1993-08-17', {}),
      mk('R3', 'Cedar, Sol', unitA, '1985-02-10', {
        suggestedPersonId: cedar?.id ?? null,
        linkState: 'pending-review',
        candidates: cedar ? [cand(cedar.id, 'T2', ['NAME_SUBSET_1', 'DOB_SWAPPED'], 0.8)] : [],
        issues: [
          {
            code: 'PERSON_KNOWN_DOB_MISMATCH',
            severity: 'warning',
            rowRef: 'R3',
            field: 'dob',
            message: 'Date of birth equals a known person with day and month swapped.',
          },
        ],
        prior: { status: 'expired', expiresAt: isoDay(-35) },
        exportReason: 'Expired',
      }),
      mk('R4', 'Dune, Rae', 'Sample Other Agency C', '1987-04-09', {
        issues: [
          {
            code: 'DOB_AMBIGUOUS_DM',
            severity: 'warning',
            rowRef: 'R4',
            field: 'dob',
            message: 'Day and month are both 12 or less; the order cannot be confirmed.',
          },
        ],
      }),
    ];
    const issues = items.flatMap((i) => i.issues);
    issues.push({
      code: 'UNIT_UNUSED',
      severity: 'info',
      rowRef: null,
      field: null,
      message: 'A declared unit has no individuals.',
    });
    const dup = db.requests.find((r) => r.sourceFile?.sha256 === 'b'.repeat(64));
    return {
      previewId: newId(),
      fileName: path.split('/').pop() ?? 'request.xlsx',
      sha256: 'b'.repeat(64),
      bytes: 22016,
      templateVersion: 'INVESTc-2024',
      units: db.units.slice(0, 3).map((u, k) => observedUnit(u, `U${k + 1}`)),
      items,
      issues,
      errorCount: issues.filter((i) => i.severity === 'error').length,
      warningCount: issues.filter((i) => i.severity === 'warning').length,
      duplicateOfRequestId: dup?.id ?? null,
      canCommit: true,
    };
  }

  function swapDm(iso: string | null): string {
    const m = iso ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
    return m ? `${m[1]}-${m[3]}-${m[2]}` : (iso ?? '');
  }
  function buildResponsePreview(path: string, requestId: string | undefined): ResponsePreview {
    const req =
      db.requests.find((r) => r.id === requestId) ??
      [...db.requests].reverse().find((r) => r.sentToDcAt && !r.respondedAt) ??
      null;
    const items = req?.items ?? [];
    const rows: ResponsePreview['rows'] = [];
    const unanswered: string[] = [];
    items.forEach((item, idx) => {
      const o = item.observed;
      const nameRaw = `${o.surname.toUpperCase()}, ${[o.name1, o.name2].filter(Boolean).join(' ')}`;
      const base = {
        rowId: newId(),
        rowRef: `S${idx + 1}`,
        section: 'approved-individual' as const,
        disp: 'APPROVED',
        nameRaw,
        certDate: isoDay(-1),
        expires: isoDay(364),
        unitName: o.unitName,
        chosenPersonId: null,
      };
      const evidence = (e: MatchCandidate['evidence']): MatchCandidate => ({
        targetKind: 'request-item',
        targetId: item.id,
        tier: 'T1',
        evidence: e,
        score: 0.9,
      });
      if (idx === 0 || idx === 3) {
        rows.push({
          ...base,
          dobRaw: o.dob.parsed ?? '',
          candidates: [{ ...evidence(['NAME_CORE_EQUAL', 'DOB_EQUAL', 'UNIT_EQUAL']), tier: 'T1', score: 0.99 }],
          decision: 'auto',
          chosenRequestItemId: item.id,
        });
      } else if (idx === 1) {
        rows.push({
          ...base,
          dobRaw: swapDm(o.dob.parsed),
          candidates: [{ ...evidence(['NAME_CORE_EQUAL', 'DOB_SWAPPED']), tier: 'T2', score: 0.8 }],
          decision: 'pending',
          chosenRequestItemId: null,
        });
      } else if (idx === 2) {
        rows.push({
          ...base,
          section: 'nonapproved-individual',
          disp: 'NOT APPROVED',
          dobRaw: o.dob.parsed ?? '',
          candidates: [{ ...evidence(['NAME_SURNAME_EQUAL', 'DOB_EQUAL']), tier: 'T3', score: 0.6 }],
          decision: 'pending',
          chosenRequestItemId: null,
        });
      } else {
        unanswered.push(item.id);
      }
    });
    rows.push({
      rowId: newId(),
      rowRef: `S${rows.length + 1}`,
      section: 'approved-individual',
      disp: 'APPROVED',
      nameRaw: 'UNLISTED, PERSON',
      dobRaw: '1975-01-01',
      certDate: isoDay(-1),
      expires: isoDay(364),
      unitName: 'Sample Other Agency C',
      candidates: [],
      decision: 'none',
      chosenRequestItemId: null,
      chosenPersonId: null,
    });
    const pending = rows.filter((r) => r.decision === 'pending').length;
    return {
      previewId: newId(),
      fileName: path.split('/').pop() ?? 'response.xlsx',
      sha256: 'c'.repeat(64),
      batchId: req?.batchId ?? 'BATCH-NEW',
      post: 'Example Post',
      resultsAsOf: today(),
      assistanceLine: 'Synthetic assistance line for demonstration only.',
      suggestedRequestId: req?.id ?? null,
      rows,
      issues: [],
      errorCount: 0,
      warningCount: 0,
      autoMatchedCount: rows.filter((r) => r.decision === 'auto').length,
      needsReviewCount: pending,
      unmatchedCount: rows.filter((r) => r.decision === 'none').length,
      unansweredItemIds: unanswered,
      duplicateOfResponseId: null,
      canCommit: true,
      requestCandidates: req ? [{ requestId: req.id, eventName: req.eventName, score: 0.9 }] : [],
      matchedRequestId: requestId ?? null,
    };
  }

  function respSummary(r: DcResponse): ResponseSummary {
    return {
      id: r.id,
      batchId: r.batchId,
      post: r.post,
      resultsAsOf: r.resultsAsOf,
      importedAt: r.importedAt,
      requestId: r.requestId,
      rowCount: r.rows.length,
      approvedCount: r.rows.filter((x) => x.section.startsWith('approved')).length,
      nonApprovedCount: r.rows.filter((x) => x.section.startsWith('nonapproved')).length,
      unresolvedCount: r.rows.filter((x) => x.match.decision === 'pending' || x.match.decision === 'none').length,
    };
  }

  function applyRowDecision(resp: DcResponse, row: ResponseRow, chosen: string | null): void {
    const req = resp.requestId ? db.requests.find((r) => r.id === resp.requestId) : undefined;
    const item = req?.items.find((i) => i.id === chosen);
    if (!item) return;
    answered.add(item.id);
    const personId = item.personId ?? createPersonFrom(item).id;
    item.personId = personId;
    item.linkState = 'confirmed';
    const approved = row.section.startsWith('approved');
    recordFor(
      personId,
      approved ? 'approved' : 'non-approved',
      row.certDate.parsed ?? today(),
      row.expires.parsed,
      'dc-file',
      req?.id ?? null,
      item.unitId,
      '',
    );
    refreshPrior(req!);
  }

  function emailDraft(template: string, req: VettingRequest): EmailDraft {
    const to = req.requestor.email ? [req.requestor.email] : [];
    const subjects: Record<string, string> = {
      'request-to-dc': `Vetting request: ${req.eventName}`,
      'request-acknowledgement': `Received: vetting request for ${req.eventName}`,
      'clearance-notice': `Vetting outcome: ${req.eventName}`,
      'reminder-outstanding': `Reminder: outstanding vetting request, ${req.eventName}`,
    };
    const bodies: Record<string, string> = {
      'request-to-dc': `Please find attached the vetting request for ${req.eventName} (${req.items.length} individuals).`,
      'request-acknowledgement': `Dear ${req.requestor.name},\n\nWe confirm receipt of your vetting request for ${req.eventName} (${req.items.length} individuals). We will revert once the outcome is available.`,
      'clearance-notice': `Dear ${req.requestor.name},\n\nThe vetting process for ${req.eventName} is complete. Please see the attached outcome.`,
      'reminder-outstanding': `Dear ${req.requestor.name},\n\nThis is a reminder that the vetting request for ${req.eventName} is still outstanding.`,
    };
    return {
      to,
      cc: [],
      subject: subjects[template] ?? req.eventName,
      bodyText: bodies[template] ?? '',
      attachmentName: template === 'request-to-dc' ? 'vetting-request.xlsx' : null,
      containsPersonalData: false,
    };
  }

  function subjectFor(id: string): ReviewSubject | null {
    const p = db.persons.find((x) => x.id === id);
    if (p) {
      const s = snapshotFor(p.id);
      return {
        id: p.id,
        kind: 'person',
        displayName: personName(p),
        dob: p.dob,
        dobRaw: p.dob ?? '',
        sex: p.sex,
        pobCountry: p.pob.country,
        unitName: db.units.find((u) => u.id === s.unitId)?.name ?? null,
        identifiers: p.identifiers.map((i) => i.value),
        source: 'Known person',
      };
    }
    const f = findItem(id);
    if (f) {
      const o = f.item.observed;
      return {
        id,
        kind: 'request-item',
        displayName: itemName(f.item),
        dob: o.dob.parsed,
        dobRaw: o.dob.value,
        sex: o.sex === 'M' || o.sex === 'F' ? o.sex : null,
        pobCountry: o.pobCountry || null,
        unitName: o.unitName,
        identifiers: [o.passport, o.nationalId].filter(Boolean),
        source: `Request ${f.req.eventName}, row ${o.rowRef}`,
      };
    }
    return null;
  }

  function unitDetail(id: string): Result<UnitDetail> {
    const u = db.units.find((x) => x.id === id);
    if (!u) return fail('NOT_FOUND', 'Unit not found.');
    return ok({
      unit: structuredClone(u),
      vettingRecords: db.unitRecords.filter((x) => x.unitId === u.id),
      personIds: [...new Set(db.records.filter((r) => r.unitId === u.id).map((r) => r.personId))],
    });
  }
  function mergePersons(survivorId: string, mergedId: string, reason: string): Result<PersonDetail> {
    const s = db.persons.find((p) => p.id === survivorId);
    const m = db.persons.find((p) => p.id === mergedId);
    if (!s || !m) return fail('NOT_FOUND', 'Person not found.');
    m.state = 'merged';
    m.mergedInto = s.id;
    s.aliases.push(m.canonical);
    for (const r of db.records) if (r.personId === m.id) r.personId = s.id;
    for (const rq of db.requests) for (const i of rq.items) if (i.personId === m.id) i.personId = s.id;
    db.merges.push({ id: newId(), at: new Date().toISOString(), actor: 'mock-user', survivorId, mergedId, reason });
    appendAudit(db, 'person.merged', 'person', s.id);
    return ok(personDetail(s.id)!);
  }
  function personDetail(id: string): PersonDetail | null {
    const person = db.persons.find((p) => p.id === id);
    if (!person) return null;
    const snap = snapshotFor(id);
    const records = db.records
      .filter((r) => r.personId === id)
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
    const unitIds = new Set(records.map((r) => r.unitId).filter(Boolean));
    return {
      person: structuredClone(person),
      status: snap.status,
      statusAsOf: snap.asOf,
      records: structuredClone(records),
      units: structuredClone(db.units.filter((u) => unitIds.has(u.id))),
      requests: db.requests.filter((r) => r.items.some((i) => i.personId === id)).map(summary),
      mergeHistory: structuredClone(db.merges.filter((m) => m.survivorId === id || m.mergedId === id)),
      openReviewItemIds: db.reviews.filter((r) => r.state === 'open' && r.subjectIds.includes(id)).map((r) => r.id),
    };
  }

  // ---- backup + dashboard extras ------------------------------------------------------------------------
  let backupCfg: BackupConfigPublic | null = null;
  /** Last backup = newest 'vault.backup' audit event (the seed has one 9 days ago). */
  const lastBackup = (): string | null =>
    db.audit
      .filter((e) => e.type === 'vault.backup')
      .map((e) => e.at)
      .sort()
      .at(-1) ?? null;
  const backupFiles: BackupFileInfo[] = [];
  const backupList = (): BackupListResult => ({
    config: backupCfg ? { ...backupCfg } : null,
    backups: backupCfg ? backupFiles.slice(0, backupCfg.keep) : [],
    lastBackupAt: lastBackup(),
  });
  /** Synthetic, not secret: the mock never protects anything. Same shape as the real generator. */
  const mockPassphrase = (): string => {
    const abc = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let out = '';
    for (let i = 0; i < 32; i++) out += abc[Math.floor(Math.random() * 32)];
    return out.match(/.{4}/g)!.join('-');
  };
  function expiryRows(within: number): ExpiryWatchRow[] {
    const asOf = today();
    return db.persons
      .filter((p) => p.state === 'active')
      .flatMap((p) => {
        const s = snapshotFor(p.id);
        if (!s.expiresAt || s.status === 'non-approved') return [];
        const left = daysBetween(asOf, s.expiresAt);
        if (left < 0 || left > within) return [];
        return [
          {
            personId: p.id,
            displayName: personName(p),
            status: s.status,
            expiresAt: s.expiresAt,
            daysLeft: left,
            expiryAssumed: false,
            unitName: null,
          },
        ];
      })
      .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
  }
  function mockDashboardExtras(
    outstanding: { agingDays: number }[],
    exp: Dashboard['expiringSoon'],
  ): Pick<
    Dashboard,
    | 'agingBuckets'
    | 'turnaroundByKind'
    | 'perMonth'
    | 'expiringWithin'
    | 'lastBackupAt'
    | 'lastBackupAgeDays'
    | 'inactivePersons'
  > {
    const agingBuckets = { '0-7': 0, '8-14': 0, '15-30': 0, '>30': 0 };
    for (const o of outstanding) {
      if (o.agingDays <= 7) agingBuckets['0-7']++;
      else if (o.agingDays <= 14) agingBuckets['8-14']++;
      else if (o.agingDays <= 30) agingBuckets['15-30']++;
      else agingBuckets['>30']++;
    }
    const stats = (kind: 'dc-file' | 'email-clearance') => {
      const xs = db.requests
        .filter((r) => r.responseKind === kind && r.sentToDcAt && r.respondedAt)
        .map((r) => daysBetween(r.sentToDcAt!.slice(0, 10), r.respondedAt!.slice(0, 10)))
        .sort((a, b) => a - b);
      const mid = Math.floor(xs.length / 2);
      return {
        count: xs.length,
        meanDays: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null,
        medianDays: xs.length ? (xs.length % 2 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2) : null,
        maxDays: xs.length ? xs[xs.length - 1]! : null,
      };
    };
    const now = new Date();
    const perMonth: Dashboard['perMonth'] = [];
    for (let k = 11; k >= 0; k--) {
      const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1)).toISOString().slice(0, 7);
      const n = (f: (r: VettingRequest) => string | null) =>
        db.requests.filter((r) => f(r)?.slice(0, 7) === month).length;
      perMonth.push({
        month,
        received: n((r) => r.receivedAt),
        sent: n((r) => r.sentToDcAt),
        responded: n((r) => r.respondedAt),
      });
    }
    const asOf = today();
    const within = (d: number) => exp.filter((e) => e.expiresAt >= asOf && e.expiresAt <= addDays(asOf, d)).length;
    const cutoff = addDays(asOf, -3 * 365);
    const inactive = db.persons.filter((p) => p.state === 'active' && p.updatedAt.slice(0, 10) < cutoff);
    return {
      agingBuckets,
      turnaroundByKind: { file: stats('dc-file'), email: stats('email-clearance') },
      perMonth,
      expiringWithin: { d30: within(30), d60: within(60), d90: within(90) },
      lastBackupAt: lastBackup(),
      lastBackupAgeDays: lastBackup() ? Math.max(0, daysBetween(lastBackup()!.slice(0, 10), asOf)) : null,
      inactivePersons: {
        count: inactive.length,
        sample: inactive
          .slice(0, 20)
          .map((p) => ({ personId: p.id, displayName: personName(p), lastActivityAt: p.updatedAt.slice(0, 10) })),
      },
    };
  }

  function templateList(): TemplateList {
    const all = structuredClone(db.templates).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { active: all.find((t) => t.active) ?? null, history: all.filter((t) => !t.active) };
  }

  // ---- the API --------------------------------------------------------------------------------------------
  const api: VssApi = {
    vault: {
      status: () => Promise.resolve(ok(status())),
      create: (req) => {
        if (db.vault.exists) return Promise.resolve(fail('VAULT_EXISTS', 'A vault already exists.'));
        if (req.password.length < 12) return Promise.resolve(fail('BAD_REQUEST', 'Password is too short.'));
        db.vault.exists = true;
        db.vault.password = req.password;
        db.vault.path = 'mock://data/vault.json';
        db.vault.slots = [{ id: 'slot-pw', kind: 'password', label: 'Password', createdAt: new Date().toISOString() }];
        if (opts.seed !== false) seed(db);
        appendAudit(db, 'vault.created', 'vault', null);
        return Promise.resolve(ok(unlockedStatus()));
      },
      open: (req) => {
        db.vault.exists = true;
        db.vault.password = db.vault.password || password;
        db.vault.path = req.path;
        db.vault.locked = true;
        if (db.persons.length === 0 && opts.seed !== false) seed(db);
        return Promise.resolve(ok(status()));
      },
      unlock: (req) => {
        if (!db.vault.exists) return Promise.resolve(fail('VAULT_NOT_FOUND', 'No vault found.'));
        if (db.vault.lockedOutUntil && db.vault.lockedOutUntil > new Date().toISOString())
          return Promise.resolve(fail('RATE_LIMITED', 'Too many attempts. Try again later.'));
        if (req.password !== db.vault.password) {
          db.vault.failed += 1;
          if (db.vault.failed >= 5) db.vault.lockedOutUntil = new Date(Date.now() + 30_000).toISOString();
          return Promise.resolve(fail('BAD_CREDENTIALS', 'Wrong password.'));
        }
        return Promise.resolve(ok(unlockedStatus()));
      },
      lock: () => {
        lockNow('manual');
        return Promise.resolve(ok(status()));
      },
      changePassword: (req) =>
        gate(() => {
          if (req.currentPassword !== db.vault.password) return fail('BAD_CREDENTIALS', 'Wrong password.');
          if (req.newPassword.length < 12) return fail('BAD_REQUEST', 'Password is too short.');
          db.vault.password = req.newPassword;
          appendAudit(db, 'vault.password-changed', 'vault', null);
          return ok(ACK);
        }),
      enrollFido2: () => Promise.resolve(fail('NOT_SUPPORTED', 'Security keys are not supported in this version.')),
      removeSlot: () => Promise.resolve(fail('NOT_SUPPORTED', 'Key slots are not supported in this version.')),
      backup: (req) =>
        gate(() => {
          if (req.passphrase.length < 8) return fail('BAD_REQUEST', 'Backup passphrase is too short.');
          appendAudit(db, 'vault.backup', 'vault', null);
          return ok({ path: req.destPath, bytes: 1_048_576, sha256: 'd'.repeat(64) });
        }),
      restore: (req) => {
        if (req.passphrase.length < 8)
          return Promise.resolve(fail('BACKUP_INVALID', 'Backup passphrase is wrong or the file is damaged.'));
        db.vault.exists = true;
        db.vault.password = db.vault.password || password;
        db.vault.path = `${req.destDirectory}/vault.json`;
        db.vault.locked = true;
        if (db.persons.length === 0 && opts.seed !== false) seed(db);
        return Promise.resolve(ok(status()));
      },
      wipe: (req) => {
        if (req.password !== db.vault.password) return Promise.resolve(fail('BAD_CREDENTIALS', 'Wrong password.'));
        stopTimer();
        Object.assign(db, emptyDb());
        emit('vault:locked', { reason: 'manual' });
        return Promise.resolve(ok(status()));
      },
      touch: () => {
        idleSeconds = 0;
        return Promise.resolve(ok(ACK));
      },
    },
    settings: {
      get: () => gate(() => ok(structuredClone(db.settings))),
      update: (req) =>
        gate(() => {
          if (req.reauth.password !== db.vault.password) return fail('BAD_CREDENTIALS', 'Wrong password.');
          db.settings = structuredClone(req.settings);
          appendAudit(db, 'settings.updated', 'settings', null);
          return ok(structuredClone(db.settings));
        }),
    },
    requests: {
      list: (q) =>
        gate(() => {
          let rows = db.requests.map(summary);
          rows = rows.filter(
            (r) =>
              (!q.text ||
                includes(
                  `${r.eventName} ${r.requestor.name} ${r.requestor.organisation ?? ''} ${r.batchId ?? ''}`,
                  q.text,
                )) &&
              (!q.statuses?.length || q.statuses.includes(r.status)) &&
              (!q.from || r.receivedAt.slice(0, 10) >= q.from) &&
              (!q.to || r.receivedAt.slice(0, 10) <= q.to) &&
              (!q.outstandingOnly || (r.sentToDcAt && !r.respondedAt)),
          );
          const key = q.sort ?? 'receivedAt';
          const dir = q.direction === 'asc' ? 1 : -1;
          rows.sort((a, b) => {
            const av = String((a as unknown as Record<string, unknown>)[key] ?? '');
            const bv = String((b as unknown as Record<string, unknown>)[key] ?? '');
            return key === 'agingDays' ? dir * ((a.agingDays ?? -1) - (b.agingDays ?? -1)) : dir * av.localeCompare(bv);
          });
          return ok(page(rows, q.offset, q.limit));
        }),
      get: (req) =>
        gate(() => {
          const r = db.requests.find((x) => x.id === req.id);
          return r ? ok(structuredClone(r)) : fail('NOT_FOUND', 'Request not found.');
        }),
      importPreview: (req) =>
        gate(() => {
          if (!/\/request[^/]*$/.test(req.path)) return fail('FILE_INVALID', 'This is not a request workbook.');
          const p = buildRequestPreview(req.path);
          previews.set(p.previewId, p);
          return ok(structuredClone(p));
        }),
      importCommit: (req) =>
        gate(() => {
          const p = previews.get(req.previewId);
          if (!p) return fail('PREVIEW_EXPIRED', 'The preview has expired. Pick the file again.');
          if (!p.canCommit) return fail('FILE_INVALID', 'The file has errors and cannot be imported.');
          previews.delete(req.previewId);
          const id = newId();
          const items: RequestItem[] = p.items.map((pi) => {
            const person = db.persons.find((x) => x.id === pi.suggestedPersonId);
            const [sn = '', given = ''] = pi.displayName.split(', ');
            const gn = given.split(' ').filter(Boolean);
            const proto = person ?? makePerson(sn, gn, pi.dob);
            const unit = db.units.find((u) => u.name === pi.unitName);
            const obs = observedFor(
              { ...proto, canonical: { ...proto.canonical, surname: sn, given: gn }, dob: pi.dob, id: proto.id },
              pi.unitName,
              pi.rowRef,
            );
            obs.dob = { ...rawDate(pi.dob), value: pi.dobRaw };
            const item: RequestItem = {
              id: newId(),
              requestId: id,
              observed: obs,
              nameKey: nameKey(sn, gn),
              personId: pi.linkState === 'auto' ? pi.suggestedPersonId : null,
              linkState: pi.linkState,
              unitId: unit?.id ?? null,
              issues: structuredClone(pi.issues),
              prior: person && pi.prior ? { ...snapshotFor(person.id) } : null,
              exportDecision: pi.exportDecision,
              exportReason: pi.exportReason,
            };
            const chosen = req.exportDecisions?.find((d) => d.rowRef === pi.rowRef);
            if (chosen) {
              item.exportDecision = chosen.decision;
              item.exportReason = chosen.reason;
            }
            return item;
          });
          const r: VettingRequest = {
            id,
            kind: 'file',
            receivedAt: new Date().toISOString(),
            requestor: req.requestor,
            eventName: req.eventName,
            eventStart: req.eventStart,
            eventEnd: req.eventEnd,
            eventLocation: req.eventLocation,
            sourceFile: {
              id: newId(),
              originalName: p.fileName,
              sha256: p.sha256,
              bytes: p.bytes,
              storedAt: new Date().toISOString(),
            },
            templateVersion: p.templateVersion,
            units: p.units,
            items,
            status: 'validated',
            sentToDcAt: null,
            respondedAt: null,
            responseKind: null,
            batchId: null,
            notes: req.notes,
          };
          db.requests.push(r);
          for (const it of items) {
            if (it.linkState === 'pending-review') {
              const pi = p.items.find((x) => x.rowRef === it.observed.rowRef)!;
              db.reviews.push({
                id: newId(),
                kind: 'request-item-link',
                createdAt: new Date().toISOString(),
                subjectIds: [it.id, ...pi.candidates.map((c) => c.targetId)],
                candidates: structuredClone(pi.candidates),
                state: 'open',
                resolution: null,
              });
            }
          }
          appendAudit(db, 'request.imported', 'request', id);
          pushCounts();
          let captured: TemplateInfo | null = null;
          if (!db.templates.some((t) => t.active)) {
            captured = mockTemplate('auto-capture', p.fileName, new Date().toISOString());
            db.templates.push(captured);
            appendAudit(db, 'template.capture', 'template', captured.id);
          }
          return ok(captured ? { ...summary(r), templateCaptured: structuredClone(captured) } : summary(r));
        }),
      createManual: (req) =>
        gate(() => {
          const id = newId();
          const items: RequestItem[] = req.items.map((mi, k) => {
            const p = makePerson(mi.surname, mi.givenNames, mi.dob, { sex: mi.sex, nationality: mi.nationality });
            const known = db.persons.find((x) => x.canonical.surname === mi.surname && x.dob === mi.dob && mi.dob);
            const unit = db.units.find((u) => u.name === mi.unitName);
            const obs = observedFor(p, mi.unitName, `M${k + 1}`);
            obs.isHeadOfUnit = mi.isHeadOfUnit;
            obs.pobCountry = mi.pobCountry ?? '';
            return {
              id: newId(),
              requestId: id,
              observed: obs,
              nameKey: nameKey(mi.surname, mi.givenNames),
              personId: known?.id ?? null,
              linkState: known ? 'auto' : 'unlinked',
              unitId: unit?.id ?? null,
              issues: [],
              prior: null,
              exportDecision: 'include',
              exportReason: '',
            };
          });
          const r: VettingRequest = {
            id,
            kind: 'manual',
            receivedAt: new Date().toISOString(),
            requestor: req.requestor,
            eventName: req.eventName,
            eventStart: req.eventStart,
            eventEnd: req.eventEnd,
            eventLocation: req.eventLocation,
            sourceFile: null,
            templateVersion: null,
            units: [],
            items,
            status: req.sentToDcAt ? 'sent-to-dc' : 'received',
            sentToDcAt: req.sentToDcAt,
            respondedAt: null,
            responseKind: null,
            batchId: null,
            notes: req.notes,
          };
          db.requests.push(r);
          appendAudit(db, 'request.created', 'request', id);
          return ok(summary(r));
        }),
      update: (req) =>
        gate(() => {
          const r = db.requests.find((x) => x.id === req.id);
          if (!r) return fail('NOT_FOUND', 'Request not found.');
          Object.assign(r, req.patch);
          appendAudit(db, 'request.updated', 'request', r.id);
          return ok(summary(r));
        }),
      setStatus: (req) =>
        gate(() => {
          const r = db.requests.find((x) => x.id === req.id);
          if (!r) return fail('NOT_FOUND', 'Request not found.');
          r.status = req.status;
          if (req.status === 'sent-to-dc') r.sentToDcAt = req.at ?? new Date().toISOString();
          if (req.status === 'responded') r.respondedAt = req.at ?? new Date().toISOString();
          appendAudit(db, 'request.status', 'request', r.id, 0, { status: req.status });
          return ok(summary(r));
        }),
      setItemDecision: (req) =>
        gate(() => {
          const f = findItem(req.itemId);
          if (!f) return fail('NOT_FOUND', 'Item not found.');
          f.item.exportDecision = req.decision as ExportDecision;
          f.item.exportReason = req.reason;
          return ok(structuredClone(f.item));
        }),
      linkItem: (req) =>
        gate(() => {
          const f = findItem(req.itemId);
          if (!f) return fail('NOT_FOUND', 'Item not found.');
          if (req.personId === null) {
            f.item.personId = createPersonFrom(f.item).id;
            f.item.linkState = 'new-person';
          } else {
            if (!db.persons.some((p) => p.id === req.personId)) return fail('NOT_FOUND', 'Person not found.');
            f.item.personId = req.personId;
            f.item.linkState = 'confirmed';
          }
          f.item.issues = f.item.issues.filter((i) => !i.code.startsWith('PERSON_KNOWN'));
          for (const rv of db.reviews)
            if (rv.state === 'open' && rv.kind === 'request-item-link' && rv.subjectIds[0] === f.item.id) {
              rv.state = 'resolved';
              rv.resolution = 'link';
            }
          refreshPrior(f.req);
          appendAudit(db, 'request.item-linked', 'request', f.req.id);
          pushCounts();
          return ok(structuredClone(f.item));
        }),
      exportPreview: (req) =>
        gate(() => {
          const r = db.requests.find((x) => x.id === req.requestId);
          if (!r) return fail('NOT_FOUND', 'Request not found.');
          const forced = req.includeItemIds ? new Set(req.includeItemIds) : null;
          const items = r.items.map((i) => {
            const included = forced
              ? forced.has(i.id)
              : i.exportDecision === 'include' || i.exportDecision === 'manual-include';
            return {
              itemId: i.id,
              displayName: itemName(i),
              unitName: i.observed.unitName,
              included,
              reason: i.exportReason,
              status: (i.prior?.status ?? 'unknown') as VettingStatus,
            };
          });
          const blocking =
            db.settings.exportPolicy.includeFlaggedUnresolved === 'block'
              ? r.items
                  .filter((i) => i.linkState === 'pending-review' && i.exportDecision !== 'manual-include')
                  .map((i) => i.id)
              : [];
          return ok({
            requestId: r.id,
            mode: req.mode,
            items,
            includedCount: items.filter((i) => i.included).length,
            excludedCount: items.filter((i) => !i.included).length,
            blockingItemIds: blocking,
            unitsWritten: r.units.length,
            filterOriginalAvailable: r.sourceFile !== null,
            templateAvailable: db.templates.some((t) => t.active),
          });
        }),
      export: (req) =>
        gate(() => {
          const r = db.requests.find((x) => x.id === req.requestId);
          if (!r) return fail('NOT_FOUND', 'Request not found.');
          if (
            db.settings.exportPolicy.includeFlaggedUnresolved === 'block' &&
            !req.overrideReason?.trim() &&
            r.items.some((i) => i.linkState === 'pending-review' && i.exportDecision !== 'manual-include')
          )
            return fail('EXPORT_BLOCKED', 'Some items still need an identity decision before export.');
          const inc = r.items.filter((i) =>
            req.includeItemIds
              ? req.includeItemIds.includes(i.id)
              : i.exportDecision === 'include' || i.exportDecision === 'manual-include',
          );
          if (inc.length === 0) return fail('EXPORT_BLOCKED', 'Nothing to export: every item is excluded.');
          const regenerate = req.mode === 'regenerate' || r.sourceFile === null;
          if (regenerate && !db.templates.some((t) => t.active))
            return fail(
              'TEMPLATE_MISSING',
              'No export template is stored in this vault. Import a blank INVESTc workbook (or any INVESTc request) in Settings > Templates, then export again.',
            );
          if (r.status === 'received' || r.status === 'validated') r.status = 'exported';
          const exportId = newId();
          db.exports.push({ id: exportId, requestId: r.id });
          appendAudit(db, 'request.exported', 'request', r.id, 0, { included: inc.length });
          return ok({
            exportId,
            path: req.destPath,
            sha256: 'e'.repeat(64),
            bytes: 18432,
            includedCount: inc.length,
            excludedCount: r.items.length - inc.length,
            mode: regenerate ? 'regenerate' : req.mode,
          });
        }),
      remove: (req) =>
        gate(() => {
          const n = db.requests.findIndex((x) => x.id === req.id);
          if (n < 0) return fail('NOT_FOUND', 'Request not found.');
          db.requests.splice(n, 1);
          appendAudit(db, 'request.removed', 'request', req.id);
          return ok(ACK);
        }),
    },
    responses: {
      list: (q) =>
        gate(() => {
          const rows = db.responses
            .filter((r) => (!q.requestId || r.requestId === q.requestId) && includes(`${r.batchId} ${r.post}`, q.text))
            .map(respSummary)
            .sort((a, b) => b.importedAt.localeCompare(a.importedAt));
          return ok(page(rows, q.offset, q.limit));
        }),
      get: (req) =>
        gate(() => {
          const r = db.responses.find((x) => x.id === req.id);
          return r ? ok(structuredClone(r)) : fail('NOT_FOUND', 'Response not found.');
        }),
      importPreview: (req) =>
        gate(() => {
          if (!/\/response[^/]*$/.test(req.path)) return fail('FILE_INVALID', 'This is not a response workbook.');
          const p = buildResponsePreview(req.path, req.requestId);
          respPreviews.set(p.previewId, { preview: p, requestId: p.suggestedRequestId });
          return ok(structuredClone(p));
        }),
      importCommit: (req) =>
        gate(() => {
          const e = respPreviews.get(req.previewId);
          if (!e) return fail('PREVIEW_EXPIRED', 'The preview has expired. Pick the file again.');
          respPreviews.delete(req.previewId);
          const p = e.preview;
          const resp: DcResponse = {
            id: newId(),
            batchId: p.batchId,
            post: p.post,
            resultsAsOf: p.resultsAsOf ?? today(),
            assistanceLine: p.assistanceLine,
            sourceFile: {
              id: newId(),
              originalName: p.fileName,
              sha256: p.sha256,
              bytes: 15360,
              storedAt: new Date().toISOString(),
            },
            importedAt: new Date().toISOString(),
            requestId: req.requestId,
            rows: [],
          };
          let records = 0;
          let reviews = 0;
          const decisions = req.decisions ?? {};
          resp.rows = p.rows.map((pre) => {
            const d = decisions[pre.rowId];
            const pr =
              d === undefined
                ? pre
                : d === 'skip'
                  ? { ...pre, decision: 'rejected' as const, chosenRequestItemId: null }
                  : d === 'new'
                    ? { ...pre, decision: 'confirmed' as const, chosenRequestItemId: null }
                    : { ...pre, decision: 'confirmed' as const, chosenRequestItemId: d };
            const [surname = '', given = ''] = pr.nameRaw.split(', ');
            const row: ResponseRow = {
              id: pr.rowId,
              responseId: resp.id,
              rowRef: pr.rowRef,
              section: pr.section,
              disp: pr.disp,
              nameRaw: pr.nameRaw,
              name: { surname, given: given.split(' ').filter(Boolean), raw: pr.nameRaw, script: 'Latn' },
              nameKey: nameKey(surname, given.split(' ')),
              dob: { ...rawDate(pr.dobRaw), value: pr.dobRaw },
              pob: { city: null, state: null, country: null },
              unitType: '',
              unitName: pr.unitName,
              certDate: rawDate(pr.certDate),
              expires: rawDate(pr.expires),
              match: {
                candidates: pr.candidates,
                decision: pr.decision,
                chosen: pr.chosenRequestItemId,
                decidedBy: pr.decision === 'auto' ? 'auto' : null,
                decidedAt: pr.decision === 'auto' ? new Date().toISOString() : null,
              },
            };
            if (pr.decision === 'auto' || (pr.decision === 'confirmed' && pr.chosenRequestItemId)) {
              applyRowDecision(resp, row, pr.chosenRequestItemId);
              records += 1;
            } else if (pr.decision === 'pending') {
              reviews += 1;
              db.reviews.push({
                id: newId(),
                kind: 'response-row-match',
                createdAt: new Date().toISOString(),
                subjectIds: [row.id],
                candidates: structuredClone(pr.candidates),
                state: 'open',
                resolution: null,
              });
            }
            return row;
          });
          db.responses.push(resp);
          const rq = db.requests.find((x) => x.id === req.requestId);
          if (rq) {
            rq.status = 'responded';
            rq.respondedAt = new Date().toISOString();
            rq.responseKind = 'dc-file';
            if (!rq.batchId) rq.batchId = p.batchId;
          }
          appendAudit(db, 'response.imported', 'response', resp.id);
          pushCounts();
          const responseDays =
            rq?.sentToDcAt && rq.respondedAt
              ? daysBetween(rq.sentToDcAt.slice(0, 10), rq.respondedAt.slice(0, 10))
              : null;
          return ok({
            response: respSummary(resp),
            recordsCreated: records,
            reviewItemsCreated: reviews,
            responseDays,
          });
        }),
      setRowMatch: (req) =>
        gate(() => {
          for (const resp of db.responses) {
            const row = resp.rows.find((x) => x.id === req.rowId);
            if (!row) continue;
            row.match.decision = req.decision;
            row.match.chosen = req.chosen;
            row.match.decidedBy = 'mock-user';
            row.match.decidedAt = new Date().toISOString();
            if (req.decision === 'confirmed') applyRowDecision(resp, row, req.chosen);
            for (const rv of db.reviews)
              if (rv.state === 'open' && rv.kind === 'response-row-match' && rv.subjectIds[0] === row.id) {
                rv.state = 'resolved';
                rv.resolution = req.decision;
              }
            pushCounts();
            return ok(structuredClone(row));
          }
          return fail('NOT_FOUND', 'Response row not found.');
        }),
      recordEmailClearance: (req) =>
        gate(() => {
          const r = db.requests.find((x) => x.id === req.requestId);
          if (!r) return fail('NOT_FOUND', 'Request not found.');
          const assumed = req.expiresAt === null;
          const expires = req.expiresAt ?? addDays(req.certDate, db.settings.emailClearanceDefaultDays);
          const ids: string[] = [];
          let anyAssumed = false;
          for (const itemId of req.itemIds) {
            const item = r.items.find((i) => i.id === itemId);
            if (!item) continue;
            const disposition = req.dispositions?.[itemId] ?? req.disposition;
            if (disposition === 'approved' && assumed) anyAssumed = true;
            const personId = item.personId ?? createPersonFrom(item).id;
            item.personId = personId;
            if (item.linkState === 'unlinked') item.linkState = 'new-person';
            answered.add(item.id);
            ids.push(
              recordFor(
                personId,
                disposition === 'approved' ? 'email-cleared' : 'non-approved',
                req.certDate,
                disposition === 'approved' ? expires : null,
                'email',
                r.id,
                item.unitId,
                req.note,
                disposition === 'approved' && assumed,
              ).id,
            );
          }
          r.status = 'responded';
          r.responseKind = 'email-clearance';
          r.respondedAt = r.respondedAt ?? new Date().toISOString();
          refreshPrior(r);
          const responseDays = r.sentToDcAt ? daysBetween(r.sentToDcAt.slice(0, 10), today()) : null;
          return ok({ recordIds: ids, responseDays, expiryAssumed: anyAssumed });
        }),
      recordManual: (req) =>
        gate(() => {
          if (!db.persons.some((p) => p.id === req.personId)) return fail('NOT_FOUND', 'Person not found.');
          const rec = recordFor(
            req.personId,
            req.disposition,
            req.certDate,
            req.expiresAt,
            'manual',
            null,
            req.unitId,
            req.note,
          );
          return ok({ recordIds: [rec.id] });
        }),
    },
    persons: {
      list: (q) =>
        gate(() => {
          let rows = db.persons.filter((p) => p.state === 'active').map((p) => ({ p, s: personSummary(p) }));
          rows = rows.filter(({ p, s }) => {
            const hay = [
              s.displayName,
              p.dob ?? '',
              p.nationality ?? '',
              s.currentUnitName ?? '',
              ...p.identifiers.map((i) => i.value),
              ...p.aliases.map((a) => a.raw),
            ].join(' ');
            return (
              includes(hay, q.text) &&
              (!q.statuses?.length || q.statuses.includes(s.status)) &&
              (!q.expiringBefore || (s.expiresAt !== null && s.expiresAt <= q.expiringBefore)) &&
              (!q.unitId || db.records.some((r) => r.personId === p.id && r.unitId === q.unitId))
            );
          });
          const dir = q.direction === 'desc' ? -1 : 1;
          rows.sort((a, b) => {
            if (q.sort === 'expiresAt') return dir * (a.s.expiresAt ?? '9').localeCompare(b.s.expiresAt ?? '9');
            if (q.sort === 'status') return dir * a.s.status.localeCompare(b.s.status);
            if (q.sort === 'updatedAt') return dir * a.p.updatedAt.localeCompare(b.p.updatedAt);
            return dir * a.s.displayName.localeCompare(b.s.displayName);
          });
          return ok(
            page(
              rows.map((x) => x.s),
              q.offset,
              q.limit,
            ),
          );
        }),
      get: (req) =>
        gate(() => {
          const d = personDetail(req.id);
          return d ? ok(d) : fail('NOT_FOUND', 'Person not found.');
        }),
      update: (req) =>
        gate(() => {
          const p = db.persons.find((x) => x.id === req.id);
          if (!p) return fail('NOT_FOUND', 'Person not found.');
          Object.assign(p, req.patch, { updatedAt: new Date().toISOString() });
          appendAudit(db, 'person.updated', 'person', p.id);
          return ok(personDetail(p.id)!);
        }),
      merge: (req) =>
        gate(() => {
          const r = mergePersons(req.survivorId, req.mergedId, req.reason);
          for (const rv of db.reviews)
            if (rv.state === 'open' && rv.kind === 'duplicate-persons' && rv.subjectIds.includes(req.mergedId))
              rv.state = 'resolved';
          pushCounts();
          return r;
        }),
      unmerge: (req) =>
        gate(() => {
          const m = db.merges.find((x) => x.id === req.mergeLogId);
          if (!m) return fail('NOT_FOUND', 'Merge not found.');
          const p = db.persons.find((x) => x.id === m.mergedId);
          if (p) {
            p.state = 'active';
            p.mergedInto = null;
          }
          db.merges.splice(db.merges.indexOf(m), 1);
          appendAudit(db, 'person.unmerged', 'person', m.survivorId);
          return ok(personDetail(m.survivorId)!);
        }),
      split: (req) =>
        gate(() => {
          const p = db.persons.find((x) => x.id === req.personId);
          if (!p) return fail('NOT_FOUND', 'Person not found.');
          const items = db.requests.flatMap((r) => r.items).filter((i) => req.itemIds.includes(i.id));
          if (items.length === 0) return fail('BAD_REQUEST', 'Pick at least one item.');
          const created = createPersonFrom(items[0]!);
          for (const i of items) i.personId = created.id;
          appendAudit(db, 'person.split', 'person', p.id);
          return ok(personDetail(created.id)!);
        }),
      scanDuplicates: () => gate(() => ok({ pairsFound: 0, reviewItemsCreated: 0 })),
      markNotSame: (req) =>
        gate(() => {
          db.notSame.push([req.a, req.b]);
          for (const rv of db.reviews)
            if (rv.state === 'open' && rv.subjectIds.includes(req.a) && rv.subjectIds.includes(req.b))
              rv.state = 'dismissed';
          pushCounts();
          return ok(ACK);
        }),
      purge: (req) =>
        gate(() => {
          if (req.password !== db.vault.password) return fail('BAD_CREDENTIALS', 'Wrong password.');
          const p = db.persons.find((x) => x.id === req.id);
          if (!p) return fail('NOT_FOUND', 'Person not found.');
          p.state = 'purged';
          return ok(ACK);
        }),
    },
    units: {
      list: (q) =>
        gate(() => {
          const rows: UnitSummary[] = db.units
            .filter(
              (u) =>
                includes(`${u.name} ${u.aliases.join(' ')}`, q.text) &&
                (!q.country || u.country === q.country) &&
                (!q.type || u.type === q.type),
            )
            .map((u) => ({
              id: u.id,
              name: u.name,
              type: u.type,
              country: u.country,
              personCount: new Set(db.records.filter((r) => r.unitId === u.id).map((r) => r.personId)).size,
              lastVetting: db.unitRecords.find((x) => x.unitId === u.id) ?? null,
            }));
          return ok(page(rows, q.offset, q.limit));
        }),
      get: (req) =>
        gate(() => {
          const u = db.units.find((x) => x.id === req.id);
          if (!u) return fail('NOT_FOUND', 'Unit not found.');
          const d: UnitDetail = {
            unit: structuredClone(u),
            vettingRecords: db.unitRecords.filter((x) => x.unitId === u.id),
            personIds: [...new Set(db.records.filter((r) => r.unitId === u.id).map((r) => r.personId))],
          };
          return ok(d);
        }),
      update: (req) =>
        gate(() => {
          const u = db.units.find((x) => x.id === req.id);
          if (!u) return fail('NOT_FOUND', 'Unit not found.');
          Object.assign(u, req.patch);
          return unitDetail(u.id);
        }),
      addAlias: (req) =>
        gate(() => {
          const u = db.units.find((x) => x.id === req.id);
          if (!u) return fail('NOT_FOUND', 'Unit not found.');
          if (!u.aliases.includes(req.alias)) u.aliases.push(req.alias);
          return unitDetail(u.id);
        }),
      merge: (req) =>
        gate(() => {
          const s = db.units.find((x) => x.id === req.survivorId);
          const m = db.units.find((x) => x.id === req.mergedId);
          if (!s || !m) return fail('NOT_FOUND', 'Unit not found.');
          s.aliases.push(m.name);
          for (const r of db.records) if (r.unitId === m.id) r.unitId = s.id;
          db.units.splice(db.units.indexOf(m), 1);
          return unitDetail(s.id);
        }),
    },
    review: {
      list: (q) =>
        gate(() => {
          const rows = db.reviews
            .filter((r) => (!q.state || r.state === q.state) && (!q.kinds?.length || q.kinds.includes(r.kind)))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map((r) => structuredClone(r));
          return ok(page(rows, q.offset, q.limit));
        }),
      get: (req) =>
        gate(() => {
          const item = db.reviews.find((x) => x.id === req.id);
          if (!item) return fail('NOT_FOUND', 'Review item not found.');
          const subjects: ReviewSubject[] = [];
          for (const id of item.subjectIds) {
            const s = subjectFor(id);
            if (s) subjects.push(s);
            else {
              for (const resp of db.responses) {
                const row = resp.rows.find((x) => x.id === id);
                if (row)
                  subjects.push({
                    id,
                    kind: 'response-row',
                    displayName: row.nameRaw,
                    dob: row.dob.parsed,
                    dobRaw: row.dob.value,
                    sex: null,
                    pobCountry: row.pob.country,
                    unitName: row.unitName,
                    identifiers: [],
                    source: `Response ${resp.batchId}, row ${row.rowRef}`,
                  });
              }
              // Candidate request items for a response row
              for (const c of item.candidates)
                if (c.targetKind === 'request-item' && !subjects.some((x) => x.id === c.targetId)) {
                  const cs = subjectFor(c.targetId);
                  if (cs) subjects.push(cs);
                }
            }
          }
          return ok({ item: structuredClone(item), subjects });
        }),
      resolve: (req) =>
        gate(() => {
          const rv = db.reviews.find((x) => x.id === req.id);
          if (!rv) return fail('NOT_FOUND', 'Review item not found.');
          const a = req.resolution;
          const first = rv.subjectIds[0]!;
          if (a.action === 'link') {
            if (rv.kind === 'request-item-link') void api.requests.linkItem({ itemId: first, personId: a.targetId });
            else if (rv.kind === 'response-row-match')
              void api.responses.setRowMatch({ rowId: first, chosen: a.targetId, decision: 'confirmed' });
          } else if (a.action === 'new-person') {
            if (rv.kind === 'request-item-link') void api.requests.linkItem({ itemId: first, personId: null });
            else if (rv.kind === 'response-row-match')
              void api.responses.setRowMatch({ rowId: first, chosen: null, decision: 'none' });
          } else if (a.action === 'not-same') {
            const other = rv.subjectIds[1];
            if (other) db.notSame.push([first, other]);
            if (rv.kind === 'response-row-match')
              void api.responses.setRowMatch({ rowId: first, chosen: null, decision: 'rejected' });
            const f = findItem(first);
            if (f) f.item.linkState = 'unlinked';
          } else if (a.action === 'merge') {
            mergePersons(a.survivorId, a.mergedId, 'Resolved from review queue');
          }
          rv.state = a.action === 'dismiss' || a.action === 'not-same' ? 'dismissed' : 'resolved';
          rv.resolution = a.action;
          appendAudit(db, 'review.resolved', 'review', rv.id, 0, { action: a.action });
          const counts = reviewCounts();
          pushCounts();
          return ok(counts);
        }),
      counts: () => gate(() => ok(reviewCounts())),
    },
    email: {
      draft: (req) =>
        gate(() => {
          const r = db.requests.find((x) => x.id === req.requestId);
          if (!r) return fail('NOT_FOUND', 'Request not found.');
          const d = emailDraft(req.template, r);
          if (req.template === 'clearance-notice' || req.template === 'reminder-outstanding') {
            // Same column rule as main: name, unit, status, valid until; DOB / ID only when opted in per email.
            const head = ['Name', 'Unit', 'Status', 'Valid until'];
            if (req.fields?.dob) head.push('Date of birth');
            if (req.fields?.ids) head.push('ID number');
            const rows = r.items.map((i) => {
              const s = i.personId ? snapshotFor(i.personId) : null;
              const line = [
                `${i.observed.surname}, ${i.observed.name1}`,
                i.observed.unitName,
                s?.status ?? 'pending',
                s?.expiresAt ?? '-',
              ];
              if (req.fields?.dob) line.push(i.observed.dob.parsed ?? '-');
              if (req.fields?.ids) line.push(i.observed.passport || i.observed.nationalId || '-');
              return line.join(' | ');
            });
            d.bodyText += `\n\n${[head.join(' | '), ...rows].join('\n')}`;
            d.containsPersonalData = rows.length > 0;
          }
          if (req.to) d.to = req.to;
          if (req.cc) d.cc = req.cc;
          return ok(d);
        }),
      writeEml: (req) => gate(() => ok({ path: req.destPath })),
      mailto: (d) =>
        gate(() => {
          const url = `mailto:${d.to.join(',')}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.bodyText)}`;
          return ok({ url: url.slice(0, 1800), truncated: url.length > 1800 });
        }),
    },
    stats: {
      dashboard: () =>
        gate(() => {
          const counts: Record<VettingStatus, number> = {
            unknown: 0,
            pending: 0,
            approved: 0,
            expiring: 0,
            expired: 0,
            'non-approved': 0,
          };
          const exp: Dashboard['expiringSoon'] = [];
          const active = db.persons.filter((p) => p.state === 'active');
          for (const p of active) {
            const s = snapshotFor(p.id);
            counts[s.status] += 1;
            if (s.expiresAt && (s.status === 'approved' || s.status === 'expiring') && s.expiresAt <= isoDay(90))
              exp.push({ personId: p.id, displayName: personName(p), expiresAt: s.expiresAt });
          }
          exp.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
          const outstanding = db.requests
            .filter((r) => r.sentToDcAt && !r.respondedAt)
            .map((r) => {
              const s = summary(r);
              return {
                requestId: r.id,
                eventName: r.eventName,
                sentToDcAt: r.sentToDcAt!,
                agingDays: s.agingDays ?? 0,
                itemCount: r.items.length,
                answeredCount: s.answeredCount,
              };
            });
          const times = db.requests
            .filter((r) => r.sentToDcAt && r.respondedAt)
            .map((r) => daysBetween(r.sentToDcAt!.slice(0, 10), r.respondedAt!.slice(0, 10)))
            .sort((a, b) => a - b);
          const mean = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;
          const mid = Math.floor(times.length / 2);
          const median = times.length ? (times.length % 2 ? times[mid]! : (times[mid - 1]! + times[mid]!) / 2) : null;
          return ok({
            asOf: today(),
            counts,
            totalPersons: active.length,
            openReviewItems: reviewCounts().open,
            outstandingRequests: outstanding,
            turnaround: {
              count: times.length,
              meanDays: mean,
              medianDays: median,
              maxDays: times.length ? times[times.length - 1]! : null,
            },
            expiringSoon: exp,
            recentRequests: [...db.requests]
              .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
              .slice(0, 5)
              .map(summary),
            ...mockDashboardExtras(outstanding, exp),
          });
        }),
      expiryWatch: (q) => gate(() => ok(expiryRows(q.withinDays ?? 90))),
      exportExpiryCsv: (req) =>
        gate(() => {
          if (req.password !== db.vault.password) return fail('BAD_CREDENTIALS', 'Wrong password.');
          const rows = expiryRows(req.withinDays ?? 90);
          appendAudit(db, 'vetting.expiry-export', 'person', null);
          return ok({ path: req.destPath, count: rows.length, bytes: 64 + rows.length * 48 });
        }),
    },
    backup: {
      configure: (req) =>
        gate(() => {
          if (req.reauth.password !== db.vault.password) return fail('BAD_CREDENTIALS', 'Wrong password.');
          let newPassphrase: string | null = null;
          if (req.config === null) backupCfg = null;
          else {
            if (req.config.dir.trim() === '') return fail('BAD_REQUEST', 'Choose a backup folder.');
            const fresh = backupCfg === null || req.regeneratePassphrase === true;
            backupCfg = { ...req.config, hasPassphrase: true };
            if (fresh) newPassphrase = mockPassphrase();
          }
          appendAudit(db, 'backup.configure', 'vault', null);
          return ok({ ...backupList(), newPassphrase });
        }),
      list: () => gate(() => ok(backupList())),
      runNow: () =>
        gate(() => {
          if (!backupCfg) return fail('NOT_FOUND', 'No backup folder is configured');
          const at = new Date().toISOString();
          const name = `vss-backup-${at.slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}.vssbak`;
          backupFiles.unshift({ name, path: `${backupCfg.dir}/${name}`, bytes: 1_048_576, modifiedAt: at });
          appendAudit(db, 'vault.backup', 'vault', null);
          return ok({ path: `${backupCfg.dir}/${name}`, bytes: 1_048_576, sha256: 'd'.repeat(64) });
        }),
      restore: (req) => {
        if (db.vault.exists) return Promise.resolve(fail('VAULT_EXISTS', 'A vault already exists.'));
        if (req.passphrase.length < 12)
          return Promise.resolve(fail('BACKUP_INVALID', 'Backup passphrase is wrong or the file is damaged.'));
        db.vault.exists = true;
        db.vault.password = db.vault.password || password;
        db.vault.path = 'mock://data/vault.json';
        db.vault.locked = true;
        if (db.persons.length === 0 && opts.seed !== false) seed(db);
        return Promise.resolve(ok(status()));
      },
    },
    clipboard: {
      copy: (req) =>
        gate(() => {
          db.clipboard = req.text ?? '';
          if (clipTimer) clearTimeout(clipTimer);
          const secs = db.settings.clipboardClearSeconds;
          clipTimer = setTimeout(() => {
            db.clipboard = '';
            emit('clipboard:cleared', {});
          }, secs * 1000);
          return ok({ clearsInSeconds: secs });
        }),
      clear: () => {
        db.clipboard = '';
        return Promise.resolve(ok(ACK));
      },
    },
    updates: {
      state: () =>
        Promise.resolve(
          ok({
            ...update,
            phase: db.settings.updateCheckEnabled || update.phase !== 'idle' ? update.phase : 'disabled',
          }),
        ),
      check: () => {
        if (!db.settings.updateCheckEnabled)
          return Promise.resolve(fail('NETWORK_DISABLED', 'Update checks are turned off.'));
        update = { ...update, phase: 'checking' };
        emit('updates:state', update);
        update = { ...update, phase: 'up-to-date', checkedAt: new Date().toISOString() };
        return new Promise((res) =>
          setTimeout(() => {
            emit('updates:state', update);
            res(ok(update));
          }, 50),
        );
      },
      download: () => Promise.resolve(fail('NOT_SUPPORTED', 'No update is available in the mock.')),
      install: () => Promise.resolve(fail('NOT_SUPPORTED', 'No update is available in the mock.')),
    },
    audit: {
      list: (q) =>
        gate(() => {
          const rows = db.audit
            .filter(
              (e) =>
                (!q.type || e.type === q.type) &&
                (!q.subjectType || e.subjectType === q.subjectType) &&
                (!q.subjectId || e.subjectId === q.subjectId),
            )
            .sort((a, b) => b.seq - a.seq);
          return ok(page(structuredClone(rows), q.offset, q.limit));
        }),
      verify: () => gate(() => ok({ ok: true, checked: db.audit.length, brokenAtSeq: null })),
      export: (req) => gate(() => ok({ path: req.destPath })),
    },
    peer: {
      status: () => Promise.resolve(ok({ ...peer })),
      setEnabled: (req) => {
        peer = { ...peer, enabled: req.enabled, listening: req.enabled };
        emit('peer:status', peer);
        return Promise.resolve(ok({ ...peer }));
      },
      pair: () => Promise.resolve(fail('NOT_SUPPORTED', 'Peer mode is not available in the mock.')),
      forget: () => Promise.resolve(ok({ ...peer })),
      syncNow: () => Promise.resolve(fail('NOT_SUPPORTED', 'Peer mode is not available in the mock.')),
    },
    templates: {
      list: () => gate(() => ok(templateList())),
      import: (req) =>
        gate(() => {
          if (!/\.xlsx$/i.test(req.path)) return fail('FILE_INVALID', 'This workbook cannot be used as a template.');
          const now = new Date().toISOString();
          for (const t of db.templates) {
            if (t.active) {
              t.active = false;
              t.replacedAt = now;
            }
          }
          const name = req.path.split(/[\\/]/).pop() ?? req.path;
          const t = mockTemplate('manual', name, now);
          db.templates.push(t);
          appendAudit(db, 'template.import', 'template', t.id);
          return ok({ template: structuredClone(t), removedParts: 0, list: templateList() });
        }),
      setActive: (req) =>
        gate(() => {
          const t = db.templates.find((x) => x.id === req.id);
          if (!t) return fail('NOT_FOUND', 'Template not found.');
          const now = new Date().toISOString();
          for (const o of db.templates) {
            if (o.active && o !== t) {
              o.active = false;
              o.replacedAt = now;
            }
          }
          t.active = true;
          t.replacedAt = null;
          return ok(templateList());
        }),
      remove: (req) =>
        gate(() => {
          const i = db.templates.findIndex((x) => x.id === req.id);
          if (i < 0) return fail('NOT_FOUND', 'Template not found.');
          db.templates.splice(i, 1);
          appendAudit(db, 'template.remove', 'template', req.id);
          return ok(templateList());
        }),
    },
    files: {
      pickOpen: (req) => {
        const map: Record<string, string> = {
          'request-xlsx': 'mock://files/request-sample.xlsx',
          'response-xlsx': 'mock://files/response-sample.xlsx',
          vault: 'mock://vault/vault.json',
          backup: 'mock://files/backup.vssbackup',
          eml: 'mock://files/draft.eml',
          csv: 'mock://files/expiry.csv',
          audit: 'mock://files/audit-log.jsonl',
          directory: 'mock://folders/backups',
          any: 'mock://files/any.bin',
        };
        const p = map[req.kind] ?? null;
        return Promise.resolve(ok({ path: p, displayPath: p }));
      },
      pickSave: (req) =>
        Promise.resolve(
          ok({ path: `mock://saved/${req.suggestedName}`, displayPath: `mock://saved/${req.suggestedName}` }),
        ),
      reveal: () => Promise.resolve(ok(ACK)),
      saveStored: () => Promise.resolve(ok(ACK)),
    },
    on: (event, listener) => {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener as (p: never) => void);
      return () => {
        set.delete(listener as (p: never) => void);
      };
    },
  };

  if (initial === 'unlocked') {
    db.vault.locked = false;
    startTimer();
  }

  return {
    api,
    db,
    emit,
    fastForwardIdle: (s) => {
      for (let i = 0; i < s && !db.vault.locked; i++) tickIdle(1);
    },
    dispose: () => {
      stopTimer();
      if (clipTimer) clearTimeout(clipTimer);
    },
  };
}
