// @vitest-environment jsdom
/**
 * UI review round 2 (2026-11-04), data / flow / wording findings: invalid and ambiguous dates of birth, the link
 * dialog's record context, unit rows of a response, the close summary, local times, the person status line and the
 * smaller wording fixes. Synthetic data only.
 */
import { mock, ui } from './helpers';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MantineProvider } from '@mantine/core';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';
import type { RequestItem } from '../../../src/shared/domain/types';
import type { ResponsePreviewRow, ReviewSubject } from '../../../src/shared/ipc/contract';
import { DiffGrid } from '../../../src/renderer/src/components/Diff';
import { DobValue } from '../../../src/renderer/src/components/DobValue';
import { conflictLabels } from '../../../src/renderer/src/components/IdentityConfirm';
import { candidateDiffs } from '../../../src/renderer/src/components/PersonPicker';
import { outcomeCounts } from '../../../src/renderer/src/components/ReviewAndClosePanel';
import { defaultTemplateFor } from '../../../src/renderer/src/components/dialogs/EmailRequestorDialog';
import { MarkSentDialog } from '../../../src/renderer/src/components/dialogs/MarkSentDialog';
import { i18n } from '../../../src/renderer/src/i18n';
import {
  fmtDateTime,
  fmtLocalDate,
  localZoneLabel,
  todayIso,
  utcOffsetLabel,
} from '../../../src/renderer/src/lib/format';
import { eventText, RequestDetailScreen, requestActions } from '../../../src/renderer/src/screens/RequestDetailScreen';
import { isUnknownCommanderRow, RowNameCell } from '../../../src/renderer/src/screens/ResponsesScreens';
import { statusBasis } from '../../../src/renderer/src/screens/people/PersonDetailScreen';
import { theme } from '../../../src/renderer/src/theme';
import { useUi } from '../../../src/renderer/src/store';

const t = i18n.t.bind(i18n) as (k: string, o?: Record<string, unknown>) => string;
const bare = (el: React.ReactElement) =>
  render(
    <I18nextProvider i18n={i18n}>
      <MantineProvider theme={theme}>{el}</MantineProvider>
    </I18nextProvider>,
  );

describe('DobValue (R2O-02 / R2O-04)', () => {
  it('shows an impossible date exactly as stored with an "Invalid date" badge', () => {
    bare(<DobValue parsed="1995-20-07" raw="1995-20-07" />);
    expect(screen.getByText('1995-20-07')).toBeInTheDocument();
    expect(screen.getByTestId('dob-invalid')).toHaveTextContent('Invalid date');
  });
  it('shows unreadable text as written, never a guessed date', () => {
    bare(<DobValue parsed={null} raw="31/02/1990" />);
    expect(screen.getByText('31/02/1990')).toBeInTheDocument();
    expect(screen.getByTestId('dob-invalid')).toBeInTheDocument();
  });
  it('marks a D/M-or-M/D date as ambiguous and keeps the value as written', () => {
    bare(<DobValue parsed="1988-02-11" raw="2/11/1988" />);
    expect(screen.getByText('1988-02-11')).toBeInTheDocument();
    const badge = screen.getByTestId('dob-ambiguous');
    expect(badge).toHaveTextContent('Ambiguous');
    expect(badge.getAttribute('aria-label')).toMatch(/month\/day 1988-02-11, as day\/month 1988-11-02/);
    expect(screen.getByTestId('dob-as-written')).toHaveTextContent('in the file: 2/11/1988');
  });
  it('a plain valid date has no badge', () => {
    bare(<DobValue parsed="1980-03-12" raw="29293" />);
    expect(screen.getByText('1980-03-12')).toBeInTheDocument();
    expect(screen.queryByTestId('dob-invalid')).toBeNull();
    expect(screen.queryByTestId('dob-ambiguous')).toBeNull();
  });
  it('redaction hides the readings', () => {
    useUi.setState({ settings: { ...useUi.getState().settings, redactionMode: true } });
    bare(<DobValue parsed="1988-02-11" raw="2/11/1988" />);
    expect(screen.getByTestId('dob-ambiguous').getAttribute('aria-label')).not.toMatch(/1988/);
  });
});

