import '@mantine/core/styles.css';
import './styles.css';
import { MantineProvider } from '@mantine/core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { App } from './App';
import { theme } from './theme';
import { i18n } from './i18n';

async function boot(): Promise<void> {
  // Development only: `?mock=1` swaps the preload bridge for the in-memory mock. The whole branch (and the dynamic
  // import) is removed from production builds because import.meta.env.DEV is statically false there.
  if (import.meta.env.DEV) {
    const q = new URLSearchParams(window.location.search);
    if (q.get('mock') === '1') {
      const { installMock } = await import('./mock/install');
      const state = q.get('state');
      installMock({
        state: state === 'locked' || state === 'unlocked' ? state : 'no-vault',
        seed: q.get('seed') !== '0',
      });
    }
  }
  const nonce = document.querySelector('meta[name="csp-nonce"]')?.getAttribute('content') ?? undefined;
  const container = document.getElementById('root');
  if (!container) throw new Error('root element missing');
  createRoot(container).render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <MantineProvider theme={theme} defaultColorScheme="auto" getStyleNonce={() => nonce ?? ''}>
          <App />
        </MantineProvider>
      </I18nextProvider>
    </StrictMode>,
  );
}

void boot();
