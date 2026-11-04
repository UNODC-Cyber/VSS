// @vitest-environment jsdom
import { mock, ui } from './helpers';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Shell } from '../../../src/renderer/src/components/Shell';
import { SettingsScreen } from '../../../src/renderer/src/screens/SettingsScreen';
import { useUi } from '../../../src/renderer/src/store';

function setChannel(channel: string | null): void {
  window.history.replaceState(null, '', channel ? `/?channel=${channel}` : '/');
}
afterEach(() => setChannel(null));

describe('alpha channel UI (R9)', { timeout: 60_000 }, () => {
  it('alpha: banner with the version, dismissible, feedback link; Help has About and Send feedback', async () => {
    setChannel('alpha');
    const ctl = mock();
    const user = userEvent.setup();
    ui(<Shell />);
    const banner = await screen.findByTestId('alpha-banner');
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner).toHaveTextContent(
      'Alpha build 0.2.0-alpha.1: for testing with synthetic data; no automatic updates',
    );
    await user.click(screen.getByRole('button', { name: 'Help' }));
    await user.click(await screen.findByRole('menuitem', { name: 'About VSS' }));
    const about = await screen.findByTestId('about-body');
    expect(about).toHaveTextContent('0.2.0-alpha.1');
    expect(about).toHaveTextContent('Alpha (testing)');
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Dismiss the alpha notice' }));
    await waitFor(() => expect(screen.queryByTestId('alpha-banner')).not.toBeInTheDocument());
    ctl.dispose();
  });

  it('alpha: Settings has no Updates card or update toggle, only the disabled note', async () => {
    setChannel('alpha');
    mock();
    ui(<SettingsScreen />);
    expect(await screen.findByTestId('updates-alpha-note')).toHaveTextContent('Updates are disabled in alpha builds');
    expect(screen.queryByRole('button', { name: 'Check now' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /update/i })).not.toBeInTheDocument();
    expect(await screen.findByTestId('about-version')).toHaveTextContent('0.2.0-alpha.1');
  });

  it('a failed update check is explained in plain words, never a bare "error" (R2O-08)', async () => {
    mock();
    useUi.setState({
      update: {
        phase: 'error',
        currentVersion: '0.2.0',
        availableVersion: null,
        releaseNotes: null,
        downloadedBytes: 0,
        totalBytes: null,
        checkedAt: null,
        message: 'net::ERR_NAME_NOT_RESOLVED',
      } as never,
    });
    ui(<SettingsScreen />);
    const state = await screen.findByTestId('updates-state');
    expect(state).toHaveTextContent('Version 0.2.0: could not check for updates');
    expect(state).not.toHaveTextContent(/: error/);
    expect(screen.getByTestId('updates-help')).toHaveTextContent('could not reach the update server');
    expect(document.body).not.toHaveTextContent('ERR_NAME_NOT_RESOLVED');
  });

  it('settings state the network use accurately: updates and peer mode (R3O-07)', async () => {
    mock();
    ui(<SettingsScreen />);
    expect(await screen.findByText(/The only other network feature, peer mode/)).toBeInTheDocument();
    expect(screen.queryByText(/The only feature that uses the network/)).not.toBeInTheDocument();
    expect(screen.getByText(/Peer mode is meant to connect to other computers running VSS/)).toBeInTheDocument();
  });

  it('dev: no banner and the Updates card is there', async () => {
    mock();
    ui(<Shell />);
    expect(await screen.findByRole('button', { name: 'Help' })).toBeInTheDocument();
    expect(screen.queryByTestId('alpha-banner')).not.toBeInTheDocument();
  });
});
