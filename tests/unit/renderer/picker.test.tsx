// @vitest-environment jsdom
// Lane K (R11): the person picker - pre-fill, immediate list, type-ahead, keyboard, compare-then-confirm, empty state.
import { mock, ui } from './helpers';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LinkItemDialog } from '../../../src/renderer/src/components/dialogs/LinkItemDialog';
import { ReviewDetailScreen } from '../../../src/renderer/src/screens/review/ReviewDetailScreen';
import { addUnmatchedRow } from './review-fixtures';

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Choose person...' }));
  return screen.findByRole('dialog', { name: 'Choose the person this record is about' });
}

describe('person picker', () => {
  it('opens pre-filled with the subject name and lists likely persons at once', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    const { reviewId } = addUnmatchedRow(ctl, 'ALDER, Terra');
    ui(<ReviewDetailScreen id={reviewId} />);
    const dlg = await openPicker(user);
    const input = within(dlg).getByRole('combobox', { name: /Search/ });
    expect(input).toHaveValue('ALDER, Terra');
    const options = await within(dlg).findAllByRole('option');
    expect(options[0]).toHaveTextContent('Alder, Terra');
    expect(options[0]).toHaveTextContent('Likely match');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', options[0]!.id);
  });

  it('keyboard: arrows move, Enter selects, the comparison is confirmed and the row is linked', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    const { reviewId, row } = addUnmatchedRow(ctl, 'ALDER, Terra');
    ui(<ReviewDetailScreen id={reviewId} />);
    const dlg = await openPicker(user);
    const input = within(dlg).getByRole('combobox', { name: /Search/ });
    await within(dlg).findAllByRole('option');
    fireEvent.keyDown(input, { key: 'End' });
    fireEvent.keyDown(input, { key: 'Home' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('Compare the record with the person you selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to the list' }));
    await within(dlg).findAllByRole('option');
    fireEvent.keyDown(within(dlg).getByRole('combobox', { name: /Search/ }), { key: 'Enter' });
    await user.click(await screen.findByRole('button', { name: 'Confirm link to Alder, Terra' }));
    const alder = ctl.db.persons.find((p) => p.canonical.surname === 'Alder')!;
    await waitFor(() => expect(ctl.db.reviews.find((r) => r.id === reviewId)!.state).toBe('resolved'));
    expect(ctl.db.records.filter((r) => r.responseRowId === row.id).map((r) => r.personId)).toEqual([alder.id]);
  });

  it('type-ahead refines the list; a row click selects', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    const { reviewId } = addUnmatchedRow(ctl, 'NOBODYKNOWN, Someone');
    ui(<ReviewDetailScreen id={reviewId} />);
    const dlg = await openPicker(user);
    const input = within(dlg).getByRole('combobox', { name: /Search/ });
    await user.clear(input);
    await user.type(input, 'indigo hazel');
    const opt = await within(dlg).findByRole('option', { name: /Hazel, Indigo/ });
    expect(within(dlg).getAllByRole('option')).toHaveLength(1);
    await user.click(opt);
    expect(await screen.findByRole('button', { name: 'Confirm link to Hazel, Indigo' })).toBeInTheDocument();
  });

  it('no candidates: explains and offers create new / not the same / dismiss', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    const { reviewId, row } = addUnmatchedRow(ctl, 'QQQZZZ, Xyzzy');
    const before = ctl.db.persons.length;
    ui(<ReviewDetailScreen id={reviewId} />);
    const dlg = await openPicker(user);
    const empty = await within(dlg).findByTestId('picker-empty');
    expect(empty).toHaveTextContent('No matching person found');
    expect(within(empty).getByRole('button', { name: 'Not the same person as any of these' })).toBeInTheDocument();
    expect(within(empty).getByRole('button', { name: 'Dismiss this item' })).toBeInTheDocument();
    await user.click(within(empty).getByRole('button', { name: 'Create new person' }));
    await waitFor(() => expect(ctl.db.reviews.find((r) => r.id === reviewId)!.state).toBe('resolved'));
    expect(ctl.db.persons.length).toBe(before + 1);
    expect(ctl.db.records.some((r) => r.responseRowId === row.id)).toBe(true);
  });

  it('LinkItemDialog lists candidates for the item immediately', async () => {
    const ctl = mock();
    const item = ctl.db.requests[0]!.items[0]!;
    ui(
      <LinkItemDialog
        opened
        itemId={item.id}
        itemName="Alder, Terra"
        onClose={() => undefined}
        onChanged={() => undefined}
      />,
    );
    const dlg = await screen.findByRole('dialog', { name: 'Link to a known person' });
    expect(within(dlg).getByRole('combobox', { name: /Search/ })).toHaveValue('Alder, Terra');
    expect((await within(dlg).findAllByRole('option')).length).toBeGreaterThan(0);
  });
});
