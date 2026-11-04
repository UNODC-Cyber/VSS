// @vitest-environment jsdom
import { mock, ui } from './helpers';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { RequestDetailScreen } from '../../../src/renderer/src/screens/RequestDetailScreen';
import { ImportRequestScreen } from '../../../src/renderer/src/screens/ImportRequestScreen';
import { ManualRequestScreen } from '../../../src/renderer/src/screens/ManualRequestScreen';
import { RequestsScreen } from '../../../src/renderer/src/screens/RequestsScreen';
import { useUi } from '../../../src/renderer/src/store';

describe('requests list', () => {
  it('lists requests and filters to outstanding only', async () => {
    mock();
    const user = userEvent.setup();
    ui(<RequestsScreen />);
    expect(await screen.findByRole('link', { name: 'Regional Cyber Workshop' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Forensics Course' })).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Outstanding only' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Forensics Course' })).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Regional Cyber Workshop' })).toBeInTheDocument();
  });

  it('filters by requestor text', async () => {
    mock();
    const user = userEvent.setup();
    ui(<RequestsScreen />);
    await screen.findByRole('link', { name: 'Liaison Visit' });
    await user.type(screen.getByLabelText('Requestor'), 'Academy');
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Liaison Visit' })).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Forensics Course' })).toBeInTheDocument();
  });
});

describe('import wizard', () => {
  it('shows counts, groups issues by severity and jumps to the row', async () => {
    mock();
    const user = userEvent.setup();
    ui(<ImportRequestScreen />);
    await user.click(screen.getByRole('button', { name: 'Choose file' }));
    expect(await screen.findByTestId('count-include')).toHaveTextContent('3 to include');
    expect(screen.getByTestId('count-exclude')).toHaveTextContent('1 to exclude');
    expect(screen.getByTestId('count-flagged')).toHaveTextContent('2 flagged');
    expect(screen.getByText('Warnings (2)')).toBeInTheDocument();
    expect(screen.getByText('Notes (1)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /R3: Date of birth equals/ }));
    expect(document.getElementById('row-R3')).toHaveFocus();
    expect(screen.getAllByText('Needs decision').length).toBeGreaterThan(0);
  });

  it('requires a reason when an export decision is changed, and applies it after commit', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    ui(<ImportRequestScreen />);
    await user.click(screen.getByRole('button', { name: 'Choose file' }));
    await screen.findByTestId('count-include');
    await user.type(screen.getByLabelText(/^Requestor name/), 'Pat Example');
    await user.type(screen.getByLabelText(/^Event name/), 'Import Test Event');
    const commit = screen.getByRole('button', { name: 'Import request' });
    expect(commit).toBeEnabled();
    await user.click(screen.getByRole('checkbox', { name: 'Include row R2 in the export' }));
    expect(screen.getByTestId('count-exclude')).toHaveTextContent('2 to exclude');
    expect(commit).toBeDisabled();
    await user.type(screen.getByLabelText('Reason for changing row R2'), 'Already vetted elsewhere');
    expect(commit).toBeEnabled();
    await user.click(commit);
    await waitFor(() => expect(ctl.db.requests.some((r) => r.eventName === 'Import Test Event')).toBe(true));
    const req = ctl.db.requests.find((r) => r.eventName === 'Import Test Event')!;
    await waitFor(() =>
      expect(req.items.find((i) => i.observed.rowRef === 'R2')?.exportDecision).toBe('manual-exclude'),
    );
    expect(req.items.find((i) => i.observed.rowRef === 'R2')?.exportReason).toBe('Already vetted elsewhere');
    expect(ctl.db.reviews.filter((r) => r.kind === 'request-item-link' && r.state === 'open')).toHaveLength(1);
  });
});

describe('manual request', () => {
  it('creates a manual request', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    ui(<ManualRequestScreen />);
    const create = screen.getByRole('button', { name: 'Create request' });
    expect(create).toBeDisabled();
    await user.type(screen.getByLabelText(/^Requestor name/), 'Pat Example');
    await user.type(screen.getByLabelText(/^Event name/), 'Manual Event');
    await user.type(screen.getByLabelText(/^Surname/), 'Willow');
    await user.type(screen.getByLabelText('Given names'), 'Remy Lee');
    await user.type(screen.getByLabelText(/^Unit( \*)?$/), 'Sample Police Unit A');
    await user.click(create);
    await waitFor(() => expect(ctl.db.requests.at(-1)?.eventName).toBe('Manual Event'));
    expect(ctl.db.requests.at(-1)?.kind).toBe('manual');
    expect(ctl.db.requests.at(-1)?.items[0]?.observed.name2).toBe('Lee');
  });
});

