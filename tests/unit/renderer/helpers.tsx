/**
 * Shared helpers for renderer tests (jsdom). Import this FIRST in every renderer test file:
 * it installs browser polyfills that Mantine needs and jest-dom matchers.
 */
import '@testing-library/jest-dom/vitest';
import { MantineProvider } from '@mantine/core';
import { cleanup, render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../src/shared/domain/types';
import { ToastHost } from '../../../src/renderer/src/components/ToastHost';
import { App } from '../../../src/renderer/src/App';
import { i18n } from '../../../src/renderer/src/i18n';
import { installMock } from '../../../src/renderer/src/mock/install';
import type { MockControl, MockOptions } from '../../../src/renderer/src/mock/mockApi';
import { theme } from '../../../src/renderer/src/theme';
import { useUi } from '../../../src/renderer/src/store';

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
class RO {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as unknown as Record<string, unknown>)['ResizeObserver'] ??= RO;
Element.prototype.scrollIntoView ??= () => undefined;

beforeEach(() => {
  window.location.hash = '';
  useUi.setState({
    vault: null,
    epoch: 0,
    settings: structuredClone(DEFAULT_SETTINGS),
    reviewOpen: 0,
    update: null,
    peer: null,
    lockWarning: null,
    bootError: null,
    toasts: [],
  });
});

let current: MockControl | null = null;
afterEach(() => {
  cleanup();
  current?.dispose();
  current = null;
  vi.useRealTimers();
});

export function mock(opts: MockOptions = {}): MockControl {
  current?.dispose();
  current = installMock({ idleTimer: false, state: 'unlocked', ...opts });
  useUi.setState({ settings: structuredClone(current.db.settings) });
  return current;
}

function wrap(el: ReactElement): RenderResult {
  return render(
    <I18nextProvider i18n={i18n}>
      <MantineProvider theme={theme}>{el}</MantineProvider>
    </I18nextProvider>,
  );
}

/** Render a single screen (with the toast host the shell would normally provide). */
export function ui(el: ReactElement): RenderResult {
  return wrap(
    <>
      {el}
      <ToastHost />
    </>,
  );
}

export function app(opts: MockOptions = {}): {
  ctl: MockControl;
  user: ReturnType<typeof userEvent.setup>;
  view: RenderResult;
} {
  const ctl = mock(opts);
  const user = userEvent.setup();
  const view = wrap(<App />);
  return { ctl, user, view };
}

export const PASSWORD = 'correct horse battery staple';
