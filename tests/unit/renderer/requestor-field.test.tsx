// @vitest-environment jsdom
import { mock, ui } from './helpers';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { RequestorRecord } from '@shared/domain/types';
import {
  affectedRequests,
  EMPTY_REQUESTOR,
  RequestorChoiceModal,
  RequestorField,
  toRequestor,
} from '../../../src/renderer/src/components/RequestorField';
import type { RequestorForm } from '../../../src/renderer/src/components/RequestorField';
import { ManualRequestScreen } from '../../../src/renderer/src/screens/ManualRequestScreen';

function Harness({ onState }: { onState?: (v: RequestorForm, s: RequestorRecord | null) => void }) {
  const [v, setV] = useState<RequestorForm>(EMPTY_REQUESTOR);
  const [saved, setSaved] = useState<RequestorRecord | null>(null);
  return (
    <RequestorField
      value={v}
      saved={saved}
      onChange={(n, s) => {
        setV(n);
        setSaved(s);
        onState?.(n, s);
      }}
    />
  );
}

describe('RequestorField', () => {
  it('offers saved requestors by name, and picking one fills e-mail, organisation and the id', async () => {
    mock();
    const user = userEvent.setup();
    let last: RequestorForm = EMPTY_REQUESTOR;
    ui(<Harness onState={(v) => (last = v)} />);
    const name = screen.getByLabelText(/^Requestor name/);
    expect(name).toHaveAttribute('aria-autocomplete', 'list');
    await user.type(name, 'pat');
    const option = await screen.findByRole('option', { name: /Pat Example/, hidden: true });
    await user.click(option);
    expect(name).toHaveValue('Pat Example');
    expect(screen.getByLabelText('Requestor email')).toHaveValue('pat@example.invalid');
    expect(screen.getByLabelText('Organisation')).not.toHaveValue('');
    expect(last.id).toBeTruthy();
  });

  it('finds a requestor by e-mail typed in the e-mail field', async () => {
    mock();
    const user = userEvent.setup();
    ui(<Harness />);
    await user.type(screen.getByLabelText('Requestor email'), 'pat@exa');
    await user.click(await screen.findByRole('option', { name: /Pat Example/, hidden: true }));
    expect(screen.getByLabelText(/^Requestor name/)).toHaveValue('Pat Example');
  });

  it('works from the keyboard: arrows to move, Enter to pick, Escape to close', async () => {
    mock();
    const user = userEvent.setup();
    ui(<Harness />);
    const name = screen.getByLabelText(/^Requestor name/);
    await user.type(name, 'pat');
    await screen.findByRole('option', { name: /Pat Example/, hidden: true });
    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(name).toHaveValue('Pat Example'));
    expect(screen.getByLabelText('Requestor email')).toHaveValue('pat@example.invalid');
    await user.clear(name);
    await user.type(name, 'pat');
    await screen.findByRole('option', { name: /Pat Example/, hidden: true });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(name).toHaveAttribute('aria-expanded', 'false'));
  });

  it('typing a different name forgets the saved requestor (a new one)', async () => {
    mock();
    const user = userEvent.setup();
    let last: RequestorForm = EMPTY_REQUESTOR;
    ui(<Harness onState={(v) => (last = v)} />);
    const name = screen.getByLabelText(/^Requestor name/);
    await user.type(name, 'pat');
    await user.click(await screen.findByRole('option', { name: /Pat Example/, hidden: true }));
    expect(last.id).toBeTruthy();
    await user.type(name, 'X');
    expect(last.id).toBeUndefined();
    expect(last.name).toBe('Pat ExampleX');
  });
});

