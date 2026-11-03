import { createMockApi } from './mockApi';
import type { MockControl, MockOptions } from './mockApi';

declare global {
  interface Window {
    /** Dev/test control surface for the mock backend. Never present in production builds. */
    __vssMock?: MockControl;
  }
}

/** Replace `window.vss` with the in-memory mock. Development builds only. */
export function installMock(options: MockOptions = {}): MockControl {
  const ctl = createMockApi(options);
  Object.defineProperty(window, 'vss', { value: ctl.api, configurable: true, writable: true });
  window.__vssMock = ctl;
  return ctl;
}
