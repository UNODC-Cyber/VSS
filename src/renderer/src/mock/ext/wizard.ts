/**
 * LANE F mock (docs/PLAN-ALPHA.md section 8): wizard behaviour, e.g. a request fixture picked in the response
 * importer answering LOOKS_LIKE_REQUEST / WRONG_FILE_KIND. Nothing yet: the base mock already implements
 * `requests.discardPreview` and `responses.discardPreview`.
 */
import type { MockExtension } from './types';

export const wizardMock: MockExtension = () => ({});
