/**
 * LANE B SLOT (docs/PLAN-ALPHA.md section 4): persistent, de-duplicated requestors and the type-ahead search.
 * Until lane B lands, every IPC method answers NOT_SUPPORTED and `touch` stores nothing (behaviour of 0.1).
 */
import type { Requestor, RequestorRecord, Ulid } from '@shared/domain/types';
import type {
  IdRef,
  Page,
  RequestorListQuery,
  RequestorMergeRequest,
  RequestorSearchQuery,
  RequestorUpsertRequest,
  Result,
} from '@shared/ipc/contract';
import { notSupported } from './vetting-common';
import type { ServiceDeps } from './vetting-common';

export interface RequestorsService {
  search(req: RequestorSearchQuery): Promise<Result<RequestorRecord[]>>;
  get(req: IdRef): Promise<Result<RequestorRecord>>;
  upsert(req: RequestorUpsertRequest): Promise<Result<RequestorRecord>>;
  merge(req: RequestorMergeRequest): Promise<Result<RequestorRecord>>;
  list(req: RequestorListQuery): Promise<Result<Page<RequestorRecord>>>;
  /** DomainHooks.touchRequestor: runs inside the request's write transaction. */
  touch(requestor: Requestor): Ulid | null;
}

export function createRequestorsService(deps: ServiceDeps): RequestorsService {
  void deps;
  return {
    search: () => notSupported('Saved requestors'),
    get: () => notSupported('Saved requestors'),
    upsert: () => notSupported('Saved requestors'),
    merge: () => notSupported('Saved requestors'),
    list: () => notSupported('Saved requestors'),
    touch: () => null,
  };
}
