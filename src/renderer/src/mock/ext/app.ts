/** LANE I mock (docs/PLAN-ALPHA.md section 12): feedback link. The base mock implements `app.info`. */
import { notYet } from './types';
import type { MockExtension } from './types';

export const appMock: MockExtension = () => ({
  app: {
    openFeedback: notYet('Feedback'),
  },
});
