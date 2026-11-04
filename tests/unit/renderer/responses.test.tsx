// @vitest-environment jsdom
import { mock, ui } from './helpers';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fieldDiffers } from '../../../src/renderer/src/components/Diff';
import { ImportResponseScreen, ResponsesScreen } from '../../../src/renderer/src/screens/ResponsesScreens';

describe('responses', () => {
  it('lists imported responses', async () => {
    const ctl = mock();
    ctl.db.responses.push({
      id: 'R1'.padEnd(26, '0'),
      batchId: 'BATCH-000',
      post: 'Example Post',
      resultsAsOf: '2026-01-01',
      assistanceLine: '',
      sourceFile: {
        id: 'F'.padEnd(26, '0'),
        originalName: 'x.xlsx',
        sha256: 'a',
        bytes: 1,
        storedAt: '2026-01-01T00:00:00Z',
      },
      importedAt: '2026-01-02T00:00:00Z',
      requestId: null,
      rows: [],
    });
    ui(<ResponsesScreen />);
    expect(await screen.findByText('BATCH-000')).toBeInTheDocument();
  });

  it('request-first import: T1 pre-confirmed, T2/T3 need an explicit choice, unanswered items listed', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    const req = ctl.db.requests.find((r) => r.eventName === 'Regional Cyber Workshop')!;
    ui(<ImportResponseScreen requestId={req.id} />);
    await user.click(screen.getByRole('button', { name: 'Choose file' }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await screen.findByRole('table', { name: 'Rows in the response' });
    expect(screen.getAllByText('T1').length).toBeGreaterThan(0);
    expect(screen.getByText('T2')).toBeInTheDocument();
    expect(screen.getByText('T3')).toBeInTheDocument();
    expect(screen.getAllByText('pre-confirmed').length).toBe(2);
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByText('2 rows still need a decision.')).toBeInTheDocument();
  });

  it('shows a side-by-side diff with swapped day and month highlighted and shown both ways', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    const req = ctl.db.requests.find((r) => r.eventName === 'Regional Cyber Workshop')!;
    ui(<ImportResponseScreen requestId={req.id} />);
    await user.click(screen.getByRole('button', { name: 'Choose file' }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Compare row S2' }));
    const dlg = await screen.findByRole('dialog');
    const diff = within(dlg).getByTestId('diff');
    const dobRow = within(diff).getByText('Date of birth').closest('tr')!;
    expect(dobRow).toHaveAttribute('data-differs', 'true');
    expect(within(dobRow).getAllByText(/as D\/M/)).toHaveLength(2);
    expect(within(dobRow).getByText('as D/M: 07/04/1991, as M/D: 04/07/1991')).toBeInTheDocument();
    const nameRow = within(diff).getByText('Name').closest('tr')!;
    expect(nameRow).toHaveAttribute('data-differs', 'false');
  });

  it('commits after every non-auto row is decided and applies the choices', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    const req = ctl.db.requests.find((r) => r.eventName === 'Regional Cyber Workshop')!;
    ui(<ImportResponseScreen requestId={req.id} />);
    await user.click(screen.getByRole('button', { name: 'Choose file' }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await screen.findByRole('table', { name: 'Rows in the response' });
    const s2 = screen.getAllByLabelText('Decision for row S2')[0]!;
    await user.click(s2);
    await user.click(await screen.findByRole('option', { name: /^T2:/, hidden: true }));
    const s3 = screen.getAllByLabelText('Decision for row S3')[0]!;
    await user.click(s3);
    await user.click((await screen.findAllByRole('option', { name: 'None of these', hidden: true })).at(-1)!);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const commit = screen.getByRole('button', { name: 'Import response' });
    await waitFor(() => expect(commit).toBeEnabled());
    await user.click(commit);
    await waitFor(() => expect(ctl.db.responses).toHaveLength(1));
    await waitFor(() =>
      expect(ctl.db.reviews.filter((r) => r.kind === 'response-row-match' && r.state === 'open')).toHaveLength(0),
    );
    const resp = ctl.db.responses[0]!;
    expect(resp.rows.find((r) => r.rowRef === 'S2')?.match.decision).toBe('confirmed');
    expect(resp.rows.find((r) => r.rowRef === 'S3')?.match.decision).toBe('rejected');
  });

  it('lists request items that the response does not answer', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    const req = ctl.db.requests.find((r) => r.eventName === 'Regional Cyber Workshop')!;
    req.items.push({
      ...structuredClone(req.items[0]!),
      id: 'X'.padEnd(26, '0'),
      observed: { ...req.items[0]!.observed, rowRef: 'R5', surname: 'Zinnia' },
    });
    ui(<ImportResponseScreen requestId={req.id} />);
    await user.click(screen.getByRole('button', { name: 'Choose file' }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    expect(await screen.findByText('1 people on the request have no answer')).toBeInTheDocument();
    expect(screen.getByText(/Zinnia/)).toBeInTheDocument();
  });

  it('file-first import proposes requests ranked by batch id', async () => {
    mock();
    const user = userEvent.setup();
    ui(<ImportResponseScreen />);
    await user.click(screen.getByRole('button', { name: 'Choose file' }));
    expect(await screen.findByText('Matching request')).toBeInTheDocument();
    expect(screen.getByDisplayValue(/Regional Cyber Workshop.*suggested/)).toBeInTheDocument();
  });
});

describe('diff helper', () => {
  it('treats name token order and case as equal', () => {
    expect(fieldDiffers({ key: 'n', label: 'n', kind: 'name', values: ['ALDER, Terra', 'Alder, terra'] })).toBe(false);
    expect(fieldDiffers({ key: 'n', label: 'n', kind: 'name', values: ['Alder, Terra', 'Alder, Tera'] })).toBe(true);
    expect(fieldDiffers({ key: 'd', label: 'd', kind: 'dob', values: ['1980-03-12', ''] })).toBe(true);
  });
});
