import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  MultiSelect,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExportDecision, RequestStatus, Sex, UnitType, ValidationIssue } from '@shared/domain/types';
import type { ImportPreview, ImportPreviewItem, ManualRequestItemInput, RequestSummary } from '@shared/ipc/contract';
import { col, DataTable } from '../components/DataTable';
import { LinkBadge, PageHeader, QueryBoundary, Sensitive, SimplePager, StatusBadge } from '../components/common';
import { useAction, useBusyAction, useQuery, vss } from '../lib/api';
import { fmtDate } from '../lib/format';
import { navigate } from '../lib/router';
import { useUi } from '../store';

const STATUSES: RequestStatus[] = [
  'received',
  'validated',
  'exported',
  'sent-to-dc',
  'responded',
  'closed',
  'withdrawn',
];
const PAGE = 25;

export function RequestsScreen() {
  const { t } = useTranslation();
  const [statuses, setStatuses] = useState<string[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [text, setText] = useState('');
  const [outstanding, setOutstanding] = useState(false);
  const [offset, setOffset] = useState(0);
  const q = useQuery(
    () =>
      vss().requests.list({
        offset,
        limit: PAGE,
        statuses: statuses as RequestStatus[],
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(text ? { text } : {}),
        outstandingOnly: outstanding,
      }),
    [offset, statuses.join(), from, to, text, outstanding],
  );

  return (
    <Stack>
      <PageHeader
        title={t('requests.title')}
        actions={
          <>
            <Button onClick={() => navigate('/requests/import')}>{t('requests.import')}</Button>
            <Button variant="default" onClick={() => navigate('/requests/new')}>
              {t('requests.createManual')}
            </Button>
          </>
        }
      />
      <Group align="flex-end" role="group" aria-label={t('requests.filters')}>
        <MultiSelect
          label={t('requests.status')}
          data={STATUSES.map((s) => ({ value: s, label: t(`reqstatus.${s}`) }))}
          value={statuses}
          onChange={(v) => {
            setStatuses(v);
            setOffset(0);
          }}
          clearable
          w={260}
        />
        <TextInput
          label={t('requests.from')}
          type="date"
          value={from}
          onChange={(e) => setFrom(e.currentTarget.value)}
        />
        <TextInput label={t('requests.to')} type="date" value={to} onChange={(e) => setTo(e.currentTarget.value)} />
        <TextInput
          label={t('requests.requestor')}
          value={text}
          onChange={(e) => {
            setText(e.currentTarget.value);
            setOffset(0);
          }}
        />
        <Switch
          label={t('requests.outstanding')}
          checked={outstanding}
          onChange={(e) => {
            setOutstanding(e.currentTarget.checked);
            setOffset(0);
          }}
        />
      </Group>
      <QueryBoundary loading={q.loading && !q.data} error={q.error}>
        {q.data && (
          <>
            <DataTable<RequestSummary>
              caption={t('requests.caption')}
              data={q.data.items}
              empty={t('requests.empty')}
              rowId={(r) => r.id}
              columns={[
                col<RequestSummary>('event', t('requests.event'), (r) => (
                  <a href={`#/requests/${r.id}`}>{r.eventName}</a>
                )),
                col<RequestSummary>('received', t('requests.received'), (r) => fmtDate(r.receivedAt.slice(0, 10))),
                col<RequestSummary>('requestor', t('requests.requestor'), (r) => r.requestor.name),
                col<RequestSummary>('status', t('requests.status'), (r) => (
                  <Badge variant="light">{t(`reqstatus.${r.status}`)}</Badge>
                )),
                col<RequestSummary>('items', t('requests.items'), (r) => `${r.answeredCount}/${r.itemCount}`),
                col<RequestSummary>('issues', t('requests.issues'), (r) =>
                  r.unresolvedLinkCount + r.errorCount > 0 ? (
                    <Badge color="orange">{r.unresolvedLinkCount + r.errorCount}</Badge>
                  ) : (
                    '-'
                  ),
                ),
                col<RequestSummary>('aging', t('requests.aging'), (r) =>
                  r.agingDays === null ? '-' : t('common.days', { count: r.agingDays }),
                ),
              ]}
            />
            <SimplePager total={q.data.total} offset={offset} limit={PAGE} onChange={setOffset} />
          </>
        )}
      </QueryBoundary>
    </Stack>
  );
}

// ------------------------------------------------------------------------------------------------------------
// Import wizard
// ------------------------------------------------------------------------------------------------------------

interface Decision {
  include: boolean;
  reason: string;
}
const isIncluded = (d: ExportDecision) => d === 'include' || d === 'manual-include';
const isFlagged = (i: ImportPreviewItem) =>
  i.linkState === 'pending-review' || i.issues.some((x) => x.severity !== 'info');

export function ImportRequestScreen() {
  const { t } = useTranslation();
  const act = useAction();
  const toast = useUi((s) => s.pushToast);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [focusRow, setFocusRow] = useState<string | null>(null);
  const [form, setForm] = useState({
    requestorName: '',
    requestorEmail: '',
    organisation: '',
    eventName: '',
    eventStart: '',
    eventEnd: '',
    eventLocation: '',
    notes: '',
  });
  const [busy, setBusy] = useState(false);
  const picker = useBusyAction();

  const pick = async () => {
    const f = await picker.act(() => vss().files.pickOpen({ kind: 'request-xlsx', title: t('import.pickTitle') }));
    if (!f?.path) return;
    const p = await act(vss().requests.importPreview({ path: f.path }));
    if (!p) return;
    setPreview(p);
    setDecisions(
      Object.fromEntries(
        p.items.map((i) => [i.rowRef, { include: isIncluded(i.exportDecision), reason: i.exportReason }]),
      ),
    );
  };

  const jumpTo = (rowRef: string | null) => {
    if (!rowRef) return;
    setFocusRow(rowRef);
    const el = document.getElementById(`row-${rowRef}`);
    el?.scrollIntoView?.({ block: 'center' });
    el?.focus();
  };

  const commit = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const s = await act(
        vss().requests.importCommit({
          previewId: preview.previewId,
          requestor: {
            name: form.requestorName.trim(),
            email: form.requestorEmail.trim() || null,
            organisation: form.organisation.trim() || null,
          },
          eventName: form.eventName.trim(),
          eventStart: form.eventStart || null,
          eventEnd: form.eventEnd || null,
          eventLocation: form.eventLocation.trim() || null,
          notes: form.notes,
          // Rows whose export choice differs from the policy proposal, committed in the same transaction.
          exportDecisions: preview.items.flatMap((pi) => {
            const d = decisions[pi.rowRef];
            return d && d.include !== isIncluded(pi.exportDecision)
              ? [
                  {
                    rowRef: pi.rowRef,
                    decision: d.include ? ('manual-include' as const) : ('manual-exclude' as const),
                    reason: d.reason.trim(),
                  },
                ]
              : [];
          }),
        }),
        t('import.done'),
      );
      if (!s) return;
      if (s.templateCaptured)
        toast({
          kind: 'info',
          message: t('templates.captured', { version: s.templateCaptured.templateVersion ?? '?' }),
        });
      navigate(`/requests/${s.id}`);
    } finally {
      setBusy(false);
    }
  };

  if (!preview) {
    return (
      <Stack>
        <PageHeader title={t('import.title')} />
        <Text>{t('import.intro')}</Text>
        <Group>
          <Button onClick={() => void pick()} loading={picker.busy}>
            {t('import.pick')}
          </Button>
        </Group>
      </Stack>
    );
  }

  const counts = {
    include: Object.values(decisions).filter((d) => d.include).length,
    exclude: Object.values(decisions).filter((d) => !d.include).length,
    flagged: preview.items.filter(isFlagged).length,
  };
  const reasonMissing = preview.items.some((i) => {
    const d = decisions[i.rowRef];
    return d && d.include !== isIncluded(i.exportDecision) && d.reason.trim().length < 3;
  });
  const formValid = form.requestorName.trim() !== '' && form.eventName.trim() !== '';
  const bySeverity = (sev: ValidationIssue['severity']) => preview.issues.filter((i) => i.severity === sev);

  return (
    <Stack>
      <PageHeader
        title={t('import.previewTitle', { name: preview.fileName })}
        actions={
          <Button variant="default" onClick={() => setPreview(null)}>
            {t('import.chooseAnother')}
          </Button>
        }
      />
      {preview.duplicateOfRequestId && (
        <Alert color="orange" title={t('import.duplicateTitle')}>
          {t('import.duplicateBody')}{' '}
          <a href={`#/requests/${preview.duplicateOfRequestId}`}>{t('import.openExisting')}</a>
        </Alert>
      )}
      <Group gap="sm" aria-label={t('import.summary')} role="group">
        <Badge size="lg" color="green" data-testid="count-include">
          {t('import.countInclude', { count: counts.include })}
        </Badge>
        <Badge size="lg" color="gray" data-testid="count-exclude">
          {t('import.countExclude', { count: counts.exclude })}
        </Badge>
        <Badge size="lg" color="orange" data-testid="count-flagged">
          {t('import.countFlagged', { count: counts.flagged })}
        </Badge>
      </Group>

      {(['error', 'warning', 'info'] as const).map((sev) => {
        const list = bySeverity(sev);
        if (list.length === 0) return null;
        return (
          <Card key={sev} withBorder padding="sm" aria-label={t(`severity.${sev}`)}>
            <Title order={4}>
              {t(`severity.${sev}`)} ({list.length})
            </Title>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {list.map((iss, n) => (
                <li key={`${iss.code}-${n}`}>
                  {iss.rowRef ? (
                    <Button variant="subtle" size="compact-sm" onClick={() => jumpTo(iss.rowRef)}>
                      {iss.rowRef}: {iss.message}
                    </Button>
                  ) : (
                    <Text size="sm" component="span">
                      {iss.message}
                    </Text>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        );
      })}

      <DataTable<ImportPreviewItem>
        caption={t('import.itemsCaption')}
        data={preview.items}
        rowId={(i) => i.rowRef}
        rowProps={(i) => ({
          id: `row-${i.rowRef}`,
          tabIndex: -1,
          ...(focusRow === i.rowRef ? { 'data-focused': 'true' } : {}),
        })}
        columns={[
          col<ImportPreviewItem>('row', t('import.row'), (i) => i.rowRef),
          col<ImportPreviewItem>('name', t('import.name'), (i) => <Sensitive value={i.displayName} />),
          col<ImportPreviewItem>('unit', t('import.unit'), (i) => i.unitName),
          col<ImportPreviewItem>('dob', t('import.dob'), (i) => <Sensitive value={i.dobRaw} />),
          col<ImportPreviewItem>('link', t('import.link'), (i) => <LinkBadge state={i.linkState} />),
          col<ImportPreviewItem>('prior', t('import.prior'), (i) =>
            i.prior ? <StatusBadge status={i.prior.status} /> : '-',
          ),
          col<ImportPreviewItem>('issues', t('import.issues'), (i) =>
            i.issues.length ? i.issues.map((x) => x.code).join(', ') : '-',
          ),
          col<ImportPreviewItem>('export', t('import.export'), (i) => {
            const d = decisions[i.rowRef] ?? { include: true, reason: '' };
            const changed = d.include !== isIncluded(i.exportDecision);
            return (
              <Stack gap={4}>
                <Checkbox
                  label={t('import.includeInExport')}
                  aria-label={t('import.includeRow', { row: i.rowRef })}
                  checked={d.include}
                  onChange={(e) => {
                    const include = e.currentTarget.checked;
                    setDecisions((prev) => ({ ...prev, [i.rowRef]: { include, reason: '' } }));
                  }}
                />
                {changed ? (
                  <TextInput
                    size="xs"
                    aria-label={t('import.reasonFor', { row: i.rowRef })}
                    placeholder={t('common.reason')}
                    value={d.reason}
                    onChange={(e) => {
                      const reason = e.currentTarget.value;
                      setDecisions((prev) => ({
                        ...prev,
                        [i.rowRef]: { include: prev[i.rowRef]?.include ?? d.include, reason },
                      }));
                    }}
                  />
                ) : (
                  <Text size="xs" c="dimmed">
                    {d.reason}
                  </Text>
                )}
              </Stack>
            );
          }),
        ]}
      />

      <Card withBorder>
        <Title order={4} mb="sm">
          {t('import.detailsTitle')}
        </Title>
        <Group grow align="flex-start">
          <TextInput
            label={t('request.requestorName')}
            required
            value={form.requestorName}
            onChange={(e) => setForm({ ...form, requestorName: e.currentTarget.value })}
          />
          <TextInput
            label={t('request.requestorEmail')}
            value={form.requestorEmail}
            onChange={(e) => setForm({ ...form, requestorEmail: e.currentTarget.value })}
          />
          <TextInput
            label={t('request.organisation')}
            value={form.organisation}
            onChange={(e) => setForm({ ...form, organisation: e.currentTarget.value })}
          />
        </Group>
        <Group grow align="flex-start" mt="sm">
          <TextInput
            label={t('request.eventName')}
            required
            value={form.eventName}
            onChange={(e) => setForm({ ...form, eventName: e.currentTarget.value })}
          />
          <TextInput
            label={t('request.eventStart')}
            type="date"
            value={form.eventStart}
            onChange={(e) => setForm({ ...form, eventStart: e.currentTarget.value })}
          />
          <TextInput
            label={t('request.eventEnd')}
            type="date"
            value={form.eventEnd}
            onChange={(e) => setForm({ ...form, eventEnd: e.currentTarget.value })}
          />
          <TextInput
            label={t('request.eventLocation')}
            value={form.eventLocation}
            onChange={(e) => setForm({ ...form, eventLocation: e.currentTarget.value })}
          />
        </Group>
        <Textarea
          mt="sm"
          label={t('request.notes')}
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.currentTarget.value })}
        />
      </Card>
      {!preview.canCommit && <Alert color="red">{t('import.cannotCommit')}</Alert>}
      <Group>
        <Button
          onClick={() => void commit()}
          disabled={!preview.canCommit || !formValid || reasonMissing}
          loading={busy}
        >
          {t('import.commit')}
        </Button>
        {reasonMissing && <Text size="sm">{t('import.reasonNeeded')}</Text>}
      </Group>
    </Stack>
  );
}

// ------------------------------------------------------------------------------------------------------------
// Manual request
// ------------------------------------------------------------------------------------------------------------

const blankItem = (): ManualRequestItemInput => ({
  surname: '',
  givenNames: [],
  dob: null,
  dobPrecision: 'exact',
  sex: null,
  unitName: '',
  unitType: 'Other',
  unitCountry: '',
  pobCountry: null,
  nationality: null,
  isHeadOfUnit: null,
});

export function ManualRequestScreen() {
  const { t } = useTranslation();
  const act = useAction();
  const [form, setForm] = useState({
    name: '',
    email: '',
    org: '',
    event: '',
    start: '',
    end: '',
    location: '',
    sent: '',
    notes: '',
  });
  const [items, setItems] = useState<ManualRequestItemInput[]>([blankItem()]);
  const [given, setGiven] = useState<string[]>(['']);
  const set = (n: number, patch: Partial<ManualRequestItemInput>) =>
    setItems(items.map((it, k) => (k === n ? { ...it, ...patch } : it)));
  const valid =
    form.name.trim() !== '' &&
    form.event.trim() !== '' &&
    items.length > 0 &&
    items.every((i) => i.surname.trim() && i.unitName.trim());

  const submit = async () => {
    const s = await act(
      vss().requests.createManual({
        requestor: { name: form.name.trim(), email: form.email.trim() || null, organisation: form.org.trim() || null },
        eventName: form.event.trim(),
        eventStart: form.start || null,
        eventEnd: form.end || null,
        eventLocation: form.location.trim() || null,
        sentToDcAt: form.sent ? new Date(form.sent).toISOString() : null,
        notes: form.notes,
        items: items.map((it, k) => ({ ...it, givenNames: (given[k] ?? '').split(/\s+/).filter(Boolean) })),
      }),
      t('manual.done'),
    );
    if (s) navigate(`/requests/${s.id}`);
  };

  return (
    <Stack component="form" onSubmit={(e: React.FormEvent) => e.preventDefault()}>
      <PageHeader title={t('manual.title')} />
      <Text c="dimmed">{t('manual.intro')}</Text>
      <Group grow align="flex-start">
        <TextInput
          label={t('request.requestorName')}
          required
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.currentTarget.value })}
        />
        <TextInput
          label={t('request.requestorEmail')}
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.currentTarget.value })}
        />
        <TextInput
          label={t('request.organisation')}
          value={form.org}
          onChange={(e) => setForm({ ...form, org: e.currentTarget.value })}
        />
      </Group>
      <Group grow align="flex-start">
        <TextInput
          label={t('request.eventName')}
          required
          value={form.event}
          onChange={(e) => setForm({ ...form, event: e.currentTarget.value })}
        />
        <TextInput
          label={t('request.eventStart')}
          type="date"
          value={form.start}
          onChange={(e) => setForm({ ...form, start: e.currentTarget.value })}
        />
        <TextInput
          label={t('request.eventEnd')}
          type="date"
          value={form.end}
          onChange={(e) => setForm({ ...form, end: e.currentTarget.value })}
        />
        <TextInput
          label={t('request.eventLocation')}
          value={form.location}
          onChange={(e) => setForm({ ...form, location: e.currentTarget.value })}
        />
      </Group>
      <TextInput
        label={t('manual.alreadySent')}
        type="datetime-local"
        value={form.sent}
        onChange={(e) => setForm({ ...form, sent: e.currentTarget.value })}
        description={t('manual.alreadySentHelp')}
      />
      <Textarea
        label={t('request.notes')}
        value={form.notes}
        onChange={(e) => setForm({ ...form, notes: e.currentTarget.value })}
      />

      <Title order={3}>{t('manual.individuals')}</Title>
      {items.map((it, n) => (
        <Card key={n} withBorder role="group" aria-label={t('manual.individual', { n: n + 1 })}>
          <Group grow align="flex-start">
            <TextInput
              label={t('manual.surname')}
              required
              value={it.surname}
              onChange={(e) => set(n, { surname: e.currentTarget.value })}
            />
            <TextInput
              label={t('manual.given')}
              value={given[n] ?? ''}
              onChange={(e) => setGiven(items.map((_, k) => (k === n ? e.currentTarget.value : (given[k] ?? ''))))}
            />
            <TextInput
              label={t('manual.dob')}
              type="date"
              value={it.dob ?? ''}
              onChange={(e) => set(n, { dob: e.currentTarget.value || null })}
            />
            <Select
              label={t('manual.sex')}
              data={[
                { value: 'M', label: t('manual.male') },
                { value: 'F', label: t('manual.female') },
              ]}
              value={it.sex}
              clearable
              onChange={(v) => set(n, { sex: (v as Sex | null) ?? null })}
            />
          </Group>
          <Group grow align="flex-start" mt="xs">
            <TextInput
              label={t('manual.unitName')}
              required
              value={it.unitName}
              onChange={(e) => set(n, { unitName: e.currentTarget.value })}
            />
            <Select
              label={t('manual.unitType')}
              data={(['Military', 'Police', 'Prison', 'Other'] as UnitType[]).map((u) => ({
                value: u,
                label: t(`unittype.${u}`),
              }))}
              value={it.unitType}
              allowDeselect={false}
              onChange={(v) => set(n, { unitType: (v as UnitType) ?? 'Other' })}
            />
            <TextInput
              label={t('manual.unitCountry')}
              value={it.unitCountry}
              onChange={(e) => set(n, { unitCountry: e.currentTarget.value })}
            />
            <TextInput
              label={t('manual.nationality')}
              value={it.nationality ?? ''}
              onChange={(e) => set(n, { nationality: e.currentTarget.value || null })}
            />
          </Group>
          <Group mt="xs">
            <Checkbox
              label={t('manual.head')}
              checked={it.isHeadOfUnit === true}
              onChange={(e) => set(n, { isHeadOfUnit: e.currentTarget.checked })}
            />
            {items.length > 1 && (
              <Button
                size="compact-sm"
                color="red"
                variant="subtle"
                onClick={() => {
                  setItems(items.filter((_, k) => k !== n));
                  setGiven(given.filter((_, k) => k !== n));
                }}
              >
                {t('manual.remove')}
              </Button>
            )}
          </Group>
        </Card>
      ))}
      <Group>
        <Button
          variant="default"
          onClick={() => {
            setItems([...items, blankItem()]);
            setGiven([...given, '']);
          }}
        >
          {t('manual.add')}
        </Button>
        <Button disabled={!valid} onClick={() => void submit()}>
          {t('manual.create')}
        </Button>
      </Group>
    </Stack>
  );
}
