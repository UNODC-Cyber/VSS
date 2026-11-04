/**
 * LANE F mock (docs/PLAN-ALPHA.md section 8). The wrong-kind answer (WRONG_FILE_KIND for a request workbook picked in
 * the response importer) lives in the base `responses.importPreview` in mockApi.ts: an extension cannot wrap the base
 * method and the hook gives it no other route. The base mock already implements `requests.discardPreview` and
 * `responses.discardPreview`, so this module adds nothing.
 */
import type { MockExtension } from './types';

export const wizardMock: MockExtension = () => ({});
