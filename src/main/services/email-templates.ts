/**
 * LANE E SLOT (docs/PLAN-ALPHA.md section 7): e-mail template engine (placeholders, defaults, preview against a
 * synthetic sample). Until lane E lands, both IPC methods answer NOT_SUPPORTED and drafts use services/email.ts.
 */
import type {
  EmailPreviewTemplateRequest,
  EmailRenderTemplateRequest,
  EmailTemplateRender,
  Result,
} from '@shared/ipc/contract';
import { notSupported } from './vetting-common';
import type { ServiceDeps } from './vetting-common';

export interface EmailTemplatesService {
  renderTemplate(req: EmailRenderTemplateRequest): Promise<Result<EmailTemplateRender>>;
  /** Synthetic sample only: never reads vault data. */
  previewTemplate(req: EmailPreviewTemplateRequest): Promise<Result<EmailTemplateRender>>;
}

export function createEmailTemplatesService(deps: ServiceDeps): EmailTemplatesService {
  void deps;
  return {
    renderTemplate: () => notSupported('E-mail templates'),
    previewTemplate: () => notSupported('E-mail templates'),
  };
}
