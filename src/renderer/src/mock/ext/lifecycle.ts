/** LANE D mock (docs/PLAN-ALPHA.md section 6): request close / reopen. Stubs until lane D lands. */
import { notYet } from './types';
import type { MockExtension } from './types';

export const lifecycleMock: MockExtension = () => ({
  requests: {
    close: notYet('Closing a request'),
    reopen: notYet('Reopening a request'),
  },
});
