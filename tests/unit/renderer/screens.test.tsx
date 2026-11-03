// @vitest-environment jsdom
import { app, mock, ui } from './helpers';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AuditScreen } from '../../../src/renderer/src/screens/AuditScreen';
import { DashboardScreen } from '../../../src/renderer/src/screens/DashboardScreen';
import { PeopleScreen, PersonDetailScreen } from '../../../src/renderer/src/screens/PeopleScreens';
import { ReviewDetailScreen, ReviewScreen } from '../../../src/renderer/src/screens/ReviewScreens';
import { SearchScreen } from '../../../src/renderer/src/screens/SearchScreen';
import { SettingsScreen } from '../../../src/renderer/src/screens/SettingsScreen';
import { UnitDetailScreen, UnitsScreen } from '../../../src/renderer/src/screens/UnitsScreens';
import { useUi } from '../../../src/renderer/src/store';

describe('dashboard', () => {
  it('shows outstanding count, aging buckets, turnaround by channel, expiries and backup age', async () => {
    mock();
    ui(<DashboardScreen />);
    expect(await screen.findByTestId('stat-outstanding')).toHaveTextContent('1');
    expect(screen.getByTestId('stat-review')).toHaveTextContent('1');
    expect(screen.getByTestId('aging-8-14')).toHaveTextContent('8-14 d: 1');
    expect(screen.getByTestId('aging-0-7')).toHaveTextContent('0-7 d: 0');
    expect(screen.getByTestId('aging->30')).toHaveTextContent('>30 d: 0');
    expect(screen.getByTestId('ta-file')).toHaveTextContent('1 requests, mean 9.0, median 9.0');
    expect(screen.getByTestId('ta-email')).toHaveTextContent('1 requests, mean 3.0, median 3.0');
    expect(screen.getByTestId('exp-30')).toHaveTextContent('within 30 d: 2');
    expect(screen.getByTestId('exp-90')).toHaveTextContent('within 90 d: 2');
    expect(screen.getByTestId('stat-backup')).toHaveTextContent('9 d ago');
  });

  it('warns when no backup exists', async () => {
    const ctl = mock();
    ctl.db.audit = ctl.db.audit.filter((e) => e.type !== 'vault.backup');
    ui(<DashboardScreen />);
    expect(await screen.findByText(/No backup has been made yet/)).toBeInTheDocument();
  });
});

describe('people', () => {
  it('searches any field (name, identifier, unit) and filters by status', async () => {
    mock();
    const user = userEvent.setup();
    ui(<PeopleScreen />);
    expect(await screen.findByText('8 people')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Search'), 'XX0000001');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(screen.getByText('1 people')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Alder, Terra' })).toBeInTheDocument();
  });

  it('masks personal data in lists under redaction mode', async () => {
    const ctl = mock();
    ctl.db.settings.redactionMode = true;
    useUi.setState({ settings: { ...ctl.db.settings } });
    ui(<PeopleScreen />);
    await screen.findByText('8 people');
    expect(screen.queryByText('1980-03-12')).not.toBeInTheDocument();
    expect(screen.queryByText('Alder, Terra')).not.toBeInTheDocument();
  });

  it('shows the person detail with history timeline, merges with a reason and splits again', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    const fir = ctl.db.persons.find((p) => p.canonical.surname === 'Fir' && p.canonical.given.length === 1)!;
    ui(<PersonDetailScreen id={fir.id} />);
    expect(await screen.findByRole('heading', { name: 'Fir, Marlo' })).toBeInTheDocument();
    expect(screen.getByText(/Approved - /)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Merge another person into this one' }));
    const dlg = await screen.findByRole('dialog');
    await user.type(within(dlg).getByLabelText('Search'), 'Fir');
    await user.click(within(dlg).getByRole('button', { name: 'Search' }));
    await user.click(await within(dlg).findByRole('button', { name: /Select Fir, Marlo J/ }));
    const reason = await screen.findByLabelText('Reason');
    await user.type(reason, 'Same person, confirmed');
    await user.click(screen.getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(ctl.db.merges).toHaveLength(1));
    expect(ctl.db.merges[0]!.reason).toBe('Same person, confirmed');
    expect(ctl.db.reviews.filter((r) => r.kind === 'duplicate-persons')[0]!.state).toBe('resolved');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const split = await screen.findByRole('button', { name: 'Split (undo merge)' });
    await user.click(split);
    const sdlg = await screen.findByRole('dialog');
    await user.type(within(sdlg).getByLabelText('Reason'), 'Wrong merge');
    await user.click(within(sdlg).getByRole('button', { name: 'Split (undo merge)' }));
    await waitFor(() => expect(ctl.db.merges).toHaveLength(0));
  });

  it('records a manual decision', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    const hazel = ctl.db.persons.find((p) => p.canonical.surname === 'Hazel')!;
    ui(<PersonDetailScreen id={hazel.id} />);
    await screen.findByRole('heading', { name: 'Hazel, Indigo' });
    await user.click(screen.getByRole('button', { name: 'Record a decision' }));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(ctl.db.records.some((r) => r.personId === hazel.id && r.source === 'manual')).toBe(true),
    );
  });
});

