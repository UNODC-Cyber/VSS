/**
 * `templates.*` service: the INVESTc export templates kept INSIDE the vault. VSS ships no template (the counterpart's
 * form is not ours to redistribute), so regenerate-mode exports use the one stored here:
 *
 * - auto-capture: when a valid request workbook of a known version is imported and no template is active yet, a
 *   sanitised blank copy of it becomes the active template (`captureIfNone`, called inside the import transaction);
 * - manual: Settings > Templates imports a blank or any INVESTc workbook, sanitised the same way, and makes it active.
 *   The replaced template stays as history and can be re-activated or removed.
 *
 * Sanitising = the package whitelist (no custom XML, label metadata, custom properties, printer settings, pictures,
 * comments, absPath, creator names, ...) plus removal of every unit and individual row (extractBlankTemplate).
 */
import type {
  IdRef,
  Result,
  TemplateImportRequest,
  TemplateImportResult,
  TemplateInfo,
  TemplateList,
} from '@shared/ipc/contract';
import type { TemplateRecord } from '../db/repos';
import { extractBlankTemplate } from '../formats/investc/export';
import { baseName, fail, makeCtx, run } from './vetting-common';
import type { Ctx, ServiceDeps } from './vetting-common';

const KIND = 'investc-request' as const;

export interface TemplatesService {
  list(): Promise<Result<TemplateList>>;
  import(req: TemplateImportRequest): Promise<Result<TemplateImportResult>>;
  setActive(req: IdRef): Promise<Result<TemplateList>>;
  remove(req: IdRef): Promise<Result<TemplateList>>;
}

export const toTemplateInfo = (r: TemplateRecord): TemplateInfo => ({
  id: r.id,
  kind: r.kind,
  source: r.source,
  originalName: r.originalName,
  templateVersion: r.templateVersion,
  instructionsVersion: r.instructionsVersion,
  sha256: r.sha256,
  bytes: r.bytes,
  createdAt: r.createdAt,
  active: r.active,
  replacedAt: r.replacedAt,
});

export function templateList(ctx: Ctx): TemplateList {
  const all = ctx.repos.templates.list(KIND).map(toTemplateInfo);
  return { active: all.find((t) => t.active) ?? null, history: all.filter((t) => !t.active) };
}

/** Bytes of the active template, or null when none is stored. */
export function activeTemplateBytes(ctx: Ctx): Uint8Array | null {
  const t = ctx.repos.templates.active(KIND);
  return t ? ctx.repos.templates.content(t.id) : null;
}

/**
 * Auto-capture. Call inside the import transaction, and record the capture in that import's single audit event
 * (one mutator, one audit event). Returns the new template, or null when a template is already active or the file
 * cannot serve as one (unknown version, parts the whitelist does not recognise, ...): the import itself never fails
 * because of this.
 */
export function captureIfNone(ctx: Ctx, fileName: string, bytes: Uint8Array): TemplateInfo | null {
  if (ctx.repos.templates.active(KIND)) return null;
  let extracted: ReturnType<typeof extractBlankTemplate>;
  try {
    extracted = extractBlankTemplate(bytes, ctx.now());
  } catch {
    return null;
  }
  const rec = ctx.repos.templates.insertActive({
    kind: KIND,
    source: 'auto-capture',
    originalName: baseName(fileName),
    templateVersion: extracted.templateVersion,
    instructionsVersion: extracted.instructionsVersion,
    content: extracted.bytes,
    at: ctx.nowIso(),
  });
  return toTemplateInfo(rec);
}

export function createTemplatesService(deps: ServiceDeps): TemplatesService {
  const ctx = makeCtx(deps);
  return {
    list: () => run(() => templateList(ctx)),

    import: async ({ path }) => {
      let bytes: Uint8Array;
      try {
        bytes = await ctx.files.read(path);
      } catch {
        return { ok: false, error: { code: 'FILE_UNREADABLE', message: 'The file could not be read' } };
      }
      return run(() => {
        let extracted: ReturnType<typeof extractBlankTemplate>;
        try {
          extracted = extractBlankTemplate(bytes, ctx.now());
        } catch (e) {
          // The reason is about workbook structure (never cell content), so it is safe to show.
          return fail('FILE_INVALID', e instanceof Error ? e.message : 'This workbook cannot be used as a template.');
        }
        const rec = ctx.tx('templates.import', () => {
          const r = ctx.repos.templates.insertActive({
            kind: KIND,
            source: 'manual',
            originalName: baseName(path),
            templateVersion: extracted.templateVersion,
            instructionsVersion: extracted.instructionsVersion,
            content: extracted.bytes,
            at: ctx.nowIso(),
          });
          ctx.audit('template.import', 'template', r.id, {
            source: 'manual',
            templateVersion: r.templateVersion ?? '',
            sha256: r.sha256,
            bytes: r.bytes,
            count: extracted.removed.length,
          });
          return r;
        });
        return { template: toTemplateInfo(rec), removedParts: extracted.removed.length, list: templateList(ctx) };
      });
    },

    setActive: ({ id }) =>
      run(() =>
        ctx.tx('templates.setActive', () => {
          const r = ctx.repos.templates.setActive(id, ctx.nowIso()) ?? fail('NOT_FOUND', 'Template not found');
          ctx.audit('template.activate', 'template', id, {
            templateVersion: r.templateVersion ?? '',
            sha256: r.sha256,
          });
          return templateList(ctx);
        }),
      ),

    remove: ({ id }) =>
      run(() =>
        ctx.tx('templates.remove', () => {
          const r = ctx.repos.templates.get(id) ?? fail('NOT_FOUND', 'Template not found');
          ctx.repos.templates.delete(id);
          ctx.audit('template.remove', 'template', id, {
            templateVersion: r.templateVersion ?? '',
            sha256: r.sha256,
            enabled: r.active,
          });
          return templateList(ctx);
        }),
      ),
  };
}
