/** LANE B mock (docs/PLAN-ALPHA.md section 4): saved requestors and the type-ahead. Stubs until lane B lands. */
import { notYet } from './types';
import type { MockExtension } from './types';

export const requestorsMock: MockExtension = () => ({
  requestors: {
    search: notYet('Saved requestors'),
    get: notYet('Saved requestors'),
    upsert: notYet('Saved requestors'),
    merge: notYet('Saved requestors'),
    list: notYet('Saved requestors'),
  },
});