describe('Diff and the identity gate', () => {
  it('a value missing on one side is "missing", not "differs" (R2O-10)', () => {
    bare(
      <DiffGrid
        caption="c"
        headers={['a', 'b']}
        fields={[
          { key: 'sex', label: 'Sex', kind: 'text', values: ['', 'F'] },
          { key: 'dob', label: 'Date of birth', kind: 'dob', values: ['1990-01-02', '1990-02-01'] },
        ]}
      />,
    );
    const rows = within(screen.getByTestId('diff')).getAllByRole('row');
    const sex = rows.find((r) => r.textContent?.startsWith('Sex'))!;
    expect(sex).toHaveAttribute('data-conflicts', 'false');
    expect(sex).toHaveTextContent(/missing/);
    expect(sex).not.toHaveTextContent(/differs/);
    const dob = rows.find((r) => r.textContent?.startsWith('Date of birth'))!;
    expect(dob).toHaveTextContent(/differs/);
  });
  it('an invalid date of birth must be acknowledged like a conflict', () => {
    expect(conflictLabels([{ key: 'dob', label: 'DOB', kind: 'dob', values: ['1995-20-07', ''] }])).toEqual(['DOB']);
    expect(conflictLabels([{ key: 'dob', label: 'DOB', kind: 'dob', values: ['1995-07-20', ''] }])).toEqual([]);
  });
});

describe('link dialog shows the record being linked (R2O-03)', () => {
  const subject: ReviewSubject = {
    id: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
    kind: 'request-item',
    displayName: 'Hazel, Indigo',
    dob: null,
    dobRaw: '1995-20-07',
    sex: 'M',
    pobCountry: null,
    unitName: 'Sample Other Agency C',
    identifiers: [],
    source: 'Manual!1',
    edited: false,
  };
  it('flags candidates whose date of birth or unit differs', () => {
    const p = { dob: '1995-07-20', currentUnitName: 'Sample Other Agency C' } as never;
    expect(candidateDiffs(subject, p)).toEqual({ dob: true, unit: false });
    const valid = { ...subject, dob: '1995-07-20', dobRaw: '1995-07-20' };
    expect(candidateDiffs(valid, p)).toEqual({ dob: false, unit: false });
    expect(candidateDiffs(valid, { dob: '1995-07-20', currentUnitName: 'Another Unit' } as never).unit).toBe(true);
  });

  it('request detail: the impossible DOB is badged and the dialog summarises the record', async () => {
    const ctl = mock();
    const req = ctl.db.requests.find((r) => r.eventName === 'Seminar (draft)')!;
    const item = req.items[0] as RequestItem;
    item.observed.dob = { kind: 'text', value: '1995-20-07', parsed: null, ambiguousDayMonth: false };
    item.linkState = 'pending-review';
    item.personId = null;
    const user = userEvent.setup();
    ui(<RequestDetailScreen id={req.id} />);
    const table = await screen.findByRole('table', { name: 'Individuals on this request' });
    expect(within(table).getByText('1995-20-07')).toBeInTheDocument();
    expect(within(table).getByTestId('dob-invalid')).toBeInTheDocument();
    await user.click(within(table).getByRole('button', { name: /Resolve identity for row/ }));
    const summary = await screen.findByTestId('picker-subject');
    expect(summary).toHaveTextContent('The record you are linking');
    expect(summary).toHaveTextContent('Hazel, Indigo');
    expect(summary).toHaveTextContent('1995-20-07');
    expect(summary).toHaveTextContent('Invalid date');
    expect(summary).toHaveTextContent('Sample Other Agency C');
    expect(summary).toHaveTextContent('R1');
  });

  it('a legacy stored impossible ISO value is still shown as invalid', async () => {
    const ctl = mock();
    const req = ctl.db.requests.find((r) => r.eventName === 'Seminar (draft)')!;
    req.items[0]!.observed.dob = { kind: 'text', value: '1995-20-07', parsed: '1995-20-07', ambiguousDayMonth: false };
    ui(<RequestDetailScreen id={req.id} />);
    const table = await screen.findByRole('table', { name: 'Individuals on this request' });
    expect(within(table).getByTestId('dob-invalid')).toBeInTheDocument();
  });
});

