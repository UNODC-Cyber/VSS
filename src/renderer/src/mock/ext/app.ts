/** LANE I mock (docs/PLAN-ALPHA.md section 12): feedback link. The base mock implements `app.info`. */
import { ok } from '@shared/ipc/result';
import type { AppChannel } from '@shared/ipc/contract';
import type { MockExtension } from './types';

/** `?channel=alpha` in the dev-mock URL shows the alpha banner; default dev. */
function mockChannel(): AppChannel {
  try {
    const c = new URLSearchParams(globalThis.location?.search ?? '').get('channel');
    return c === 'alpha' || c === 'release' ? c : 'dev';
  } catch {
    return 'dev';
  }
}

export const appMock: MockExtension = () => ({
  app: {
    // Mock only: nothing opens; the real URL is built in main (src/main/app/channel.ts).
    openFeedback: () => Promise.resolve(ok({ ok: true as const })),
    info: () =>
      Promise.resolve(
        ok({
          version: '0.2.0-alpha.1',
          channel: mockChannel(),
          platform: 'mock',
          schemaVersion: 8,
        }),
      ),
  },
});
