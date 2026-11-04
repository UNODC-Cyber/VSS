/**
 * Lane E (docs/PLAN-ALPHA.md section 7): e-mail template rendering for `email.renderTemplate` (a request's real data)
 * and `email.previewTemplate` (a fixed synthetic sample, never vault data). The engine is src/shared/email-templates.ts;
 * the user's overrides live in the encrypted settings (Settings.emailTemplates).
 */
import type { Settings } from '@shared/domain/types';
import { DEFAULT_TEMPLATES, SAMPLE_CONTEXT, renderTemplateText } from '@shared/email-templates';
import type {
  EmailPreviewTemplateRequest,
  EmailRenderTemplateRequest,
  EmailTemplateRender,
  Result,
} from '@shared/ipc/contract';
import { err, ok } from '@shared/ipc/result';
import { snapshotContext } from './email';
import type { RequestStatusSnapshot } from './email';
import { notSupported } from './vetting-common';
import type { ServiceDeps } from './vetting-common';

export interface EmailTemplatesService {
  renderTemplate(req: EmailRenderTemplateRequest): Promise<Result<EmailTemplateRender>>;
  /** Synthetic sample only: never reads vault data. */
  previewTemplate(req: EmailPreviewTemplateRequest): Promise<Result<EmailTemplateRender>>;
}

export type EmailTemplatesDeps = ServiceDeps & {
  /** Request data for placeholders (supplied by the host wiring; absent = renderTemplate is NOT_SUPPORTED). */
  snapshot?: (requestId: string) => RequestStatusSnapshot | null;
};

export function createEmailTemplatesService(deps: EmailTemplatesDeps): EmailTemplatesService {
  const settings = (): Settings => deps.settings?.() ?? deps.repos.settings.getAll();
  return {
    renderTemplate: async (req) => {
      if (!deps.snapshot) return notSupported('E-mail templates');
      const snap = deps.snapshot(req.requestId);
      if (!snap) return err('NOT_FOUND', 'Request not found');
      const stored = settings().emailTemplates[req.template] ?? DEFAULT_TEMPLATES[req.template];
      const text = { subject: req.overrides?.subject ?? stored.subject, body: req.overrides?.body ?? stored.body };
      return ok(renderTemplateText(req.template, text, snapshotContext(snap)));
    },
    previewTemplate: async (req) =>
      ok(renderTemplateText(req.template, { subject: req.subject, body: req.body }, SAMPLE_CONTEXT)),
  };
}
