// @vitest-environment jsdom
// Lane L (R15): Settings > Danger zone > Delete database, and R16 "Reset window position" (mock backend).
import { app, mock, PASSWORD, ui } from './helpers';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SettingsScreen } from '../../../src/renderer/src/screens/SettingsScreen';
import { useUi } from '../../../src/renderer/src/store';

const PHRASE = 'DELETE DATABASE';

async function openDialog(user: ReturnType<typeof app>['user']) {
  await user.click(await screen.findByRole('button', { name: 'Delete database...' }));
  const dlg = within(await screen.findByRole('dialog', { name: 'Delete database' }));
  return {
    password: dlg.getByLabelText(/^Password to confirm/),
    phrase: dlg.getByLabelText(/^Type DELETE DATABASE to confirm/),
    confirm: dlg.getByRole('button', { name: 'Delete database' }),
  };
}

describe('danger zone card', () => {
  it('is the last Settings card and says what is and is not deleted', async () => {
    mock();
    ui(<SettingsScreen />);
    const card = (await screen.findByText('Danger zone')).closest('#card-danger');
    expect(card).not.toBeNull();
    expect(screen.getByText('What is deleted')).toBeInTheDocument();
    expect(screen.getByText('What is not deleted')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Go to the Backup card' });
    expect(link).toHaveAttribute('href', '#/settings?card=backup');
    const cards = document.querySelectorAll('[id^="card-"]');
    expect(cards[cards.length - 1]).toBe(card);
  });
});

describe('delete database dialog', () => {
  it('keeps Delete disabled until the password is filled and the phrase is exact (case-sensitive)', async () => {
    const { user } = app();
    window.location.hash = '#/settings';
    const { password, phrase, confirm } = await openDialog(user);
    expect(confirm).toBeDisabled();
    await user.type(password, PASSWORD);
    expect(confirm).toBeDisabled();
    await user.type(phrase, 'delete database');
    expect(confirm).toBeDisabled();
    await user.clear(phrase);
    await user.type(phrase, 'DELETE DATABAS');
    expect(confirm).toBeDisabled();
    await user.type(phrase, 'E');
    expect(confirm).toBeEnabled();
    await user.clear(password);
    expect(confirm).toBeDisabled();
  });

  it('shows an error and keeps the dialog open on a wrong password; the vault is untouched', async () => {
    const { user, ctl } = app();
    window.location.hash = '#/settings';
    const { password, phrase, confirm } = await openDialog(user);
    await user.type(password, 'definitely not the password');
    await user.type(phrase, PHRASE);
    await user.click(confirm);
    expect(await screen.findByText('The password is incorrect.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Delete database' })).toBeInTheDocument();
    expect(ctl.db.vault.exists).toBe(true);
    expect(ctl.db.persons.length).toBeGreaterThan(0);
    expect(ctl.db.vault.failed).toBe(1); // counts toward the lockout back-off
  });

  it('shows the lockout message when the back-off applies', async () => {
    const { user, ctl } = app();
    window.location.hash = '#/settings';
    ctl.db.vault.lockedOutUntil = new Date(Date.now() + 60_000).toISOString();
    const { password, phrase, confirm } = await openDialog(user);
    await user.type(password, PASSWORD);
    await user.type(phrase, PHRASE);
    await user.click(confirm);
    expect(await screen.findByText(/Too many failed attempts/)).toBeInTheDocument();
    expect(ctl.db.vault.exists).toBe(true);
  });

  it('Cancel closes without deleting anything', async () => {
    const { user, ctl } = app();
    window.location.hash = '#/settings';
    await openDialog(user);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(ctl.db.vault.exists).toBe(true);
  });

  it('on success returns to the create-vault screen with a one-time toast', async () => {
    const { user, ctl } = app();
    window.location.hash = '#/settings';
    const { password, phrase, confirm } = await openDialog(user);
    await user.type(password, PASSWORD);
    await user.type(phrase, `  ${PHRASE}  `); // surrounding spaces are trimmed
    await user.click(confirm);
    expect(await screen.findByRole('heading', { name: 'Create your vault' })).toBeInTheDocument();
    expect(await screen.findByText('The database was deleted')).toBeInTheDocument();
    expect(ctl.db.vault.exists).toBe(false);
    expect(ctl.db.persons).toHaveLength(0);
    expect(useUi.getState().vault?.state).toBe('no-vault');
    await waitFor(() => expect(window.location.hash).toBe('#/create'));
  });

  it('sends the contract literal after the phrase check and the backups flag only when ticked', async () => {
    const { user } = app();
    const calls: unknown[] = [];
    const orig = window.vss.vault.wipe;
    window.vss.vault.wipe = (req) => {
      calls.push(req);
      return orig(req);
    };
    // A backup folder is configured: the box appears (default off).
    const cfg = { dir: 'C:/synthetic/backups', keep: 3, onLock: false, everyHours: null };
    await window.vss.backup.configure({ config: cfg, reauth: { password: PASSWORD } });
    window.location.hash = '#/settings';
    const { password, phrase, confirm } = await openDialog(user);
    const box = await screen.findByLabelText(/Also delete the automatic backups/);
    expect(box).not.toBeChecked();
    await user.type(password, PASSWORD);
    await user.type(phrase, PHRASE);
    await user.click(box);
    await user.click(confirm);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ password: PASSWORD, confirm: 'WIPE', alsoDeleteScheduledBackups: true });
  });

  it('hides the backups box when no backup folder is configured', async () => {
    const { user } = app();
    window.location.hash = '#/settings';
    await openDialog(user);
    expect(screen.queryByLabelText(/Also delete the automatic backups/)).not.toBeInTheDocument();
  });
});

describe('reset window position', () => {
  it('calls the backend and confirms with a toast', async () => {
    mock();
    const spy = vi.spyOn(window.vss.app, 'resetWindowState');
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    ui(<SettingsScreen />);
    await user.click(await screen.findByRole('button', { name: 'Reset window position' }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Window position reset')).toBeInTheDocument();
  });
});