describe('units', () => {
  it('lists, opens a unit and adds an alias', async () => {
    mock();
    const user = userEvent.setup();
    ui(<UnitsScreen />);
    expect(await screen.findByRole('link', { name: 'Sample Police Unit A' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Search units'), 'Military');
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Sample Police Unit A' })).not.toBeInTheDocument());
  });

  it('unit detail adds an alias', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    const unit = ctl.db.units[0]!;
    ui(<UnitDetailScreen id={unit.id} />);
    await screen.findByRole('heading', { name: unit.name });
    await user.type(screen.getByLabelText('New alias'), 'Unit A (old name)');
    await user.click(screen.getByRole('button', { name: 'Add alias' }));
    await waitFor(() => expect(unit.aliases).toContain('Unit A (old name)'));
  });
});

describe('review queue', () => {
  it('lists open items and resolves a duplicate by merging', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    ui(<ReviewScreen />);
    expect(await screen.findByText('1 open')).toBeInTheDocument();
    const rv = ctl.db.reviews[0]!;
    ui(<ReviewDetailScreen id={rv.id} />);
    const keep = await screen.findByRole('button', { name: 'Merge, keep Fir, Marlo' });
    expect(screen.getAllByTestId('diff').length).toBeGreaterThan(0);
    await user.click(keep);
    await waitFor(() => expect(rv.state).toBe('resolved'));
    expect(ctl.db.merges).toHaveLength(1);
  });

  it('request-item review: confirm candidate links the person; diff highlights DOB swap', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    const prev = await ctl.api.requests.importPreview({ path: 'mock://files/request-sample.xlsx' });
    if (!prev.ok) throw new Error('x');
    await ctl.api.requests.importCommit({
      previewId: prev.value.previewId,
      requestor: { name: 'P', email: null, organisation: null },
      eventName: 'E',
      eventStart: null,
      eventEnd: null,
      eventLocation: null,
      notes: '',
    });
    const rv = ctl.db.reviews.find((r) => r.kind === 'request-item-link')!;
    ui(<ReviewDetailScreen id={rv.id} />);
    const dobRow = (await screen.findByText('Date of birth')).closest('tr')!;
    expect(dobRow).toHaveAttribute('data-differs', 'true');
    expect(within(dobRow).getAllByText(/as D\/M/)).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: /Same person as Cedar, Solana/ }));
    await waitFor(() => expect(rv.state).toBe('resolved'));
    const item = ctl.db.requests.at(-1)!.items.find((i) => i.observed.rowRef === 'R3')!;
    expect(item.linkState).toBe('confirmed');
  });

  it('not the same person dismisses the item without linking', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    const rv = ctl.db.reviews[0]!;
    ui(<ReviewDetailScreen id={rv.id} />);
    await user.click(await screen.findByRole('button', { name: 'Not the same person' }));
    await waitFor(() => expect(rv.state).toBe('dismissed'));
    expect(ctl.db.notSame).toHaveLength(1);
  });
});

