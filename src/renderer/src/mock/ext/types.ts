/**
 * Mock extension contract (docs/PLAN-ALPHA.md section 16, "Mock parity"). Each Alpha 1 lane implements its new or
 * changed methods in its own `mock/ext/<lane>.ts` module, so no two lanes edit mockApi.ts. A module receives the
 * shared in-memory DB and the event emitter and returns method implementations, grouped by namespace; they are
 * merged over the base mock in the order of `MOCK_EXTENSIONS` (later modules win).
 */
import type { Result, VssApi, VssError, VssErrorCode, VssEventMap, VssEventName } from '@shared/ipc/contract';
import type { MockDb } from '../db';

type Namespaces = Exclude<keyof VssApi, 'on'>;

/** Methods the base mock leaves to a lane's extension module (each ships a NOT_SUPPORTED stub until the lane lands). */
export interface LaneMethods {
  requests: 'close' | 'reopen';
  requestors: keyof VssApi['requestors'];
  persons: 'suggest';
  review: 'manualValidate' | 'editSubject';
  email: 'renderTemplate' | 'previewTemplate';
  app: 'openFeedback';
}
type LaneMethodsOf<N extends Namespaces> = N extends keyof LaneMethods ? LaneMethods[N] : never;

/** What mockApi.ts itself must implement: everything except the lane methods. */
export type MockBaseApi = { [N in Namespaces]: Omit<VssApi[N], LaneMethodsOf<N>> } & Pick<VssApi, 'on'>;

/** A partial implementation, grouped by namespace. */
export type MockApiPatch = { [N in Namespaces]?: Partial<VssApi[N]> };

export interface MockExtContext {
  db: MockDb;
  emit: <E extends VssEventName>(name: E, payload: VssEventMap[E]) => void;
}
export type MockExtension = (ctx: MockExtContext) => MockApiPatch;

export const mockOk = <T>(value: T): Result<T> => ({ ok: true, value });
export const mockFail = (code: VssErrorCode, message: string): Result<never> => ({
  ok: false,
  error: { code, message } as VssError,
});
/** The answer of a method whose lane has not landed yet (same code as the real backend). */
export const notYet = (what: string) => (): Promise<Result<never>> =>
  Promise.resolve(mockFail('NOT_SUPPORTED', `${what} is not available in this version.`));
