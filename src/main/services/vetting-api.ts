/**
 * Composition of the domain services over one open DB, shaped like the VssApi namespaces they implement
 * (requests, responses, persons, units, review, stats, requestors). Integration wires the real exporter and
 * password check.
 *
 * Alpha 1 lane slots (docs/PLAN-ALPHA.md): `requestors` (B), `lifecycle` (D) and `emailTemplates` (E) are built
 * first, from the plain deps, and feed the cross-lane hooks (services/hooks.ts) that every other service receives.
 */
import type { Dashboard, DashboardQuery, Result } from '@shared/ipc/contract';
import { AuditLog } from './audit';
import { createEmailTemplatesService } from './email-templates';
import type { EmailTemplatesDeps, EmailTemplatesService } from './email-templates';
import type { ExporterPort } from './exporter-port';
import type { DomainHooks } from './hooks';
import { createLifecycleService } from './lifecycle';
import type { LifecycleService } from './lifecycle';
import { createPersonsService, createUnitsService } from './people';
import type { PersonsService, UnitsService } from './people';
import { createRequestorsService } from './requestors';
import type { RequestorsService } from './requestors';
import { createRequestsService } from './requests';
import type { RequestsService } from './requests';
import { createResponsesService } from './responses';
import type { ResponsesService } from './responses';
import { createReviewService } from './review';
import type { ReviewService } from './review';
import { createVettingService } from './vetting';
import type { VettingService } from './vetting';
import type { ServiceDeps } from './vetting-common';

export interface DomainServices {
  requests: RequestsService;
  responses: ResponsesService;
  persons: PersonsService;
  units: UnitsService;
  review: ReviewService;
  vetting: VettingService;
  stats: { dashboard(req: DashboardQuery): Promise<Result<Dashboard>> };
  /** Lane B. */
  requestors: RequestorsService;
  /** Lane D (requests.close / requests.reopen and the Finished recompute hook). */
  lifecycle: LifecycleService;
  /** Lane E (email.renderTemplate / email.previewTemplate). */
  emailTemplates: EmailTemplatesService;
  /** Drop in-memory state holding personal data (import previews); called on every lock (F-14). */
  dispose(): void;
}

export function createDomainServices(
  deps: Omit<ServiceDeps, 'audit'> & {
    audit?: AuditLog;
    exporter: ExporterPort;
    /** Request data for e-mail template placeholders (lane E). */
    emailSnapshot?: EmailTemplatesDeps['snapshot'];
  },
): DomainServices {
  const base: ServiceDeps = { ...deps, audit: deps.audit ?? new AuditLog(deps.db) };
  const requestors = createRequestorsService(base);
  const lifecycle = createLifecycleService(base);
  const emailTemplates = createEmailTemplatesService({
    ...base,
    ...(deps.emailSnapshot ? { snapshot: deps.emailSnapshot } : {}),
  });
  const hooks: DomainHooks = {
    touchRequestor: (r) => requestors.touch(r),
    onRequestAnswered: (id) => lifecycle.onRequestAnswered(id),
  };
  const full: ServiceDeps = { ...base, hooks: { ...hooks, ...(deps.hooks ?? {}) } };
  const vetting = createVettingService(full);
  const requests = createRequestsService({ ...full, exporter: deps.exporter });
  const responses = createResponsesService(full);
  return {
    requests,
    responses,
    persons: createPersonsService(full),
    units: createUnitsService(full),
    review: createReviewService(full),
    vetting,
    stats: { dashboard: (q) => vetting.dashboard(q) },
    requestors,
    lifecycle,
    emailTemplates,
    dispose: () => {
      requests.clearPreviews();
      responses.clearPreviews();
    },
  };
}
