// @vitest-environment jsdom
import { mock, PASSWORD, ui } from './helpers';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { RequestDetailScreen } from '../../../src/renderer/src/screens/RequestDetailScreen';
import { SettingsScreen } from '../../../src/renderer/src/screens/SettingsScreen';

// All addresses and names are synthetic.
describe('Settings > E-mail templates', { timeout: 60_000 }, () => {
  it('shows the default text with a live preview on synthetic data and flags unknown placeholders', async () => {
    mock();
    const user = userEvent.setup();
    ui(<SettingsScreen />);
    const card = within(document.getElementById('card-email-templates')!);
    expect(card.getByLabelText('Subject')).toHaveValue('{event} – vetting status – {as_of}');
    const subject = await card.findByTestId('preview-subject');
    await waitFor(() => expect(subject).toHaveTextContent('Example Regional Workshop – vetting status'));
    expect(card.getByTestId('preview-body')).toHaveTextContent('EXAMPLE, Sample Person');
    expect(card.getByText('Default text')).toBeInTheDocument();

    fireEvent.change(card.getByLabelText('Message'), { target: { value: 'Hello {requestor_name} {nope}' } });
    await waitFor(() => expect(card.getByTestId('preview-body')).toHaveTextContent('Hello Sample Requestor {nope}'));
    expect(card.getByRole('status')).toHaveTextContent('{nope}');
    expect(card.getByText('Changed from default')).toBeInTheDocument();
    await user.click(card.getByRole('button', { name: 'Reset to default' }));
    expect((card.getByLabelText('Message') as HTMLTextAreaElement).value).toContain(
      'Please find below the vetting status for {event}',
    );
    expect(card.getByRole('button', { name: 'Reset to default' })).toBeDisabled();
  });

  it('placeholder chips insert at the caret; {status_table} is offered only where it is allowed', async () => {
    mock();
    const user = userEvent.setup();
    ui(<SettingsScreen />);
    const card = within(document.getElementById('card-email-templates')!);
    const body = card.getByLabelText('Message') as HTMLTextAreaElement;
    body.focus();
    body.setSelectionRange(0, 0);
    await user.click(card.getByRole('button', { name: 'Insert {batch_id}' }));
    expect(body.value.startsWith('{batch_id}Dear colleagues')).toBe(true);
    expect(card.getByRole('button', { name: 'Insert {status_table}' })).toBeInTheDocument();
    await user.click(card.getByRole('tab', { name: 'Request to vetting authority' }));
    expect(card.queryByRole('button', { name: 'Insert {status_table}' })).not.toBeInTheDocument();
  });

  it('saves templates with the password and the next draft uses them', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    ui(<SettingsScreen />);
    const card = within(document.getElementById('card-email-templates')!);
    await user.click(card.getByRole('tab', { name: 'Acknowledge receipt to requestor' }));
    fireEvent.change(card.getByLabelText('Subject'), { target: { value: 'Got it: {event}' } });
    fireEvent.change(screen.getByLabelText(/Password to confirm changes/), { target: { value: PASSWORD } });
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(ctl.db.settings.emailTemplates.acknowledgement?.subject).toBe('Got it: {event}'));
    const req = ctl.db.requests[0]!;
    const d = await ctl.api.email.draft({ template: 'request-acknowledgement', requestId: req.id });
    expect(d.ok && d.value.subject).toBe(`Got it: ${req.eventName}`);
    expect(d.ok && d.value.to).toEqual(req.requestor.email ? [req.requestor.email] : []);
  });
});

describe('Settings > Vetting authority contacts', { timeout: 60_000 }, () => {
  it('adds, validates and removes To / Cc contacts, and saves them', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    ui(<SettingsScreen />);
    const card = within(document.getElementById('card-authority')!);
    await user.click(card.getByRole('button', { name: 'Add To contact' }));
    fireEvent.change(card.getByLabelText('To contact 1: Name'), { target: { value: 'Example Desk' } });
    fireEvent.change(card.getByLabelText('To contact 1: E-mail address'), { target: { value: 'not-an-address' } });
    expect(card.getByText('Enter a valid e-mail address.')).toBeInTheDocument();
    fireEvent.change(card.getByLabelText('To contact 1: E-mail address'), {
      target: { value: 'desk@example.invalid' },
    });
    expect(card.queryByText('Enter a valid e-mail address.')).not.toBeInTheDocument();
    await user.click(card.getByRole('button', { name: 'Add Cc contact' }));
    fireEvent.change(card.getByLabelText('Cc contact 1: Name'), { target: { value: 'Example Lead' } });
    fireEvent.change(card.getByLabelText('Cc contact 1: E-mail address'), {
      target: { value: 'lead@example.invalid' },
    });
    await user.click(card.getByRole('button', { name: 'Add Cc contact' }));
    fireEvent.change(card.getByLabelText('Cc contact 2: E-mail address'), {
      target: { value: 'LEAD@example.invalid' },
    });
    expect(card.getByText('This address is already in the list.')).toBeInTheDocument();
    await user.click(card.getByRole('button', { name: 'Remove Cc contact 2' }));
    fireEvent.change(screen.getByLabelText(/Password to confirm changes/), { target: { value: PASSWORD } });
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() =>
      expect(ctl.db.settings.vettingAuthority).toEqual({
        to: [{ name: 'Example Desk', email: 'desk@example.invalid' }],
        cc: [{ name: 'Example Lead', email: 'lead@example.invalid' }],
      }),
    );
    const req = ctl.db.requests[0]!;
    const d = await ctl.api.email.draft({ template: 'request-to-dc', requestId: req.id });
    expect(d.ok && d.value.to).toEqual(['desk@example.invalid']);
    expect(d.ok && d.value.cc).toEqual(['lead@example.invalid']);
  });
});

describe('Email to requestor dialog', () => {
  it('pre-fills To with the requestor e-mail and offers the five purposes', async () => {
    const ctl = mock();
    const req = ctl.db.requests.find((r) => r.requestor.email) ?? ctl.db.requests[0]!;
    req.requestor.email = 'requestor@example.invalid';
    const user = userEvent.setup();
    ui(<RequestDetailScreen id={req.id} />);
    await user.click(await screen.findByRole('button', { name: 'Email requestor' }));
    const dlg = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dlg).getByLabelText('To')).toHaveValue('requestor@example.invalid'));
    expect(within(dlg).getByRole('link', { name: 'Edit templates' })).toHaveAttribute(
      'href',
      '#/settings?card=email-templates',
    );
    await user.click(within(dlg).getByLabelText('Template'));
    for (const name of [
      'Acknowledge receipt to requestor',
      'Outcome notice to requestor',
      'All clear to requestor',
      'Reminder: outstanding request',
      'Request to vetting authority',
    ])
      expect(await screen.findByRole('option', { name, hidden: true })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'All clear to requestor', hidden: true }));
    await waitFor(() =>
      expect((within(dlg).getByLabelText('Subject') as HTMLInputElement).value).toContain('vetting cleared'),
    );
    expect(within(dlg).getByLabelText('To')).toHaveValue('requestor@example.invalid');
  });
});