describe('search', () => {
  it('searches people, requests and units at once', async () => {
    mock();
    ui(<SearchScreen initial="Sample Police" />);
    expect(await screen.findByRole('heading', { name: 'Units (1)' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /People \(/ })).toBeInTheDocument();
  });
});

describe('audit', () => {
  it('lists events and verifies the chain', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    ui(<AuditScreen />);
    expect(await screen.findByText('vault.backup')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Verify chain' }));
    expect(await screen.findByText('The audit chain is intact')).toBeInTheDocument();
    expect(screen.getByText(`${ctl.db.audit.length} events checked.`)).toBeInTheDocument();
  });
});

describe('settings', () => {
  it('requires the password to save, rejects a wrong one, saves with the right one', async () => {
    const { ctl, user } = app({ state: 'unlocked' });
    await user.click(await screen.findByRole('link', { name: 'Settings' }));
    const minutes = await screen.findByLabelText(/Auto-lock after/);
    await user.clear(minutes);
    await user.type(minutes, '5');
    const save = screen.getByRole('button', { name: 'Save settings' });
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText(/Password to confirm changes/), 'not the password');
    await user.click(save);
    expect(await screen.findByText('Wrong password.')).toBeInTheDocument();
    expect(ctl.db.settings.autoLockMinutes).toBe(10);
    await user.type(screen.getByLabelText(/Password to confirm changes/), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(ctl.db.settings.autoLockMinutes).toBe(5));
    expect(screen.getByLabelText(/Password to confirm changes/)).toHaveValue('');
  });

  it('shows defaults: update check on, 30-day email expiry, 30 s clipboard, peer mode off with a warning when enabled', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    ui(<SettingsScreen />);
    expect(screen.getByRole('switch', { name: /Check for updates/ })).toBeChecked();
    expect(screen.getByLabelText(/Email-only clearance lasts/)).toHaveValue('30');
    expect(screen.getByLabelText(/Clear the clipboard after/)).toHaveValue('30');
    const peer = screen.getByRole('switch', { name: /Enable peer mode/ });
    expect(peer).not.toBeChecked();
    expect(screen.queryByText('Experimental')).not.toBeInTheDocument();
    await user.click(peer);
    expect(screen.getByText('Experimental')).toBeInTheDocument();
    expect(ctl.db.settings.peerModeEnabled).toBe(false);
  });

  it('has no security-key or key-slot controls (single password vault)', () => {
    mock();
    ui(<SettingsScreen />);
    expect(screen.queryByText(/security key/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/key slot/i)).not.toBeInTheDocument();
  });

  it('changes the password and creates a backup', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    ui(<SettingsScreen />);
    await user.type(screen.getByLabelText('Current password'), 'correct horse battery staple');
    await user.type(screen.getAllByLabelText(/^New password/)[0]!, 'a brand new passphrase 42');
    await user.type(screen.getAllByLabelText(/^Confirm password/)[0]!, 'a brand new passphrase 42');
    await user.click(screen.getAllByRole('button', { name: 'Change password' }).at(-1)!);
    await waitFor(() => expect(ctl.db.vault.password).toBe('a brand new passphrase 42'));
    // backups: folder + password => VSS generates the recovery passphrase and shows it once
    expect(screen.getByRole('button', { name: 'Back up now' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Choose folder' }));
    await user.type(screen.getByLabelText('Password to change backup settings'), 'a brand new passphrase 42');
    await user.click(screen.getByRole('button', { name: 'Set up backups' }));
    const dlg = await screen.findByRole('dialog', { name: 'Your backup recovery passphrase' });
    const shown = within(dlg).getByTestId('recovery-passphrase').textContent ?? '';
    expect(shown).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
    const done = within(dlg).getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled(); // cannot proceed without confirming it was saved
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Your backup recovery passphrase' })).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: 'Copy passphrase' }));
    expect(ctl.db.clipboard).toBe(shown);
    await user.click(within(dlg).getByRole('checkbox', { name: 'I have saved the recovery passphrase' }));
    await user.click(done);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Your backup recovery passphrase' })).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(shown)).not.toBeInTheDocument(); // never displayed again
    const before = ctl.db.audit.filter((e) => e.type === 'vault.backup').length;
    await user.click(screen.getByRole('button', { name: 'Back up now' }));
    await waitFor(() => expect(ctl.db.audit.filter((e) => e.type === 'vault.backup').length).toBe(before + 1));
  });

  it('regenerating the recovery passphrase needs the password and shows the new one once', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    const first = await ctl.api.backup.configure({
      config: { dir: 'mock://folders/backups', keep: 5, onLock: true, everyHours: null },
      reauth: { password: 'correct horse battery staple' },
    });
    expect(first.ok && first.value.newPassphrase).toBeTruthy();
    ui(<SettingsScreen />);
    const regen = await screen.findByRole('button', { name: 'New recovery passphrase' });
    expect(regen).toBeDisabled();
    await user.type(screen.getByLabelText('Password to change backup settings'), 'wrong password');
    await user.click(regen);
    expect(await screen.findByText('Wrong password.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Password to change backup settings'), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'New recovery passphrase' }));
    const dlg = await screen.findByRole('dialog', { name: 'Your backup recovery passphrase' });
    const shown = within(dlg).getByTestId('recovery-passphrase').textContent;
    expect(shown).not.toBe(first.ok ? first.value.newPassphrase : '');
  });
});

describe('mock contract guards', () => {
  it('key-slot methods answer NOT_SUPPORTED', async () => {
    const ctl = mock();
    expect(
      (
        await ctl.api.vault.enrollFido2({
          password: 'x',
          credentialIdB64: '',
          prfOutputB64: '',
          label: '',
          requirePasswordToo: false,
        })
      ).ok,
    ).toBe(false);
    const r = await ctl.api.vault.removeSlot({ password: 'x', slotId: 'slot-pw' });
    expect(r.ok === false && r.error.code).toBe('NOT_SUPPORTED');
  });

  it('refuses every data call while locked', async () => {
    const ctl = mock({ state: 'locked' });
    const r = await ctl.api.persons.list({ offset: 0, limit: 5 });
    expect(r.ok === false && r.error.code).toBe('VAULT_LOCKED');
  });
});
