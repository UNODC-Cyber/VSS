// @vitest-environment jsdom
import { mock, ui } from './helpers';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { col, DataTable } from '../../../src/renderer/src/components/DataTable';
import { useTableState } from '../../../src/renderer/src/components/ui/tableState';
import { useUi } from '../../../src/renderer/src/store';

interface Row {
  id: string;
  name: string;
  note: string;
}
const rows: Row[] = [
  { id: '1', name: 'Sample One', note: 'A very long sample note that must be cut with an ellipsis' },
];

describe('DataTable v2', () => {
  it('renders old-style columns unchanged (auto layout, no region)', () => {
    mock();
    ui(<DataTable<Row> caption="Plain" data={rows} columns={[col<Row>('n', 'Name', (r) => r.name)]} />);
    expect(screen.getByRole('table', { name: 'Plain' })).toHaveAttribute('data-layout', 'auto');
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('uses a fixed layout with per-column widths and a keyboard-focusable scroll region', () => {
    mock();
    ui(
      <DataTable<Row>
        caption="Fixed"
        data={rows}
        columns={[
          col<Row>('n', 'Name', (r) => r.name, { sticky: 'first', minWidth: 200, grow: true }),
          col<Row>('note', 'Note', (r) => r.note, { maxWidth: 160, truncate: true, tooltip: (r) => r.note }),
          col<Row>('d', 'Date', () => '2026-01-01', { width: 120, nowrap: true }),
        ]}
      />,
    );
    const region = screen.getByRole('region', { name: 'Fixed' });
    expect(region).toHaveAttribute('tabindex', '0');
    const table = within(region).getByRole('table');
    expect(table).toHaveAttribute('data-layout', 'fixed');
    expect(table.style.tableLayout).toBe('fixed');
    const cols = table.querySelectorAll('col');
    expect(cols).toHaveLength(3);
    expect((cols[1] as HTMLElement).style.width).toBe('160px');
    expect((cols[2] as HTMLElement).style.width).toBe('120px');
    const cells = within(screen.getByRole('row', { name: /Sample One/ })).getAllByRole('cell');
    expect(cells[0]).toHaveClass('vss-sticky');
    expect(cells[1]).toHaveClass('vss-truncate');
    expect(cells[2]).toHaveClass('vss-nowrap');
  });

  it('carries the full text of a truncated cell for the tooltip', async () => {
    mock();
    ui(
      <DataTable<Row>
        caption="Trunc"
        data={rows}
        columns={[
          col<Row>('n', 'Name', (r) => r.name),
          col<Row>('note', 'Note', (r) => r.note, { maxWidth: 100, truncate: true }),
        ]}
      />,
    );
    const cell = await screen.findByText(rows[0]!.note);
    expect(cell).toHaveAttribute('data-full', rows[0]!.note);
  });

  it('hides columns through the chooser and keeps default-hidden ones out', async () => {
    mock();
    const user = userEvent.setup();
    useTableState.getState().reset();
    ui(
      <DataTable<Row>
        caption="Choose"
        tableId="t1"
        data={rows}
        columns={[
          col<Row>('n', 'Name', (r) => r.name, { width: 150 }),
          col<Row>('note', 'Note', (r) => r.note, { width: 150, hideable: true }),
          col<Row>('x', 'Extra', () => 'extra-cell', { width: 150, hideable: true, defaultHidden: true }),
        ]}
      />,
    );
    expect(screen.getByRole('columnheader', { name: 'Note' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Extra' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Choose columns' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Extra' }));
    expect(screen.getByRole('columnheader', { name: 'Extra' })).toBeInTheDocument();
    expect(useTableState.getState().hidden['t1']).toEqual([]);
    useTableState.getState().setHidden('t1', ['note', 'x']);
    await waitFor(() => expect(screen.queryByRole('columnheader', { name: 'Note' })).toBeNull());
    useTableState.getState().reset();
  });

  it('applies the saved column choice and the density setting', () => {
    mock();
    useUi.setState((s) => ({ settings: { ...s.settings, uiDensity: 'compact', tableColumns: { t2: ['note'] } } }));
    ui(
      <DataTable<Row>
        caption="Saved"
        tableId="t2"
        data={rows}
        columns={[
          col<Row>('n', 'Name', (r) => r.name, { width: 150 }),
          col<Row>('note', 'Note', (r) => r.note, { width: 150, hideable: true }),
        ]}
      />,
    );
    expect(screen.queryByRole('columnheader', { name: 'Note' })).toBeNull();
    expect(screen.getByRole('table', { name: 'Saved' })).toHaveAttribute('data-density', 'compact');
  });

  it('shows an empty state with icon and hint', () => {
    mock();
    ui(
      <DataTable<Row>
        caption="Empty"
        data={[]}
        empty="No rows"
        emptyHint="Try again"
        columns={[col<Row>('n', 'Name', (r) => r.name, { width: 150 })]}
      />,
    );
    const box = screen.getByTestId('table-empty');
    expect(box).toHaveTextContent('No rows');
    expect(box).toHaveTextContent('Try again');
  });
});
