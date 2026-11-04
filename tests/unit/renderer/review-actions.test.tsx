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
    // UI review O-18: no target is pre-selected; the reviewer chooses every time.
    expect(within(dlg).getByLabelText('A new person created from this row')).not.toBeChecked();
    expect(await within(dlg).findByText('2026-10-20')).toBeInTheDocument();
    expect(within(dlg).getByText('2027-10-20')).toBeInTheDocument();
    expect(within(dlg).getByText('Approved')).toBeInTheDocument();
    const go = within(dlg).getByRole('button', { name: 'Validate and record' });
    expect(go).toBeDisabled();
    await user.type(within(dlg).getByLabelText(/Reason/), 'ok by phone');
    expect(go).toBeDisabled(); // a reason alone is not enough: no target chosen yet
    await user.clear(within(dlg).getByLabelText(/Reason/));
    await user.click(within(dlg).getByLabelText('A new person created from this row'));
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

describe('manual validation against a person whose record disagrees (UI review R3O-04)', () => {
  it('shows the values side by side and needs the "I compared" tick before recording', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    const person = ctl.db.persons.find((p) => p.dob && p.dob !== '1975-01-01')!;
    const { reviewId } = addUnmatchedRow(ctl, 'UNLISTED, Person', { sex: 'M' } as never);
    const rv = ctl.db.reviews.find((r) => r.id === reviewId)!;
    rv.kind = 'response-row-match';
    rv.subjectIds = [rv.subjectIds[0]!, person.id];
    rv.candidates = [{ targetKind: 'person', targetId: person.id, tier: 'T3', evidence: [], score: 0.5 }];
    const spy = vi.spyOn(window.vss.review, 'manualValidate');
    ui(<ReviewDetailScreen id={reviewId} />);
    await user.click(await screen.findByRole('button', { name: 'Manually validate...' }));
    const dlg = await screen.findByRole('dialog', { name: 'Manually validate this response row' });
    expect(within(dlg).queryByTestId('validate-conflicts')).not.toBeInTheDocument();
    await user.click(within(dlg).getByLabelText(/\(candidate\)$/));
    expect(within(dlg).getByTestId('validate-conflicts')).toHaveTextContent('Date of birth');
    const diff = within(dlg).getByTestId('diff');
    const dobRow = within(diff).getByText('Date of birth').closest('tr')!;
    expect(dobRow).toHaveAttribute('data-conflicts', 'true');
    expect(within(dobRow).getByText('1975-01-01')).toBeInTheDocument();
    expect(within(dobRow).getByText(person.dob!)).toBeInTheDocument();
    await user.type(within(dlg).getByLabelText(/Reason/), 'confirmed by phone');
    const go = within(dlg).getByRole('button', { name: 'Validate and record' });
    expect(go).toBeDisabled(); // a reason is not enough while the records disagree
    await user.click(within(dlg).getByRole('checkbox', { name: /I compared .*Date of birth/ }));
    expect(go).toBeEnabled();
    // Switching the target clears the tick: the new comparison must be acknowledged again.
    await user.click(within(dlg).getByLabelText('A new person created from this row'));
    expect(within(dlg).queryByTestId('validate-ack')).not.toBeInTheDocument();
    await user.click(within(dlg).getByLabelText(/\(candidate\)$/));
    expect(within(dlg).getByRole('checkbox', { name: /I compared/ })).not.toBeChecked();
    expect(go).toBeDisabled();
    await user.click(within(dlg).getByRole('checkbox', { name: /I compared/ }));
    await user.click(go);
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({
        id: reviewId,
        target: { kind: 'person', personId: person.id },
        reason: 'confirmed by phone',
      }),
    );
  });

  it('compareFields: a sex or identifier stated differently is a conflict, a missing one is not', async () => {
    const { compareFields } = await import('../../../src/renderer/src/components/review/ManualValidateDialog');
    const { conflictLabels } = await import('../../../src/renderer/src/components/IdentityConfirm');
    const t = (k: string) => k;
    const base = { name: 'A, B', dob: '1980-01-02', sex: 'M', pob: 'X', unit: 'U', ids: ['P1'] };
    expect(conflictLabels(compareFields(t, base, { ...base }))).toEqual([]);
    expect(conflictLabels(compareFields(t, base, { ...base, sex: 'F' }))).toEqual(['person.sex']);
    expect(conflictLabels(compareFields(t, base, { ...base, ids: ['P2'] }))).toEqual(['items.ids']);
    expect(conflictLabels(compareFields(t, base, { ...base, sex: '', ids: [] }))).toEqual([]);
  });
});

describe('edit in place', () => {
  it('shows the diff, needs a reason, saves; the DC original is shown and can be restored', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    const { reviewId, row } = addUnmatchedRow(ctl, 'UNLISTED, Person');
    const spy = vi.spyOn(window.vss.review, 'editSubject');
    ui(<ReviewDetailScreen id={reviewId} />);
    const edit = await screen.findByRole('button', { name: 'Correct response row...' });
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
