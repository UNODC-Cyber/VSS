// @vitest-environment jsdom
// Settings > Templates, the auto-capture notice and the no-template export message (against the mock backend).
import { mock, ui } from './helpers';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { RequestDetailScreen } from '../../../src/renderer/src/screens/RequestDetailScreen';
import { ImportRequestScreen } from '../../../src/renderer/src/screens/ImportRequestScreen';
import { SettingsScreen } from '../../../src/renderer/src/screens/SettingsScreen';

describe('Settings > Templates', () => {
  it('shows the active template, imports a replacement into history, re-activates and removes', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    ui(<SettingsScreen />);
    const active = await screen.findByTestId('template-active');
    expect(active).toHaveTextContent('1.11.0');
    expect(active).toHaveTextContent('Saved from an imported request');
    await user.click(screen.getByRole('button', { name: 'Import template' }));
    expect(await screen.findByText(/Template imported \(version 1\.11\.0\)/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('template-active')).toHaveTextContent('Imported in Settings'));
    const history = screen.getByRole('table', { name: 'Earlier templates' });
    expect(within(history).getAllByRole('row')).toHaveLength(2); // header + one replaced template
    await user.click(within(history).getByRole('button', { name: 'Use this one' }));
    await waitFor(() =>
      expect(screen.getByTestId('template-active')).toHaveTextContent('Saved from an imported request'),
    );
    expect(ctl.db.templates.filter((t) => t.active)).toHaveLength(1);
    await user.click(
      within(screen.getByTestId('template-active').parentElement!).getByRole('button', { name: 'Remove' }),
    );
    await waitFor(() => expect(ctl.db.templates.filter((t) => t.active)).toHaveLength(0));
    expect(await screen.findByText(/No template is stored yet/)).toBeInTheDocument();
  });

  it('with an empty vault: no template; the first import saves one and says so', async () => {
    const ctl = mock({ seed: false });
    const user = userEvent.setup();
    ui(<ImportRequestScreen />);
    await user.click(screen.getByRole('button', { name: 'Choose file' }));
    await screen.findByTestId('count-include');
    await user.type(screen.getByLabelText(/^Requestor name/), 'Pat Example');
    await user.type(screen.getByLabelText(/^Event name/), 'Capture Event');
    expect(ctl.db.templates).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Import request' }));
    expect(await screen.findByText(/Saved this file as the export template \(version 1\.11\.0\)/)).toBeInTheDocument();
    expect(ctl.db.templates).toMatchObject([{ source: 'auto-capture', active: true }]);
  });
});

describe('export without a template', () => {
  it('warns in the dialog and the regenerate export fails with the actionable message', async () => {
    const ctl = mock();
    ctl.db.templates.length = 0;
    const r = ctl.db.requests.find(
      (x) => x.items.length > 0 && x.items.every((i) => i.linkState !== 'pending-review'),
    )!;
    r.sourceFile = null; // nothing to filter: regenerate only
    const user = userEvent.setup();
    ui(<RequestDetailScreen id={r.id} />);
    await user.click(await screen.findByRole('button', { name: 'Export for vetting' }));
    const dlg = await screen.findByRole('dialog');
    expect(await within(dlg).findByText('No export template in this vault')).toBeInTheDocument();
    const res = await ctl.api.requests.export({ requestId: r.id, mode: 'regenerate', destPath: 'mock://saved/x.xlsx' });
    expect(res.ok ? null : res.error.code).toBe('TEMPLATE_MISSING');
    expect(res.ok ? '' : res.error.message).toMatch(/Settings > Templates/);
    expect(ctl.db.exports).toHaveLength(0);
  });
});
