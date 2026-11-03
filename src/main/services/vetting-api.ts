/**
 * Composition of the domain services over one open DB, shaped like the VssApi namespaces they implement
 * (requests, responses, persons, units, review, stats). Integration wires the real exporter and password check.
 */
import type { Dashboard, DashboardQuery, Result } from '@shared/ipc/contract';
import { AuditLog } from './audit';
import type { ExporterPort } from './exporter-port';
import { createPersonsService, createUnitsService } from './people';
import type { PersonsService, UnitsService } from './people';
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
  /** Drop in-memory state holding personal data (import previews); called on every lock (F-14). */
  dispose(): void;
}

export function createDomainServices(
  deps: Omit<ServiceDeps, 'audit'> & { audit?: AuditLog; exporter: ExporterPort },
): DomainServices {
  const full: ServiceDeps = { ...deps, audit: deps.audit ?? new AuditLog(deps.db) };
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
    dispose: () => {
      requests.clearPreviews();
      responses.clearPreviews();
    },
  };
}
