// @vitest-environment jsdom
// Lane K (R12a): the review queue names who each item is about, with DOB, unit and context; masked under redaction.
import { mock, ui } from './helpers';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReviewScreen } from '../../../src/renderer/src/screens/review/ReviewListScreen';
import { useUi } from '../../../src/renderer/src/store';
import { addUnmatchedRow } from './review-fixtures';

describe('review list', () => {
  it('shows subject name, DOB, unit and context for every item', async () => {
    const ctl = mock();
    addUnmatchedRow(ctl, 'UNLISTED, Person');
    ui(<ReviewScreen />);
    const link = await screen.findByRole('link', { name: 'Open review item for UNLISTED, Person' });
    const row = link.closest('tr')!;
    expect(within(row).getByText('1975-01-01')).toBeInTheDocument();
    expect(within(row).getByText('Sample Other Agency C')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Response BATCH-T' })).toBeInTheDocument();
    // the seeded duplicate-persons item names its first person
    expect(screen.getByRole('link', { name: 'Open review item for Fir, Marlo' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Subject' })).toBeInTheDocument();
  });

  it('masks subject and DOB under redaction mode', async () => {
    const ctl = mock();
    addUnmatchedRow(ctl, 'UNLISTED, Person');
    ctl.db.settings.redactionMode = true;
    useUi.setState({ settings: { ...ctl.db.settings } });
    ui(<ReviewScreen />);
    await screen.findByText('2 open');
    expect(screen.queryByText('UNLISTED, Person')).not.toBeInTheDocument();
    expect(screen.queryByText('1975-01-01')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /UNLISTED/ })).not.toBeInTheDocument();
  });
});