describe('response unit rows (R2O-05)', () => {
  const row = (over: Partial<ResponsePreviewRow>): ResponsePreviewRow =>
    ({
      rowId: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
      rowRef: 'Results!9',
      section: 'approved-unit',
      disp: 'APPROVED',
      nameRaw: 'UNKNOWN,',
      dobRaw: '',
      dob: null,
      certDate: null,
      expires: null,
      unitName: 'Example Highway Patrol Unit 1',
      candidates: [],
      decision: 'none',
      chosenRequestItemId: null,
      chosenPersonId: null,
      dispClass: 'approved',
      sectionSource: 'label',
      ...over,
    }) as ResponsePreviewRow;

  it('an UNKNOWN commander row reads as a unit approval and says nobody is linked', () => {
    bare(<RowNameCell row={row({ unknownCommander: true })} />);
    const cell = screen.getByTestId('unit-row-name');
    expect(cell).toHaveTextContent('Unit approval');
    expect(cell).toHaveTextContent('Example Highway Patrol Unit 1');
    expect(cell).toHaveTextContent(/Commander not named in the file \("UNKNOWN"\).*no person is created or linked/);
    expect(cell).not.toHaveTextContent('UNKNOWN,');
  });
  it('a named commander is shown as the commander of the unit', () => {
    bare(<RowNameCell row={row({ nameRaw: 'EXAMPLE, Commander', unknownCommander: false })} />);
    expect(screen.getByTestId('unit-row-name')).toHaveTextContent('Commander: EXAMPLE, Commander');
  });
  it('falls back to the name when main sends no flag, and never treats a person row as a unit', () => {
    expect(isUnknownCommanderRow(row({}))).toBe(true);
    expect(isUnknownCommanderRow(row({ section: 'approved-individual' }))).toBe(false);
  });
});

describe('close summary counts answers, not export decisions (R2O-06)', () => {
  const item = (personId: string | null, exportDecision: RequestItem['exportDecision']) =>
    ({ personId, exportDecision }) as RequestItem;
  it('an approved person excluded from re-export but answered on this request is answered', () => {
    const n = outcomeCounts({ items: [item('P1', 'exclude')], recordedPersonIds: ['P1'] });
    expect(n).toEqual({ answered: 1, excluded: 0, waiting: 0, total: 1 });
  });
  it('excluded without a record is excluded; included without a record is still waiting', () => {
    const n = outcomeCounts({ items: [item('P1', 'exclude'), item('P2', 'include')], recordedPersonIds: [] });
    expect(n).toEqual({ answered: 0, excluded: 1, waiting: 1, total: 2 });
  });
  it('without the record list it falls back to the export decisions', () => {
    expect(outcomeCounts({ items: [item('P1', 'include'), item(null, 'exclude')] })).toEqual({
      answered: 1,
      excluded: 1,
      waiting: 0,
      total: 2,
    });
  });
});

