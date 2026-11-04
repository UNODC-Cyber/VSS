/** LANE K mock (docs/PLAN-ALPHA.md section 14): picker suggestions, manual validate, edit in place. Stubs until K. */
import { notYet } from './types';
import type { MockExtension } from './types';

export const reviewMock: MockExtension = () => ({
  persons: {
    suggest: notYet('Person suggestions'),
  },
  review: {
    manualValidate: notYet('Manual validation'),
    editSubject: notYet('Editing a review subject'),
  },
});
