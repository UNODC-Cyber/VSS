/**
 * LANE L mock (docs/PLAN-ALPHA.md section 15): the Settings danger zone. `vault.wipe` already exists in the base
 * mock; lane L adapts it here (wrong password -> BAD_CREDENTIALS, success resets the in-memory DB).
 */
import type { MockExtension } from './types';

export const dangerMock: MockExtension = () => ({});
