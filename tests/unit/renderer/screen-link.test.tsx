// @vitest-environment jsdom
// R14: inline messages that name another screen link to it; Settings honours ?card=<name> (docs/PLAN-ALPHA.md section 6).
import { app, mock, ui } from './helpers';
import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { appendAudit } from '../../../src/renderer/src/mock/db';
import { DashboardScreen } from '../../../src/renderer/src/screens/DashboardScreen';
import { SettingsScreen } from '../../../src/renderer/src/screens/SettingsScreen';

function withoutBackup(ctl: ReturnType<typeof mock>) {
  ctl.db.audit = ctl.db.audit.filter((e) => e.type !== 'vault.backup');
}

describe('dashboard backup warning', () => {
  it('renders "Settings" as a link to the Backup card', async () => {
    withoutBackup(mock());
    ui(<DashboardScreen />);
    const link = await screen.findByRole('link', { name: 'Settings' });
    expect(link).toHaveAttribute('href', '#/settings?card=backup');
    expect(link.closest('[role="status"]')).toHaveTextContent('No backup has been made yet. Make one under Settings.');
  });

  it('an old backup links the same way', async () => {
    const ctl = mock();
    withoutBackup(ctl);
    appendAudit(ctl.db, 'vault.backup', 'vault', null, -40);
    ui(<DashboardScreen />);
    const link = await screen.findByRole('link', { name: 'Settings' });
    expect(link).toHaveAttribute('href', '#/settings?card=backup');
    expect(link.closest('[role="status"]')).toHaveTextContent('The last backup is 40 days old.');
  });
});

describe('Settings card anchor', () => {
  it('scrolls the Backup card into view, focuses its heading and clears the parameter', async () => {
    mock();
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView');
    window.location.hash = '#/settings?card=backup';
    ui(<SettingsScreen />);
    const heading = await screen.findByRole('heading', { name: 'Backup and restore' });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const target = spy.mock.contexts.at(-1) as HTMLElement;
    expect(target.id).toBe('card-backup');
    expect(target).toContainElement(heading);
    expect(heading).toHaveFocus();
    expect(heading).toHaveAttribute('tabindex', '-1');
    await waitFor(() => expect(window.location.hash).toBe('#/settings'));
    spy.mockRestore();
  });

  it('ignores unknown card names without scrolling', async () => {
    mock();
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView');
    window.location.hash = '#/settings?card=nope';
    ui(<SettingsScreen />);
    await screen.findByRole('heading', { name: 'Backup and restore' });
    await waitFor(() => expect(window.location.hash).toBe('#/settings'));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('works from another screen: clicking the dashboard link lands on Settings with the Backup heading focused', async () => {
    const { ctl, user } = app();
    withoutBackup(ctl);
    await act(async () => {
      window.location.hash = '#/';
    });
    const sel = 'a[data-screen-link="/settings?card=backup"]';
    await waitFor(() => expect(document.querySelector(sel)).not.toBeNull());
    const link = document.querySelector<HTMLElement>(sel)!;
    await user.click(link);
    const heading = await screen.findByRole('heading', { name: 'Backup and restore' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });
});