describe('requestor helpers', () => {
  const saved: RequestorRecord = {
    id: '01HZZZZZZZZZZZZZZZZZZZZZZ1',
    name: 'Pat Example',
    email: 'pat@example.invalid',
    organisation: 'Org',
    phone: null,
    notes: '',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    requestCount: 3,
    lastUsedAt: null,
  };
  const same: RequestorForm = {
    id: saved.id,
    name: 'Pat Example',
    email: 'pat@example.invalid',
    organisation: 'Org',
    phone: '',
  };

  it('asks only when a used saved record was changed', () => {
    expect(affectedRequests(same, saved)).toBeNull();
    expect(affectedRequests({ ...same, organisation: 'Other' }, saved)).toBe(3);
    expect(affectedRequests({ ...same, organisation: 'Other' }, { ...saved, requestCount: 0 })).toBeNull();
    expect(affectedRequests({ ...same, id: undefined, organisation: 'Other' }, saved)).toBeNull();
    expect(affectedRequests({ ...same, organisation: 'Other' }, null)).toBeNull();
  });

  it('"only this request" drops the id; blanks become null', () => {
    expect(toRequestor(same, 'update').id).toBe(saved.id);
    expect(toRequestor(same, 'only-this-request').id).toBeUndefined();
    expect(toRequestor({ name: ' A ', email: ' ', organisation: '', phone: '' })).toEqual({
      name: 'A',
      email: null,
      organisation: null,
    });
  });

  it('the choice dialog offers both ways and cancel', async () => {
    const user = userEvent.setup();
    const picked: string[] = [];
    ui(<RequestorChoiceModal count={2} onChoose={(c) => picked.push(c)} onCancel={() => picked.push('cancel')} />);
    expect(await screen.findByText(/used by 2 requests/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Only this request' }));
    await user.click(screen.getByRole('button', { name: 'Update saved requestor' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(picked).toEqual(['only-this-request', 'update', 'cancel']);
  });
});

describe('manual request with a saved requestor', () => {
  async function fillRest(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText(/^Event name/), 'Typeahead Event');
    await user.type(screen.getByLabelText(/^Surname/), 'Willow');
    await user.type(screen.getByLabelText(/^Unit( \*)?$/), 'Sample Police Unit A');
  }

  it('changing a used saved requestor asks, and "Update saved requestor" edits the record', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    ui(<ManualRequestScreen />);
    await user.type(screen.getByLabelText(/^Requestor name/), 'pat');
    await user.click(await screen.findByRole('option', { name: /Pat Example/, hidden: true }));
    const org = screen.getByLabelText('Organisation');
    await user.clear(org);
    await user.type(org, 'Renamed Org');
    await fillRest(user);
    await user.click(screen.getByRole('button', { name: 'Create request' }));
    await user.click(await screen.findByRole('button', { name: 'Update saved requestor' }));
    await waitFor(() => expect(ctl.db.requests.at(-1)?.eventName).toBe('Typeahead Event'));
    const r = await ctl.api.requestors.search({ text: 'pat' });
    expect(r.ok && r.value[0]?.organisation).toBe('Renamed Org');
    // The seeded requests that showed the saved values follow the record.
    expect(ctl.db.requests.filter((q) => q.requestor.organisation === 'Renamed Org').length).toBeGreaterThan(1);
  });

  it('"Only this request" leaves the saved record unchanged', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    ui(<ManualRequestScreen />);
    await user.type(screen.getByLabelText(/^Requestor name/), 'pat');
    await user.click(await screen.findByRole('option', { name: /Pat Example/, hidden: true }));
    const before = (await ctl.api.requestors.search({ text: 'pat' }))!;
    const orgBefore = before.ok ? before.value[0]?.organisation : null;
    const org = screen.getByLabelText('Organisation');
    await user.clear(org);
    await user.type(org, 'One-off Org');
    await fillRest(user);
    await user.click(screen.getByRole('button', { name: 'Create request' }));
    await user.click(await screen.findByRole('button', { name: 'Only this request' }));
    await waitFor(() => expect(ctl.db.requests.at(-1)?.eventName).toBe('Typeahead Event'));
    expect(ctl.db.requests.at(-1)?.requestor.organisation).toBe('One-off Org');
    const after = await ctl.api.requestors.search({ text: 'pat' });
    expect(after.ok && after.value[0]?.organisation).toBe(orgBefore);
  });
});
