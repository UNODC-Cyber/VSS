// @vitest-environment jsdom
import { mock, ui } from './helpers';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ColMeta } from '../../../src/renderer/src/components/DataTable';
import { PERSON_COLUMNS, PersonTable } from '../../../src/renderer/src/screens/people/PeopleScreen';
import type { PersonSummary } from '../../../src/shared/ipc/contract';
import { i18n } from '../../../src/renderer/src/i18n';

const LONG_UNIT = 'Sample Directorate of Transnational Organised Crime Liaison and Coordination Section';
const person = (over: Partial<PersonSummary>): PersonSummary =>
  ({
    id: 'P1',
    displayName: 'Alder, Terra',
    dob: '1980-03-12',
    nationality: 'Exampleland',
    currentUnitName: LONG_UNIT,
    status: 'approved',
    expiresAt: '2027-01-15',
    hasOpenReview: false,
    ...over,
  }) as PersonSummary;

const metaOf = (id: string): ColMeta<PersonSummary> | undefined =>
  (PERSON_COLUMNS(i18n.t.bind(i18n)).find((c) => c.id === id) as { meta?: ColMeta<PersonSummary> } | undefined)?.meta;

describe('People table (R13 reference case)', () => {
  it('declares the width and no-wrap configuration of the plan', () => {
    expect(metaOf('name')).toMatchObject({ sticky: 'first', minWidth: 200, grow: true, truncate: true });
    expect(metaOf('dob')).toMatchObject({ width: 112, nowrap: true });
    expect(metaOf('unit')).toMatchObject({ minWidth: 160, grow: true, truncate: true });
    expect(metaOf('status')).toMatchObject({ minWidth: 150, nowrap: true });
    expect(metaOf('exp')).toMatchObject({ width: 112, nowrap: true });
    expect(metaOf('rev')).toMatchObject({ width: 136 });
  });

  it('renders Expires and Status as non-wrapping cells, Unit as a truncating cell with the full name', async () => {
    mock();
    ui(<PersonTable rows={[person({})]} caption="People table" />);
    const row = screen.getByRole('row', { name: /Alder/ });
    const cells = within(row).getAllByRole('cell');
    const unit = cells[3]!;
    const status = cells[4]!;
    const expires = cells[5]!;
    expect(expires).toHaveClass('vss-nowrap');
    expect(status).toHaveClass('vss-nowrap');
    expect(unit).toHaveClass('vss-truncate');
    expect(within(status).getByText('Approved')).toBeVisible();
    expect(await within(unit).findByText(LONG_UNIT)).toHaveAttribute('data-full', LONG_UNIT);
    const cols = screen.getByRole('table', { name: 'People table' }).querySelectorAll('col');
    expect((cols[4] as HTMLElement).style.width).toBe('150px');
    expect((cols[5] as HTMLElement).style.width).toBe('112px');
  });

  it('shows the status as readable text for every status', () => {
    mock();
    const statuses = ['unknown', 'pending', 'approved', 'expiring', 'expired', 'non-approved'] as const;
    ui(
      <PersonTable
        rows={statuses.map((s, i) => person({ id: `P${i}`, displayName: `Name ${i}`, status: s }))}
        caption="All statuses"
      />,
    );
    for (const s of statuses) {
      const badge = document.querySelector(`[data-status="${s}"]`);
      expect(badge?.textContent?.trim().length).toBeGreaterThan(2);
    }
  });
});
