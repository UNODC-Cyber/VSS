// @vitest-environment jsdom
// Lane K (R12b): manual validation and edit in place dialogs require a reason, show what changes, and call the IPC.
import { mock, ui } from './helpers';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReviewDetailScreen } from '../../../src/renderer/src/screens/review/ReviewDetailScreen';
import { addUnmatchedRow } from './review-fixtures';

describe('manual validation', () => {
  it('needs a reason, shows the disposition and dates, then records', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    const { reviewId, row } = addUnmatchedRow(ctl, 'UNLISTED, Person');
    const spy = vi.spyOn(window.vss.review, 'manualValidate');
    ui(<ReviewDetailScreen id={reviewId} />);
    await user.click(await screen.findByRole('button', { name: 'Manually validate...' }));
    const dlg = await screen.findByRole('dialog', { name: 'Manually validate this response row' });
    expect(within(dlg).getByLabelText('A new person created from this row')).toBeChecked();
    expect(await within(dlg).findByText('2026-10-20')).toBeInTheDocument();
    expect(within(dlg).getByText('2027-10-20')).toBeInTheDocument();
    expect(within(dlg).getByText('Approved')).toBeInTheDocument();
    const go = within(dlg).getByRole('button', { name: 'Validate and record' });
    expect(go).toBeDisabled();
    await user.type(within(dlg).getByLabelText(/Reason/), 'ok');
    expect(go).toBeDisabled();
    await user.type(within(dlg).getByLabelText(/Reason/), ' by phone');
    expect(go).toBeEnabled();
    await user.click(go);
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ id: reviewId, target: { kind: 'new-person' }, reason: 'ok by phone' }),
    );
    await waitFor(() => expect(ctl.db.records.some((r) => r.responseRowId === row.id)).toBe(true));
    expect(ctl.db.reviews.find((r) => r.id === reviewId)!.resolution).toBe('manual-validate');
  });
});

describe('edit in place', () => {
  it('shows the diff, needs a reason, saves; the DC original is shown and can be restored', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    const { reviewId, row } = addUnmatchedRow(ctl, 'UNLISTED, Person');
    const spy = vi.spyOn(window.vss.review, 'editSubject');
    ui(<ReviewDetailScreen id={reviewId} />);
    const edit = await screen.findByRole('button', { name: 'Edit record...' });
    await waitFor(() => expect(edit).toBeEnabled());
    await user.click(edit);
    const dlg = await screen.findByRole('dialog', { name: 'Correct the response row' });
    const dob = within(dlg).getByLabelText('Date of birth (YYYY-MM-DD)');
    await user.clear(dob);
    await user.type(dob, '1975-01-10');
    const diff = within(dlg).getByTestId('edit-diff');
    expect(within(diff).getByText('1975-01-01')).toBeInTheDocument();
    expect(within(diff).getByText('1975-01-10')).toBeInTheDocument();
    const save = within(dlg).getByRole('button', { name: 'Save correction' });
    expect(save).toBeDisabled();
    await user.type(within(dlg).getByLabelText(/Reason/), 'DC typo');
    await user.click(save);
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({
        id: reviewId,
        subject: { kind: 'response-row', rowId: row.id, patch: { dob: '1975-01-10' } },
        reason: 'DC typo',
      }),
    );
    expect(await screen.findByRole('columnheader', { name: 'DC original' })).toBeInTheDocument();
    expect(row.dob.parsed).toBe('1975-01-10');

    await user.click(screen.getByRole('button', { name: 'Revert to DC original...' }));
    const rd = await screen.findByRole('dialog', { name: 'Restore the row exactly as the DC sent it' });
    await user.type(within(rd).getByLabelText('Reason'), 'undo');
    await user.click(within(rd).getByRole('button', { name: 'Revert to DC original...' }));
    await waitFor(() => expect(ctl.db.responses.at(-1)!.rows[0]!.dob.parsed).toBe('1975-01-01'));
    await waitFor(() => expect(screen.queryByRole('columnheader', { name: 'DC original' })).not.toBeInTheDocument());
  });
});