describe('date-times are shown in local time with the zone where it matters (R2O-07)', () => {
  it('fmtDateTime converts a UTC instant to the computer clock', () => {
    const at = '2026-11-04T07:31:00.000Z';
    const d = new Date(at);
    const pad = (n: number) => String(n).padStart(2, '0');
    const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    expect(fmtDateTime(at)).toBe(local);
    expect(fmtDateTime(at, { zone: true })).toBe(`${local} ${utcOffsetLabel(d)}`);
    expect(fmtLocalDate(at)).toBe(local.slice(0, 10));
    expect(fmtDateTime(null)).toBe('-');
    expect(fmtDateTime('garbage')).toBe('-');
  });
  it('the offset label is UTC±h[:mm]', () => {
    expect(utcOffsetLabel()).toMatch(/^UTC([+-]\d{1,2}(:\d{2})?)?$/);
    expect(localZoneLabel()).toContain(utcOffsetLabel());
  });
  it('today is the local calendar day', () => {
    const d = new Date();
    expect(todayIso()).toBe(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    );
  });
  it('the Mark sent dialog names the time zone and warns when nothing was exported (R2O-19)', async () => {
    const ctl = mock();
    const req = ctl.db.requests.find((r) => r.eventName === 'Seminar (draft)')!;
    ui(<MarkSentDialog opened onClose={() => undefined} request={req} onChanged={() => undefined} />);
    expect(await screen.findByText(/Local time on this computer \(.*UTC/)).toBeInTheDocument();
    expect(screen.getByTestId('sent-not-exported')).toBeInTheDocument();
  });
});

describe('wording and state fixes', () => {
  it('the person status line names today and the deciding record (O-28)', () => {
    const rec = {
      id: 'R1',
      disposition: 'approved',
      certDate: '2026-11-16',
      expiresAt: '2027-11-16',
      recordedAt: '2026-11-04T08:00:00.000Z',
      expiryAssumed: false,
    };
    const line = statusBasis(t, { statusAsOf: '2026-11-04', records: [rec] as never });
    expect(line).toBe(
      'Status on 2026-11-04 (today). Based on the latest record: Approved 2026-11-16, expires 2027-11-16.',
    );
    expect(statusBasis(t, { statusAsOf: '2026-11-04', records: [] })).toMatch(/No vetting record yet/);
  });
  it('a Finished request offers no export, sent mark or answer (R2O-19)', () => {
    expect(requestActions('finished')).toMatchObject({ export: false, markSent: false, answer: false, hint: 'close' });
  });
  it('the event line drops empty parts (R2S-17)', () => {
    expect(eventText({ eventStart: null, eventEnd: null, eventLocation: null })).toBe('-');
    expect(eventText({ eventStart: '2026-12-01', eventEnd: '2026-12-03', eventLocation: 'Example City' })).toBe(
      '2026-12-01 - 2026-12-03, Example City',
    );
    expect(eventText({ eventStart: '2026-12-01', eventEnd: null, eventLocation: '' })).toBe('2026-12-01');
  });
  it('the e-mail template follows the request state (R2O-12)', () => {
    expect(defaultTemplateFor('validated')).toBe('acknowledgement');
    expect(defaultTemplateFor('sent-to-dc')).toBe('reminder');
    expect(defaultTemplateFor('responded')).toBe('status-to-requestor');
    expect(defaultTemplateFor('closed')).toBe('status-to-requestor');
  });
  it('counts are pluralised (R2O-16)', () => {
    expect(t('responseImport.unansweredTitle', { count: 1 })).toBe('1 person on the request has no answer');
    expect(t('importSummary.unanswered', { count: 1 })).toBe('1 person on the request has no answer in this file');
    expect(t('responseImport.needChoice', { count: 1 })).toBe('1 row still needs a decision.');
    expect(t('dashboard.within', { days: 30, count: 0 })).toBe('within 30 days: 0');
  });
});

describe('review detail', () => {
  it('an unanswered person offers "Open request" (O-20) and no compare / "not the same" (R2O-11)', async () => {
    const ctl = mock();
    const req = ctl.db.requests.find((r) => r.eventName === 'Regional Cyber Workshop')!;
    const id = '01HZZZZZZZZZZZZZZZZZZZZZZY';
    ctl.db.reviews.push({
      id,
      kind: 'unanswered-request-item',
      createdAt: '2026-11-01T08:00:00.000Z',
      subjectIds: [req.items[0]!.id],
      candidates: [],
      state: 'open',
      resolution: null,
    });
    const { ReviewDetailScreen } = await import('../../../src/renderer/src/screens/review/ReviewDetailScreen');
    ui(<ReviewDetailScreen id={id} />);
    expect(await screen.findByTestId('open-request')).toHaveTextContent('Open request');
    expect(screen.queryByRole('button', { name: 'Not the same person' })).toBeNull();
    const help = screen.getByTestId('review-action-help');
    expect(help).not.toHaveTextContent(/Compare and decide/);
    await userEvent.setup().click(screen.getByTestId('open-request'));
    await waitFor(() => expect(window.location.hash).toBe(`#/requests/${req.id}`));
  });
});
