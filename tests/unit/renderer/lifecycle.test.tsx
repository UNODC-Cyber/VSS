// @vitest-environment jsdom
// R7 in the renderer against the mock backend: badges, filters, dashboard counts, Review and close, Reopen.
import { mock, ui } from './helpers';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DashboardScreen } from '../../../src/renderer/src/screens/DashboardScreen';
import { RequestDetailScreen } from '../../../src/renderer/src/screens/RequestDetailScreen';
import { RequestsScreen } from '../../../src/renderer/src/screens/RequestsScreen';

/** Make the seeded "Forensics Course" request Responded with every item excluded (=> derived Finished). */
function finishForensics(ctl: ReturnType<typeof mock>) {
  const r = ctl.db.requests.find((x) => x.eventName === 'Forensics Course')!;
  r.status = 'responded';
  for (const i of r.items) i.exportDecision = 'exclude';
  return r;
}

describe('request lifecycle UI', () => {
  it('a Responded request with every item answered is shown as Finished, with a Needs closing preset', async () => {
    const ctl = mock();
    finishForensics(ctl);
    const user = userEvent.setup();
    ui(<RequestsScreen />);
    const row = (await screen.findByRole('link', { name: 'Forensics Course' })).closest('tr')!;
    expect(within(row).getByText('Finished')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Needs closing' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Liaison Visit' })).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Forensics Course' })).toBeInTheDocument();
  });

  it('the dashboard counts Finished requests and links the tile to the filtered list', async () => {
    const ctl = mock();
    finishForensics(ctl);
    ui(<DashboardScreen />);
    expect(await screen.findByTestId('stat-finished')).toHaveTextContent('1');
    expect(screen.getByTestId('req-status-finished')).toHaveTextContent('1');
    expect(screen.getByRole('link', { name: 'Finished, awaiting close' })).toHaveAttribute(
      'href',
      '#/requests?status=finished',
    );
  });

  it('Review and close: Close is confirmed, the note is shown, Reopen needs a reason of at least 3 characters', async () => {
    const ctl = mock();
    const r = finishForensics(ctl);
    const user = userEvent.setup();
    ui(<RequestDetailScreen id={r.id} />);
    const panel = await screen.findByTestId('review-close-panel');
    expect(within(panel).getByText('Excluded (no answer needed)')).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Close request' }));
    const dlg = await screen.findByRole('dialog');
    await user.type(within(dlg).getByLabelText('Close note (optional)'), 'All good');
    await user.click(within(dlg).getByRole('button', { name: 'Close request' }));
    expect(await screen.findByTestId('close-note')).toHaveTextContent('All good');
    expect(r.status).toBe('closed');
    expect(ctl.db.audit.some((e) => e.type === 'request.close')).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Reopen request' }));
    const re = await screen.findByRole('dialog');
    const confirm = within(re).getAllByRole('button', { name: 'Reopen request' }).at(-1)!;
    expect(confirm).toBeDisabled();
    await user.type(within(re).getByLabelText('Reason for reopening'), 'ab');
    expect(confirm).toBeDisabled();
    await user.type(within(re).getByLabelText('Reason for reopening'), 'c');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close request' })).toBeInTheDocument());
    expect(r.status).toBe('finished');
    expect(r.reopenCount).toBe(1);
  });

  it('a request that is not finished offers no Review and close panel', async () => {
    const ctl = mock();
    const r = ctl.db.requests.find((x) => x.eventName === 'Regional Cyber Workshop')!;
    ui(<RequestDetailScreen id={r.id} />);
    await screen.findByRole('heading', { name: 'Regional Cyber Workshop' });
    expect(screen.queryByTestId('review-close-panel')).toBeNull();
  });

  it('the mock refuses to close an unfinished request and to set Finished by hand', async () => {
    const ctl = mock();
    const r = ctl.db.requests.find((x) => x.eventName === 'Regional Cyber Workshop')!;
    expect(await ctl.api.requests.close({ id: r.id, note: '' })).toMatchObject({
      ok: false,
      error: { code: 'LIFECYCLE_CONFLICT' },
    });
    expect(await ctl.api.requests.setStatus({ id: r.id, status: 'finished' })).toMatchObject({
      ok: false,
      error: { code: 'LIFECYCLE_CONFLICT' },
    });
    expect(await ctl.api.requests.reopen({ id: r.id, reason: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'REASON_REQUIRED' },
    });
  });
});
