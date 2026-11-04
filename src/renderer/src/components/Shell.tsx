import {
  AppShell,
  Badge,
  Button,
  Group,
  Menu,
  Modal,
  NavLink,
  Text,
  TextInput,
  Title,
  useMantineColorScheme,
} from '@mantine/core';
import { Component, useEffect, useRef, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useAction, vss } from '../lib/api';
import { navigate, useRoute } from '../lib/router';
import { AuditScreen } from '../screens/AuditScreen';
import { DashboardScreen } from '../screens/DashboardScreen';
import { PeopleScreen } from '../screens/people/PeopleScreen';
import { PersonDetailScreen } from '../screens/people/PersonDetailScreen';
import { RequestDetailScreen } from '../screens/RequestDetailScreen';
import { ImportRequestScreen } from '../screens/ImportRequestScreen';
import { ManualRequestScreen } from '../screens/ManualRequestScreen';
import { RequestsScreen } from '../screens/RequestsScreen';
import { ImportResponseScreen, ResponsesScreen } from '../screens/ResponsesScreens';
import { ReviewDetailScreen } from '../screens/review/ReviewDetailScreen';
import { ReviewScreen } from '../screens/review/ReviewListScreen';
import { SearchScreen } from '../screens/SearchScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { UnitDetailScreen, UnitsScreen } from '../screens/UnitsScreens';
import { useUi } from '../store';
import { AlphaBanner } from './AlphaBanner';
import { AboutBody } from './settings/AboutCard';
import { ToastHost } from './ToastHost';