async function openDetail(eventName: string) {
  const ctl = mock();
  const user = userEvent.setup();
  const req = ctl.db.requests.find((r) => r.eventName === eventName)!;
  ui(<RequestDetailScreen id={req.id} />);
  await screen.findByRole('heading', { name: eventName });
  return { ctl, user, req };
}

describe('request detail', () => {
  it('shows items with status, expiry and copy actions routed through clipboard.copy with a countdown toast', async () => {
    const { ctl, user } = await openDetail('Regional Cyber Workshop');
    expect(screen.getByRole('table', { name: 'Individuals on this request' })).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Copy name' })[0]!);
    expect(ctl.db.clipboard).toBe('Alder, Terra');
    expect(await screen.findByText(/clipboard clears in 30 s/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy row R1 as TSV' }));
    expect(ctl.db.clipboard.split('\t')).toHaveLength(5);
    expect(useUi.getState().toasts.length).toBeGreaterThan(0);
  });

  it('masks dates of birth and identifiers in redaction mode', async () => {
    const ctl = mock();
    ctl.db.settings.redactionMode = true;
    useUi.setState({ settings: { ...ctl.db.settings } });
    const req = ctl.db.requests[0]!;
    ui(<RequestDetailScreen id={req.id} />);
    await screen.findByRole('heading', { name: req.eventName });
    expect(screen.queryByText('1980-03-12')).not.toBeInTheDocument();
    expect(screen.queryByText('XX0000001')).not.toBeInTheDocument();
    expect(screen.getAllByText('••••-••-••').length).toBeGreaterThan(0);
  });

  it('marks a request as sent with a chosen date and time', async () => {
    const { ctl, user, req } = await openDetail('Seminar (draft)');
    await user.click(screen.getByRole('button', { name: 'Mark sent' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Mark sent' }));
    await waitFor(() => expect(ctl.db.requests.find((r) => r.id === req.id)?.status).toBe('sent-to-dc'));
    expect(ctl.db.requests.find((r) => r.id === req.id)?.sentToDcAt).not.toBeNull();
  });

  it('blocks the export while identity decisions are open, then resolves and exports', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    // import a request with a flagged item first
    const prev = await ctl.api.requests.importPreview({ path: 'mock://files/request-sample.xlsx' });
    if (!prev.ok) throw new Error('preview failed');
    const s = await ctl.api.requests.importCommit({
      previewId: prev.value.previewId,
      requestor: { name: 'Pat Example', email: null, organisation: null },
      eventName: 'Flagged Event',
      eventStart: null,
      eventEnd: null,
      eventLocation: null,
      notes: '',
    });
    if (!s.ok) throw new Error('commit failed');
    ui(<RequestDetailScreen id={s.value.id} />);
    await screen.findByRole('heading', { name: 'Flagged Event' });
    expect(screen.getByTestId('unresolved-count')).toHaveTextContent('1 need an identity decision');

    await user.click(screen.getByRole('button', { name: 'Export for vetting' }));
    const dlg = await screen.findByRole('dialog');
    expect(await within(dlg).findByText('Export is blocked')).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: 'Export file' })).toBeDisabled();
    // override path needs a reason
    const override = within(dlg).getByRole('button', { name: 'Override and include them' });
    expect(override).toBeDisabled();
    await user.type(within(dlg).getByLabelText('Reason for overriding'), 'Confirmed by phone');
    await user.click(override);
    await waitFor(() => expect(within(dlg).getByRole('button', { name: 'Export file' })).toBeEnabled());
    await user.click(within(dlg).getByRole('button', { name: 'Export file' }));
    expect(await within(dlg).findByText(/Saved to mock:\/\/saved\//)).toBeInTheDocument();
    expect(ctl.db.exports).toHaveLength(1);
  });

  it('resolves a flagged item by linking a known person', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    const prev = await ctl.api.requests.importPreview({ path: 'mock://files/request-sample.xlsx' });
    if (!prev.ok) throw new Error('x');
    const s = await ctl.api.requests.importCommit({
      previewId: prev.value.previewId,
      requestor: { name: 'Pat Example', email: null, organisation: null },
      eventName: 'Resolve Event',
      eventStart: null,
      eventEnd: null,
      eventLocation: null,
      notes: '',
    });
    if (!s.ok) throw new Error('x');
    ui(<RequestDetailScreen id={s.value.id} />);
    await screen.findByRole('heading', { name: 'Resolve Event' });
    await user.click(screen.getByRole('button', { name: 'Resolve identity for row R3' }));
    const dlg = await screen.findByRole('dialog');
    await user.type(within(dlg).getByRole('combobox', { name: /Search/ }), 'Cedar');
    await user.click(await within(dlg).findByRole('option', { name: /Cedar, Solana/ }));
    await waitFor(() => expect(screen.queryByTestId('unresolved-count')).not.toBeInTheDocument());
    expect(ctl.db.reviews.filter((r) => r.kind === 'request-item-link' && r.state === 'open')).toHaveLength(0);
  });

  it('records an email-only clearance with an assumed expiry that is clearly labelled', async () => {
    const { ctl, user, req } = await openDetail('Regional Cyber Workshop');
    await user.click(screen.getByRole('button', { name: 'Responded by email' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByTestId('expiry-assumed')).toHaveTextContent('Assumed expiry');
    expect(within(dlg).getByText(/Assumed: clearance date plus 30 days/)).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: 'Record outcome' }));
    await waitFor(() => expect(ctl.db.requests.find((r) => r.id === req.id)?.responseKind).toBe('email-clearance'));
    const recs = ctl.db.records.filter((r) => r.requestId === req.id);
    expect(recs).toHaveLength(4);
    expect(recs.every((r) => r.expiryAssumed)).toBe(true);
  });

  it('per-person email clearance with an explicit expiry is not marked assumed', async () => {
    const { ctl, user, req } = await openDetail('Regional Cyber Workshop');
    await user.click(screen.getByRole('button', { name: 'Responded by email' }));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('radio', { name: 'Selected people' }));
    await user.click(within(dlg).getByRole('checkbox', { name: /Alder, Terra/ }));
    fireDate(within(dlg).getByLabelText('Expires on'), '2030-01-01');
    expect(within(dlg).queryByTestId('expiry-assumed')).not.toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: 'Record outcome' }));
    await waitFor(() => expect(ctl.db.records.filter((r) => r.requestId === req.id)).toHaveLength(1));
    const rec = ctl.db.records.find((r) => r.requestId === req.id)!;
    expect(rec.expiresAt).toBe('2030-01-01');
    expect(rec.expiryAssumed).toBe(false);
  });

  it('composes an email to the requestor and copies the body', async () => {
    const { ctl, user } = await openDetail('Regional Cyber Workshop');
    await user.click(screen.getByRole('button', { name: 'Email requestor' }));
    const dlg = await screen.findByRole('dialog');
    expect(await within(dlg).findByDisplayValue(/Received: vetting request/)).toBeInTheDocument();
    // main opens the mail client; the renderer only reports it (it cannot navigate to mailto: itself)
    await user.click(within(dlg).getByRole('button', { name: 'Open in mail client' }));
    expect(await within(dlg).findByTestId('mailto-status')).toHaveTextContent(/asked to open/);
    await user.click(within(dlg).getByRole('button', { name: 'Copy body' }));
    expect(ctl.db.clipboard).toMatch(/We confirm receipt/);
  });

  it('status emails show name, unit, status, valid until; DOB is opt-in per email', async () => {
    const { user } = await openDetail('Regional Cyber Workshop');
    await user.click(screen.getByRole('button', { name: 'Email requestor' }));
    const dlg = await screen.findByRole('dialog');
    await within(dlg).findByLabelText('Subject');
    await user.click(within(dlg).getByLabelText('Template'));
    await user.click(await screen.findByRole('option', { name: 'Outcome notice to requestor', hidden: true }));
    const body = () => (within(dlg).getByLabelText('Message') as HTMLTextAreaElement).value;
    await waitFor(() => expect(body()).toContain('Valid until'));
    expect(body()).not.toContain('Date of birth');
    const dob = within(dlg).getByRole('checkbox', { name: 'Include dates of birth' });
    expect(dob).not.toBeChecked();
    await user.click(dob);
    await waitFor(() => expect(body()).toContain('Date of birth'));
  });
});

function fireDate(el: HTMLElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
