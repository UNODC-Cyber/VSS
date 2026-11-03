/**
 * Lane J integration: plugs lane H's domain services (requests, responses, persons, units, review, stats) into the
 * composition root's LANE H SLOT, with the real INVESTc exporter (lane G), the vault-backed password check, an
 * overwrite-safe file writer and the data providers lane I's email / clipboard handlers need.
 *
 * The services hold prepared statements of ONE open connection, so they are rebuilt whenever the controller hands
 * out a new connection (every unlock). Their in-memory import previews therefore never survive a lock.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { Ulid, VettingStatus } from '@shared/domain/types';
import type { ClipboardField, FileKind, Result } from '@shared/ipc/contract';
import { err } from '@shared/ipc/result';
import type { Db } from '../db/open';
import { isDbError } from '../db/errors';
import { exportInvestc, suggestExportFilename } from '../formats/investc/export';
import { ZIP_LIMITS } from '../formats/ooxml/zip';
import type { Handlers } from '../ipc/registry';
import { observedName } from '../matching/records';
import type { RequestStatusSnapshot } from '../services/email';
import type { ExporterPort } from '../services/exporter-port';
import { PathGrantError } from '../services/files';
import type { GrantMode } from '../services/files';
import { createDomainServices } from '../services/vetting-api';
import type { DomainServices } from '../services/vetting-api';
import { snapshotsFor } from '../services/vetting-status';
import { createTemplatesService } from '../services/templates';
import type { TemplatesService } from '../services/templates';
import { displayName, makeCtx } from '../services/vetting-common';
import type { Ctx, FileIo } from '../services/vetting-common';
import type { HostSources, LaneHContribution, ServiceContext } from './compose';

/** The real exporter (lane G). Regenerate mode uses the template the requests service reads from the vault. */
export const investcExporter: ExporterPort = {
  exportInvestc: (input) => exportInvestc(input),
  suggestExportFilename,
};

/**
 * File access for import/export/CSV: reads as is; writes go to a temp file next to the target and are renamed over
 * it, so a file the user agreed to replace in the save dialog is replaced atomically (never half-written).
 */
