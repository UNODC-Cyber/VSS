/**
 * The single extension hook of the mock backend: `applyMockExtensions` merges every lane module over the base
 * mock (mockApi.ts). One module per lane; this list is the only shared line (docs/PLAN-ALPHA.md section 3).
 */
import type { VssApi, VssEventMap, VssEventName } from '@shared/ipc/contract';
import type { MockDb } from '../db';
import { appMock } from './app';
import { dangerMock } from './danger';
import { emailMock } from './email';
import { lifecycleMock } from './lifecycle';
import { requestorsMock } from './requestors';
import { reviewMock } from './review';
import type { MockBaseApi, MockExtension } from './types';
import { wizardMock } from './wizard';

export const MOCK_EXTENSIONS: readonly MockExtension[] = [
  requestorsMock, // B
  lifecycleMock, // D
  emailMock, // E
  wizardMock, // F
  reviewMock, // K
  appMock, // I
  dangerMock, // L
];

export function applyMockExtensions(
  api: MockBaseApi,
  db: MockDb,
  emit: <E extends VssEventName>(name: E, payload: VssEventMap[E]) => void,
  extensions: readonly MockExtension[] = MOCK_EXTENSIONS,
): VssApi {
  const out: Record<string, unknown> = { ...api };
  for (const ext of extensions) {
    for (const [ns, methods] of Object.entries(ext({ db, emit }))) {
      out[ns] = { ...((out[ns] as object | undefined) ?? {}), ...methods };
    }
  }
  // Completeness is enforced by tests/unit/contract-completeness.test.ts (every METHODS entry is a function).
  return out as unknown as VssApi;
}