export class ErrorBoundary extends Component<{ children: ReactNode; label: string }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(_e: Error, _info: ErrorInfo): void {
    // Deliberately not logged with component data: error text may contain personal data.
  }
  override render() {
    if (this.state.error) {
      return (
        <div role="alert">
          <Title order={2} size="h3">
            {this.props.label}
          </Title>
          <Button mt="md" onClick={() => this.setState({ error: null })}>
            Retry
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

const NAV: { path: string; key: string }[] = [
  { path: '/', key: 'nav.dashboard' },
  { path: '/requests', key: 'nav.requests' },
  { path: '/responses', key: 'nav.responses' },
  { path: '/people', key: 'nav.people' },
  { path: '/units', key: 'nav.units' },
  { path: '/review', key: 'nav.review' },
  { path: '/search', key: 'nav.search' },
  { path: '/settings', key: 'nav.settings' },
  { path: '/audit', key: 'nav.audit' },
];

function NetworkIndicator() {
  const { t } = useTranslation();
  const update = useUi((s) => s.update);
  const peer = useUi((s) => s.peer);
  let label = t('network.offline');
  let color = 'gray';
  if (update && ['checking', 'downloading', 'verifying'].includes(update.phase)) {
    label = t('network.updating');
    color = 'yellow';
  } else if (peer?.listening) {
    label = t('network.peer');
    color = 'yellow';
  }
  return (
    <Badge color={color} variant="light" data-testid="network-status" aria-label={t('network.label', { state: label })}>
      {label}
    </Badge>
  );
}

function ThemeToggle() {
  const { t } = useTranslation();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const next = colorScheme === 'light' ? 'dark' : colorScheme === 'dark' ? 'auto' : 'light';
  return (
    <Button
      size="xs"
      variant="subtle"
      onClick={() => setColorScheme(next)}
      aria-label={t('topbar.themeSwitch', { current: t(`theme.${colorScheme}`), next: t(`theme.${next}`) })}
    >
      {t(`theme.${colorScheme}`)}
    </Button>
  );
}

function HelpMenu() {
  const { t } = useTranslation();
  const act = useAction();
  const [about, setAbout] = useState(false);
  return (
    <>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <Button size="xs" variant="subtle" aria-label={t('alpha.helpMenu')}>
            {t('alpha.helpMenu')}
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item onClick={() => setAbout(true)}>{t('alpha.aboutItem')}</Menu.Item>
          <Menu.Item onClick={() => void act(vss().app.openFeedback(), t('alpha.feedbackOpened'))}>
            {t('alpha.feedbackLink')}
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
      <Modal opened={about} onClose={() => setAbout(false)} title={t('alpha.aboutTitle')} trapFocus returnFocus>
        <AboutBody />
      </Modal>
    </>
  );
}

function LockWarning() {
  const { t } = useTranslation();
  const secs = useUi((s) => s.lockWarning);
  const setWarn = useUi((s) => s.setLockWarning);
  return (
    <Modal
      opened={secs !== null}
      onClose={() => {
        setWarn(null);
        void vss().vault.touch();
      }}
      title={t('lock.warningTitle')}
      trapFocus
      returnFocus
    >
      <Text role="status" aria-live="polite">
        {t('lock.warningBody', { count: secs ?? 0 })}
      </Text>
      <Group mt="md" justify="flex-end">
        <Button
          data-autofocus
          onClick={() => {
            setWarn(null);
            void vss().vault.touch();
          }}
        >
          {t('lock.stay')}
        </Button>
        <Button variant="default" onClick={() => void vss().vault.lock()}>
          {t('lock.lockNow')}
        </Button>
      </Group>
    </Modal>
  );
}

function Routes() {
  const route = useRoute();
  const [head, id] = route.segments;
  switch (head) {
    case undefined:
      return <DashboardScreen />;
    case 'requests':
      if (id === 'import') return <ImportRequestScreen />;
      if (id === 'new') return <ManualRequestScreen />;
      return id ? <RequestDetailScreen id={id} /> : <RequestsScreen />;
    case 'responses':
      return id === 'import' ? (
        <ImportResponseScreen requestId={route.query.get('requestId') ?? undefined} />
      ) : (
        <ResponsesScreen />
      );
    case 'people':
      return id ? <PersonDetailScreen id={id} /> : <PeopleScreen />;
    case 'units':
      return id ? <UnitDetailScreen id={id} /> : <UnitsScreen />;
    case 'review':
      return id ? <ReviewDetailScreen id={id} /> : <ReviewScreen />;
    case 'search':
      return <SearchScreen initial={route.query.get('q') ?? ''} />;
    case 'settings':
      return <SettingsScreen />;
    case 'audit':
      return <AuditScreen />;
    default:
      return <DashboardScreen />;
  }
}

/** The unlocked application. Remounted (key = epoch) on every unlock so no data survives a lock. */
export function Shell() {
  const { t } = useTranslation();
  const route = useRoute();
  const epoch = useUi((s) => s.epoch);
  const reviewOpen = useUi((s) => s.reviewOpen);
  const setSettings = useUi((s) => s.setSettings);
  const [q, setQ] = useState('');
  const lastTouch = useRef(0);

  useEffect(() => {
    const api = vss();
    void api.settings.get().then((r) => r.ok && setSettings(r.value));
    void api.review.counts().then((r) => r.ok && useUi.getState().setReviewOpen(r.value.open));
    void api.updates.state().then((r) => r.ok && useUi.getState().setUpdate(r.value));
    void api.peer.status().then((r) => r.ok && useUi.getState().setPeer(r.value));
  }, [epoch, setSettings]);

  useEffect(() => {
    const activity = () => {
      const now = Date.now();
      if (now - lastTouch.current > 5000) {
        lastTouch.current = now;
        void vss().vault.touch();
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        void vss().vault.lock();
        return;
      }
      activity();
    };
    window.addEventListener('keydown', key);
    window.addEventListener('pointerdown', activity);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('pointerdown', activity);
    };
  }, []);

  const isActive = (p: string) => (p === '/' ? route.path === '/' : route.path === p || route.path.startsWith(`${p}/`));

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 220, breakpoint: 'sm' }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Title order={4}>{t('app.title')}</Title>
          <form
            role="search"
            aria-label={t('topbar.searchLandmark')}
            onSubmit={(e) => {
              e.preventDefault();
              navigate(`/search?q=${encodeURIComponent(q)}`);
            }}
          >
            <TextInput
              aria-label={t('topbar.search')}
              placeholder={t('topbar.search')}
              value={q}
              onChange={(e) => setQ(e.currentTarget.value)}
              size="xs"
              w={260}
            />
          </form>
          <Group gap="sm">
            <NetworkIndicator />
            <ThemeToggle />
            <HelpMenu />
            <Button size="xs" variant="default" onClick={() => void vss().vault.lock()} aria-keyshortcuts="Control+L">
              {t('topbar.lock')}
            </Button>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs" component="nav" aria-label={t('nav.label')}>
        {NAV.map((n) => (
          <NavLink
            key={n.path}
            component="a"
            href={`#${n.path}`}
            label={t(n.key)}
            variant="filled"
            active={isActive(n.path)}
            aria-current={isActive(n.path) ? 'page' : undefined}
            rightSection={
              n.path === '/review' && reviewOpen > 0 ? (
                <Badge
                  size="sm"
                  color="red"
                  variant="filled"
                  circle
                  aria-label={t('nav.reviewOpen', { count: reviewOpen })}
                  data-testid="review-badge"
                >
                  {reviewOpen}
                </Badge>
              ) : null
            }
          />
        ))}
      </AppShell.Navbar>
      <AppShell.Main id="main" key={epoch}>
        <AlphaBanner />
        <ErrorBoundary label={t('common.crashed')}>
          <Routes />
        </ErrorBoundary>
      </AppShell.Main>
      <LockWarning />
      <ToastHost />
    </AppShell>
  );
}
