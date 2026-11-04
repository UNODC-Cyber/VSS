/**
 * LANE D SLOT (docs/PLAN-ALPHA.md section 6): request lifecycle (derived Finished, gated Close, Reopen with a
 * reason). Until lane D lands, close/reopen answer NOT_SUPPORTED and `onRequestAnswered` does nothing.
 */
import type { Ulid } from '@shared/domain/types';
import type { RequestCloseRequest, RequestReopenRequest, RequestSummary, Result } from '@shared/ipc/contract';
import { notSupported } from './vetting-common';
import type { ServiceDeps } from './vetting-common';

export interface LifecycleService {
  close(req: RequestCloseRequest): Promise<Result<RequestSummary>>;
  reopen(req: RequestReopenRequest): Promise<Result<RequestSummary>>;
  /** DomainHooks.onRequestAnswered: runs inside the caller's write transaction. */
  onRequestAnswered(requestId: Ulid): void;
}

export function createLifecycleService(deps: ServiceDeps): LifecycleService {
  void deps;
  return {
    close: () => notSupported('Closing a request'),
    reopen: () => notSupported('Reopening a request'),
    onRequestAnswered: () => undefined,
  };
}
