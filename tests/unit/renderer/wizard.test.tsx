// @vitest-environment jsdom
import { mock, ui } from './helpers';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Wizard } from '../../../src/renderer/src/components/Wizard';
import { vss } from '../../../src/renderer/src/lib/api';
import { ImportRequestScreen } from '../../../src/renderer/src/screens/ImportRequestScreen';
import { ImportResponseScreen } from '../../../src/renderer/src/screens/ResponsesScreens';

const STEPS = [
  { id: 'a', label: 'First' },
  { id: 'b', label: 'Second' },
];

describe('request import preview (UI review O-05, O-10)', () => {
  it('shows the parsed date of birth, never an Excel serial, and says why Next is disabled', async () => {
    mock();
    const user = userEvent.setup();
    const real = window.vss.requests.importPreview;
    vi.spyOn(window.vss.requests, 'importPreview').mockImplementation(async (q) => {
      const r = await real(q);
      if (!r.ok) return r;
      const [first, ...rest] = r.value.items;
      return {
        ...r,
        value: {
          ...r.value,
          items: [
            { ...first!, dob: '1996-12-10', dobRaw: '35410' },
            { ...first!, rowRef: 'R99', dob: null, dobRaw: 'n/a' },
            ...rest,
          ],
        },
      };
    });
    ui(<ImportRequestScreen />);
    await user.click(screen.getByRole('button', { name: 'Choose file' }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    const table = await screen.findByRole('table', { name: 'Rows in the file' });
    expect(within(table).getByText('1996-12-10')).toBeInTheDocument();
    expect(within(table).queryByText('35410')).not.toBeInTheDocument();
    // Not a real date: shown exactly as written with an "Invalid date" badge (UI review R2O-02).
    expect(within(table).getByText('n/a')).toBeInTheDocument();
    expect(within(table).getByTestId('dob-invalid')).toHaveTextContent('Invalid date');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByTestId('wizard-next-hint')).toHaveTextContent(/Fill in Requestor name and Event name/);
    expect(screen.getByRole('heading', { name: 'Import a request file' })).toBeInTheDocument();
  });
});

describe('Wizard shell', () => {
  it('marks the current step, disables Back on the first step and calls Next', async () => {
    const onNext = vi.fn();
    const user = userEvent.setup();
    ui(
      <Wizard
        steps={STEPS}
        current={0}
        onBack={null}
        onNext={onNext}
        nextLabel="Go on"
        dirty={false}
        onCancel={() => undefined}
      >
        <p>body</p>
      </Wizard>,
    );
    expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('First');
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Go on' }));
    expect(onNext).toHaveBeenCalledOnce();
  });

  it('Escape cancels a clean wizard at once, and asks first when work would be lost', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    ui(
      <Wizard
        steps={STEPS}
        current={1}
        onBack={() => undefined}
        onNext={() => undefined}
        nextLabel="Go on"
        dirty
        onCancel={onCancel}
      >
        <p>body</p>
      </Wizard>,
    );
    await user.click(screen.getByRole('button', { name: 'Go on' }));
    await user.keyboard('{Escape}');
    expect(onCancel).not.toHaveBeenCalled();
    const dlg = await screen.findByRole('dialog', { name: 'Discard this import?' });
    await user.click(within(dlg).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe('response import wizard (Back, Cancel, wrong file)', () => {
  const pickResponse = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('button', { name: 'Choose file' }));

  it('every step has Back and Cancel; Back keeps the decisions already made', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    const req = ctl.db.requests.find((r) => r.eventName === 'Regional Cyber Workshop')!;
    ui(<ImportResponseScreen requestId={req.id} />);
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    await pickResponse(user);
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await screen.findByRole('table', { name: 'Rows in the response' });
    expect(screen.getByRole('heading', { name: 'Decide rows' })).toHaveFocus();

    await user.click(screen.getAllByLabelText('Decision for row S2')[0]!);
    await user.click(await screen.findByRole('option', { name: /^T2:/, hidden: true }));
    await user.click(screen.getAllByLabelText('Decision for row S3')[0]!);
    await user.click((await screen.findAllByRole('option', { name: 'None of these', hidden: true })).at(-1)!);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(
      await screen.findByText('Importing saves this response with your decisions.', { exact: false }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('table', { name: 'Rows in the response' })).toBeInTheDocument();
    expect(
      (screen.getAllByRole('combobox', { name: 'Decision for row S2', hidden: true })[0] as HTMLInputElement).value,
    ).toMatch(/^T2:/);

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { name: 'Match request' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('button', { name: 'Choose another file' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
  });

  it('Cancel with no decisions leaves at once and releases the preview', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    const req = ctl.db.requests.find((r) => r.eventName === 'Regional Cyber Workshop')!;
    const discard = vi.spyOn(vss().responses, 'discardPreview');
    ui(<ImportResponseScreen requestId={req.id} />);
    await pickResponse(user);
    await screen.findByRole('heading', { name: 'Match request' });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(window.location.hash).toBe(`#/requests/${req.id}`);
    expect(discard).toHaveBeenCalledWith({ previewId: expect.any(String) });
  });

  it('Cancel after a decision asks first; Keep editing keeps the work; Discard leaves', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    const req = ctl.db.requests.find((r) => r.eventName === 'Regional Cyber Workshop')!;
    const discard = vi.spyOn(vss().responses, 'discardPreview');
    ui(<ImportResponseScreen requestId={req.id} />);
    await pickResponse(user);
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await screen.findByRole('table', { name: 'Rows in the response' });
    await user.click(screen.getAllByLabelText('Decision for row S2')[0]!);
    await user.click(await screen.findByRole('option', { name: /^T2:/, hidden: true }));

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    const dlg = await screen.findByRole('dialog', { name: 'Discard this import?' });
    await user.click(within(dlg).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('table', { name: 'Rows in the response' })).toBeInTheDocument();
    expect(discard).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    const again = await screen.findByRole('dialog', { name: 'Discard this import?' });
    await user.click(within(again).getByRole('button', { name: 'Discard and cancel' }));
    await waitFor(() => expect(discard).toHaveBeenCalledOnce());
    expect(window.location.hash).toBe(`#/requests/${req.id}`);
  });

  it('Escape acts as Cancel when focus is inside the wizard', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    const req = ctl.db.requests.find((r) => r.eventName === 'Regional Cyber Workshop')!;
    ui(<ImportResponseScreen requestId={req.id} />);
    await pickResponse(user);
    await screen.findByRole('heading', { name: 'Match request' });
    await user.keyboard('{Escape}');
    expect(window.location.hash).toBe(`#/requests/${req.id}`);
  });

  it('a request workbook in the response importer shows a friendly state, not a rule code', async () => {
    mock();
    const user = userEvent.setup();
    const pick = vi.spyOn(vss().files, 'pickOpen');
    pick.mockResolvedValueOnce({
      ok: true,
      value: { path: 'mock://files/request-sample.xlsx', displayPath: 'request-sample.xlsx' },
    });
    ui(<ImportResponseScreen />);
    await pickResponse(user);

    expect(await screen.findByText('This is not a response file')).toBeInTheDocument();
    expect(screen.getByText(/request-sample\.xlsx is a vetting request workbook/)).toBeInTheDocument();
    expect(screen.queryByText(/WRONG_FILE_KIND/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Open the request importer' }));
    expect(window.location.hash).toBe('#/requests/import');
  });

  it('after a wrong file, Choose another file loads the response and continues', async () => {
    mock();
    const user = userEvent.setup();
    const pick = vi.spyOn(vss().files, 'pickOpen');
    pick.mockResolvedValueOnce({
      ok: true,
      value: { path: 'mock://files/request-sample.xlsx', displayPath: 'request-sample.xlsx' },
    });
    pick.mockResolvedValueOnce({
      ok: true,
      value: { path: 'mock://files/response-sample.xlsx', displayPath: 'response-sample.xlsx' },
    });
    ui(<ImportResponseScreen />);
    await pickResponse(user);
    await screen.findByText('This is not a response file');
    await user.click(screen.getByRole('button', { name: 'Choose another file' }));
    expect(await screen.findByRole('heading', { name: 'Match request' })).toBeInTheDocument();
    expect(screen.queryByText('This is not a response file')).not.toBeInTheDocument();
  });

  it('any other import failure renders inline with a way to choose another file', async () => {
    mock();
    const user = userEvent.setup();
    const importPreview = vi.spyOn(vss().responses, 'importPreview');
    importPreview.mockResolvedValueOnce({
      ok: false,
      error: { code: 'FILE_INVALID', message: 'This is not a response workbook.' },
    });
    ui(<ImportResponseScreen />);
    await pickResponse(user);
    expect(await screen.findByText('This file could not be imported')).toBeInTheDocument();
    expect(screen.getByText('This is not a response workbook.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose another file' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open the request importer' })).not.toBeInTheDocument();
  });

  it('the mock backend answers WRONG_FILE_KIND for a request workbook', async () => {
    mock();
    const r = await vss().responses.importPreview({ path: 'mock://files/request-sample.xlsx' });
    expect(r).toMatchObject({ ok: false, error: { code: 'WRONG_FILE_KIND' } });
  });
});