export const atomicFiles: FileIo = {
  read: async (p) => new Uint8Array(await readFile(p)),
  write: async (p, bytes) => {
    const tmp = `${p}.${randomBytes(6).toString('hex')}.partial`;
    try {
      await writeFile(tmp, bytes, { flag: 'wx' });
      await rename(tmp, p);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  },
  remove: (p) => rm(p, { force: true }),
};

const STATUS_LABEL: Record<VettingStatus, string> = {
  unknown: 'Not yet vetted',
  pending: 'Pending',
  approved: 'Approved',
  expiring: 'Approved (expiring soon)',
  expired: 'Expired',
  'non-approved': 'Not approved',
};

/** Email table rows for a request: one per item, names exactly as submitted, status of the linked person. */
export function requestStatusSnapshot(ctx: Ctx, requestId: Ulid): RequestStatusSnapshot | null {
  const req = ctx.repos.requests.get(requestId);
  if (!req) return null;
  const personIds = req.items.flatMap((i) => (i.personId ? [i.personId] : []));
  const snaps = snapshotsFor(ctx, personIds);
  const latest = ctx.repos.exports.latestForRequest(requestId);
  const file = latest?.fileId ? ctx.repos.files.get(latest.fileId) : null;
  return {
    eventName: req.eventName,
    asOf: ctx.today(),
    attachmentName: file?.originalName ?? null,
    rows: req.items.map((i) => {
      const s = i.personId ? snaps.get(i.personId) : undefined;
      const status: VettingStatus = s?.status ?? (i.personId ? 'unknown' : 'pending');
      const o = i.observed;
      return {
        name: displayName(observedName(o)),
        unit: o.unitName,
        status: STATUS_LABEL[status],
        validUntil: status === 'non-approved' ? null : (s?.expiresAt ?? null),
        dob: o.dob.parsed ?? (o.dob.value || null),
        idNumber: [o.passport, o.nationalId].filter((x) => x.trim() !== '').join(' / ') || null,
      };
    }),
  };
}

/** Values the clipboard handler may copy for a person (resolved in main; the renderer never composes them). */
export function personField(ctx: Ctx, personId: Ulid, field: ClipboardField): string | null {
  const p = ctx.repos.persons.get(personId);
  if (!p) return null;
  const snap = snapshotsFor(ctx, [personId]).get(personId);
  const unitName = (): string | null => {
    const id = snap?.unitId ?? ctx.repos.requests.itemsByPerson(personId).at(-1)?.unitId ?? null;
    return id ? (ctx.repos.units.get(id)?.name ?? null) : null;
  };
  const ident = (t: 'passport' | 'national-id'): string | null =>
    p.identifiers.find((i) => i.type === t)?.value ?? null;
  switch (field) {
    case 'name':
      return displayName(p.canonical);
    case 'dob':
      return p.dob;
    case 'passport':
      return ident('passport');
    case 'national-id':
      return ident('national-id');
    case 'unit':
      return unitName();
    case 'status-line': {
      const status = snap?.status ?? 'unknown';
      const until = snap?.expiresAt && status !== 'non-approved' ? `, valid until ${snap.expiresAt}` : '';
      return `${displayName(p.canonical)}: ${STATUS_LABEL[status]}${until}`;
    }
    case 'plain':
      return null;
  }
}

type Wrapped = (arg: unknown) => Promise<Result<unknown>>;

/**
 * Arguments that name a user file (F-02): they arrive as dialog-issued tokens and are resolved to the chosen path
 * before the service runs. [field, grant mode, accepted file kinds].
 */
const PATH_ARGS: Record<string, readonly [string, GrantMode, readonly FileKind[]]> = {
  'requests.importPreview': ['path', 'open', ['request-xlsx']],
  'responses.importPreview': ['path', 'open', ['response-xlsx']],
  'requests.export': ['destPath', 'save', ['request-xlsx']],
  'stats.exportExpiryCsv': ['destPath', 'save', ['csv']],
};

/** Methods after which the open review count may have changed (pushed to the renderer as 'review:counts'). */
const MUTATING: Record<string, readonly string[]> = {
  requests: ['importCommit', 'createManual', 'linkItem', 'remove', 'setItemDecision'],
  responses: ['importCommit', 'setRowMatch', 'recordEmailClearance', 'recordManual'],
  persons: ['merge', 'unmerge', 'split', 'markNotSame', 'purge', 'scanDuplicates', 'update'],
  units: ['merge'],
  review: ['resolve'],
};

/** The lane H factory for `composeApp({ laneH })`. */
export function createDomainContribution(sc: ServiceContext): LaneHContribution {
  let cache: { conn: Db; svc: DomainServices & { templates: TemplatesService }; ctx: Ctx } | null = null;
  // F-14: on lock, drop the services with their import previews (parsed files with personal data) and caches
  // instead of keeping them in memory until the next unlock.
  sc.onLock(() => {
    cache?.svc.dispose();
    cache = null;
  });

  /** Services over the current connection; throws DbError NOT_OPEN while locked. */
  const current = (): { svc: DomainServices; ctx: Ctx } => {
    const conn = sc.db.current();
    if (!cache || cache.conn !== conn) {
      const deps = {
        db: conn,
        repos: sc.repos(),
        audit: sc.audit(),
        clock: () => new Date(sc.now()),
        settings: sc.settings,
        files: atomicFiles,
        verifyPassword: sc.verifyPassword,
      };
      cache = {
        conn,
        svc: {
          ...createDomainServices({ ...deps, exporter: investcExporter }),
          templates: createTemplatesService(deps),
        },
        ctx: makeCtx(deps),
      };
    }
    return cache;
  };

  const pushReviewCounts = async (): Promise<void> => {
    try {
      const r = await current().svc.review.counts();
      if (r.ok) sc.emit('review:counts', r.value);
    } catch {
      // locked in between: nothing to push
    }
  };

  const wrap =
    (ns: string, method: string, pick: (s: DomainServices) => Wrapped): Wrapped =>
    async (arg) => {
      let r: Result<unknown>;
      const spec = PATH_ARGS[`${ns}.${method}`];
      let call = arg;
      let written: string | null = null;
      if (spec) {
        const [field, mode, kinds] = spec;
        const a = (arg ?? {}) as Record<string, unknown>;
        let real: string;
        try {
          real = sc.grants.resolve(a[field], mode, kinds);
        } catch (e) {
          if (e instanceof PathGrantError) return err('BAD_REQUEST', e.message);
          throw e;
        }
        call = { ...a, [field]: real };
        if (mode === 'save') written = real;
        // F-09: never read a huge file into memory just to reject it.
        if (mode === 'open') {
          const size = await stat(real).then(
            (s) => s.size,
            () => null,
          );
          if (size !== null && size > ZIP_LIMITS.maxInputBytes)
            return err(
              'FILE_INVALID',
              `The file is larger than ${ZIP_LIMITS.maxInputBytes / 1024 / 1024} MiB; VSS imports workbooks up to that size`,
            );
        }
      }
      try {
        r = await pick(current().svc)(call);
      } catch (e) {
        if (isDbError(e, 'NOT_OPEN')) return err('VAULT_LOCKED', 'Vault is locked');
        throw e;
      }
      if (r.ok && written) sc.grants.noteWritten(written);
      if (r.ok && MUTATING[ns]?.includes(method)) void pushReviewCounts();
      return r;
    };

  const table: Record<string, readonly string[]> = {
    requests: [
      'list',
      'get',
      'importPreview',
      'importCommit',
      'createManual',
      'update',
      'setStatus',
      'setItemDecision',
      'linkItem',
      'exportPreview',
      'export',
      'remove',
    ],
    responses: ['list', 'get', 'importPreview', 'importCommit', 'setRowMatch', 'recordEmailClearance', 'recordManual'],
    persons: ['list', 'get', 'update', 'merge', 'unmerge', 'split', 'markNotSame', 'purge', 'scanDuplicates'],
    units: ['list', 'get', 'update', 'addAlias', 'merge'],
    review: ['list', 'get', 'resolve', 'counts'],
    templates: ['list', 'import', 'setActive', 'remove'],
  };
  const handlers: Record<string, Record<string, Wrapped>> = {};
  for (const [ns, methods] of Object.entries(table)) {
    handlers[ns] = {};
    for (const m of methods) {
      handlers[ns]![m] = wrap(ns, m, (s) => {
        const svc = (s as unknown as Record<string, Record<string, Wrapped>>)[ns]!;
        return svc[m]!.bind(svc) as Wrapped;
      });
    }
  }
  handlers['stats'] = {
    dashboard: wrap('stats', 'dashboard', (s) => s.vetting.dashboard as Wrapped),
    expiryWatch: wrap('stats', 'expiryWatch', (s) => s.vetting.expiryWatch as Wrapped),
    exportExpiryCsv: wrap('stats', 'exportExpiryCsv', (s) => s.vetting.exportExpiryCsv as Wrapped),
  };

  const sources: HostSources = {
    requestStatus: {
      snapshot: async (requestId) => requestStatusSnapshot(current().ctx, requestId),
    },
    exportFiles: {
      read: async (exportId) => {
        const { ctx } = current();
        const rec = ctx.repos.exports.get(exportId);
        if (!rec?.fileId) return null;
        const meta = ctx.repos.files.get(rec.fileId);
        const bytes = ctx.repos.files.content(rec.fileId);
        return meta && bytes ? { name: meta.originalName, bytes: new Uint8Array(bytes) } : null;
      },
    },
    personFields: {
      field: (personId, field) => personField(current().ctx, personId, field),
    },
  };

  return { handlers: handlers as Handlers, sources };
}
