import { Alert, Center, Loader, Stack, Title } from '@mantine/core';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { i18n } from './i18n';
import { vss } from './lib/api';
import { navigate, parseHash, useRoute } from './lib/router';
import { ToastHost } from './components/ToastHost';
import { Shell } from './components/Shell';
import { CreateVaultScreen } from './screens/CreateVaultScreen';
import { UnlockScreen } from './screens/UnlockScreen';
import { useUi } from './store';

/** Vault routes the main process navigates to (`#/create`, `#/unlock`, `#/lock`); the data views use the rest. */
const VAULT_ROUTES = ['/create', '/unlock', '/lock'] as const;

/** Wires main-process events into the store. Mounted once, outside the data views. */
function useBootstrap(): void {
  useEffect(() => {
    const ui = useUi.getState;
    const api = vss();
    void api.vault.status().then((r) => {
      if (r.ok) {
        ui().setBootError(null);
        ui().setVault(r.value);
        if (
          r.value.state === 'locked' &&
          !(VAULT_ROUTES as readonly string[]).includes(parseHash(window.location.hash).path)
        )
          navigate('/lock');
      } else {
        ui().setBootError(r.error.message);
      }
    });
    const offs = [
      api.on('vault:locked', () => {
        ui().clearData();
        void api.vault.status().then((r) => r.ok && ui().setVault(r.value));
        navigate('/lock');
      }),
      api.on('vault:unlocked', (s) => {
        ui().setVault(s);
        if ((VAULT_ROUTES as readonly string[]).includes(parseHash(window.location.hash).path)) navigate('/');
      }),
      api.on('vault:lock-warning', (w) => ui().setLockWarning(w.secondsRemaining)),
      api.on('review:counts', (c) => ui().setReviewOpen(c.open)),
      api.on('updates:state', (u) => ui().setUpdate(u)),
      api.on('peer:status', (p) => ui().setPeer(p)),
      api.on('clipboard:cleared', () => ui().pushToast({ kind: 'info', message: i18n.t('clipboard.cleared') })),
    ];
    return () => offs.forEach((off) => off());
  }, []);
}

/** Keeps the hash in line with the vault state: the vault screens own #/create, #/unlock and #/lock. */
function useVaultRoute(state: 'no-vault' | 'locked' | 'unlocked' | null): void {
  const route = useRoute();
  useEffect(() => {
    // Exposed for tests and assistive tooling: which vault screen is showing (no data, just the state).
    document.documentElement.dataset['vaultState'] = state ?? 'booting';
    if (state === null) return;
    const onVaultRoute = (VAULT_ROUTES as readonly string[]).includes(route.path);
    if (state === 'unlocked' && onVaultRoute) navigate('/');
    else if (state === 'no-vault' && route.path !== '/create') navigate('/create');
    else if (state === 'locked' && !onVaultRoute) navigate('/lock');
  }, [state, route.path]);
}

export function App() {
  const { t } = useTranslation();
  const state = useUi((s) => s.vault?.state ?? null);
  const bootError = useUi((s) => s.bootError);
  useBootstrap();
  useVaultRoute(state);
  if (state === null) {
    return (
      <Center h="100vh" data-testid="shell">
        <Stack align="center">
          <Title order={1}>{t('app.title')}</Title>
          {bootError ? (
            <Alert color="red" role="alert" title={t('boot.failed')}>
              {bootError}
            </Alert>
          ) : (
            <Loader aria-label={t('common.loading')} />
          )}
        </Stack>
      </Center>
    );
  }
  if (state === 'no-vault')
    return (
      <>
        <CreateVaultScreen />
        <ToastHost />
      </>
    ); // the host is needed here for the one-time "database was deleted" toast (lane L)
  if (state === 'locked') return <UnlockScreen />;
  return <Shell />;
}
