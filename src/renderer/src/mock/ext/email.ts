/** LANE E mock (docs/PLAN-ALPHA.md section 7): e-mail templates. Stubs until lane E lands. */
import { notYet } from './types';
import type { MockExtension } from './types';

export const emailMock: MockExtension = () => ({
  email: {
    renderTemplate: notYet('E-mail templates'),
    previewTemplate: notYet('E-mail templates'),
  },
});
