// @vitest-environment jsdom
import { app, mock, PASSWORD, ui } from './helpers';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CreateVaultScreen, passwordScore } from '../../../src/renderer/src/screens/CreateVaultScreen';
import { App } from '../../../src/renderer/src/App';
import { ErrorBoundary, Shell } from '../../../src/renderer/src/components/Shell';
import { useUi } from '../../../src/renderer/src/store';

describe('create vault', () => {
  it('shows password guidance and keeps Create disabled until valid and confirmed', async () => {
    const { user } = app({ state: 'no-vault' });
    expect(await screen.findByRole('heading', { name: 'Create your vault' })).toBeInTheDocument();
    expect(screen.getByText(/Use at least 12 characters/)).toBeInTheDocument();
    const create = screen.getByRole('button', { name: 'Create vault' });
    expect(create).toBeDisabled();
    await user.type(screen.getByLabelText(/^Your name/), 'Test User');
    await user.type(screen.getAllByLabelText(/^Password/)[0]!, PASSWORD);
    await user.type(screen.getByLabelText(/^Confirm password/), 'different password!');
    expect(screen.getByText('The passwords do not match.')).toBeInTheDocument();
    expect(create).toBeDisabled();
  });

  it('creates the vault and opens the application shell', async () => {
    const { user } = app({ state: 'no-vault' });
    await screen.findByRole('heading', { name: 'Create your vault' });
    await user.type(screen.getByLabelText(/^Your name/), 'Test User');
    await user.type(screen.getAllByLabelText(/^Password/)[0]!, PASSWORD);
    await user.type(screen.getByLabelText(/^Confirm password/), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Create vault' }));
    expect(await screen.findByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
  });

  it('scores passphrases higher than short passwords', () => {
    expect(passwordScore('short')).toBe(0);
    expect(passwordScore('correct horse battery staple')).toBeGreaterThanOrEqual(3);
  });

  it('is rendered standalone without crashing', () => {
    mock({ state: 'no-vault' });
    ui(<CreateVaultScreen />);
    expect(screen.getByRole('main')).toBeInTheDocument();
  });
});

describe('unlock and lock', () => {
  it('rejects a wrong password, then unlocks and clears the password field', async () => {
    const { user } = app({ state: 'locked' });
    const field = await screen.findByLabelText(/^Password/);
    await user.type(field, 'wrong password here');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByText('Wrong password.')).toBeInTheDocument();
    expect(await screen.findByText('Failed attempts: 1')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Password/)).toHaveValue('');
    await user.type(screen.getByLabelText(/^Password/), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
  });

  it('offers no security-key option (single password vault)', async () => {
    app({ state: 'locked' });
    await screen.findByLabelText(/^Password/);
    expect(screen.queryByText(/security key/i)).not.toBeInTheDocument();
  });

  it('locking unmounts all data views and shows the unlock screen', async () => {
    const { ctl, user } = app({ state: 'unlocked' });
    expect(await screen.findByTestId('stat-outstanding')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Lock/ }));
    expect(await screen.findByRole('heading', { name: 'Unlock' })).toBeInTheDocument();
    expect(screen.queryByTestId('stat-outstanding')).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).not.toBeInTheDocument();
    expect(window.location.hash).toBe('#/lock');
    expect(ctl.db.vault.locked).toBe(true);
    expect(useUi.getState().reviewOpen).toBe(0);
  });

  it('Ctrl+L locks the vault', async () => {
    const { ctl, user } = app({ state: 'unlocked' });
    await screen.findByTestId('stat-outstanding');
    await user.keyboard('{Control>}l{/Control}');
    await waitFor(() => expect(ctl.db.vault.locked).toBe(true));
  });

  it('warns before idle auto-lock and locks at zero', async () => {
    const { ctl, user } = app({ state: 'unlocked' });
    await screen.findByTestId('stat-outstanding');
    ctl.fastForwardIdle(10 * 60 - 20);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/locks automatically in 20 s/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Stay unlocked' }));
    expect(ctl.db.vault.locked).toBe(false);
    ctl.fastForwardIdle(10 * 60);
    expect(await screen.findByRole('heading', { name: 'Unlock' })).toBeInTheDocument();
  });
});

describe('vault routes (#/create, #/unlock, #/lock)', () => {
  it('main can open the app on any vault route; the state decides the screen and the hash follows', async () => {
    window.location.hash = '#/unlock';
    app({ state: 'unlocked' });
    expect(await screen.findByTestId('stat-outstanding')).toBeInTheDocument();
    await waitFor(() => expect(window.location.hash).toBe('#/'));
  });

  it('no vault => #/create', async () => {
    window.location.hash = '#/requests';
    app({ state: 'no-vault' });
    expect(await screen.findByRole('heading', { name: 'Create your vault' })).toBeInTheDocument();
    await waitFor(() => expect(window.location.hash).toBe('#/create'));
  });

  it('locked on #/unlock shows the unlock screen and stays on a vault route', async () => {
    window.location.hash = '#/unlock';
    app({ state: 'locked' });
    expect(await screen.findByRole('heading', { name: 'Unlock' })).toBeInTheDocument();
    expect(['#/unlock', '#/lock']).toContain(window.location.hash);
  });
});

describe('shell', () => {
  it('shows Offline, all nav entries and the review badge', async () => {
    app({ state: 'unlocked' });
    expect(await screen.findByTestId('network-status')).toHaveTextContent('Offline');
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    for (const name of [
      'Dashboard',
      'Requests',
      'Responses',
      'People',
      'Units',
      'Review queue',
      'Search',
      'Settings',
      'Audit',
    ]) {
      expect(within(nav).getByRole('link', { name: new RegExp(name) })).toBeInTheDocument();
    }
    expect(await screen.findByTestId('review-badge')).toHaveTextContent('1');
  });

  it('shows an alert for a missing record instead of crashing', async () => {
    mock();
    window.location.hash = '#/people/NOPE';
    ui(<Shell />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Person not found.');
  });

  it('contains a crashing child with the error boundary', () => {
    const orig = console.error;
    console.error = () => undefined;
    const Boom = (): never => {
      throw new Error('boom');
    };
    try {
      ui(
        <ErrorBoundary label="Something went wrong on this screen.">
          <Boom />
        </ErrorBoundary>,
      );
      expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
    } finally {
      console.error = orig;
    }
  });
});

describe('backend unavailable', () => {
  it('shows the title and an alert instead of spinning forever when vault.status fails', async () => {
    const ctl = mock({ state: 'unlocked' });
    ctl.api.vault.status = () =>
      Promise.resolve({ ok: false, error: { code: 'NOT_SUPPORTED', message: 'vss:vault.status is not implemented' } });
    ui(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('vss:vault.status is not implemented');
    expect(screen.getByTestId('shell')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Vetting Support System');
  });
});
