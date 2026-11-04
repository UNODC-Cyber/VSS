import { Badge, Button, Group, MultiSelect, Stack, Switch, TextInput } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RequestStatus } from '@shared/domain/types';
import type { RequestSummary } from '@shared/ipc/contract';
import { col, DataTable } from '../components/DataTable';
import { RequestStatusBadge } from '../components/RequestStatusBadge';
import { PageHeader, QueryBoundary, SimplePager } from '../components/common';
import { useQuery, vss } from '../lib/api';
import { fmtDate } from '../lib/format';
import { navigate, useRoute } from '../lib/router';

const STATUSES: RequestStatus[] = [
  'received',
  'validated',
  'exported',
  'sent-to-dc',
  'responded',
  'finished',
  'closed',
  'withdrawn',
];
const PAGE = 25;

export function RequestsScreen() {
  const { t } = useTranslation();
  const initial = useRoute().query.get('status');
  const [statuses, setStatuses] = useState<string[]>(
    initial && (STATUSES as string[]).includes(initial) ? [initial] : [],
  );
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

  const filtered = statuses.length > 0 || from !== '' || to !== '' || text !== '' || outstanding;

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
      <Group gap="xs" role="group" aria-label={t('lifecycle.presets')}>
        <Button
          size="compact-sm"
          variant={statuses.length === 0 ? 'filled' : 'default'}
          aria-pressed={statuses.length === 0}
          onClick={() => {
            setStatuses([]);
            setOffset(0);
          }}
        >
          {t('lifecycle.allRequests')}
        </Button>
        <Button
          size="compact-sm"
          variant={statuses.join() === 'finished' ? 'filled' : 'default'}
          aria-pressed={statuses.join() === 'finished'}
          onClick={() => {
            setStatuses(['finished']);
            setOffset(0);
          }}
        >
          {t('lifecycle.needsClosing')}
        </Button>
      </Group>
      <Group align="flex-end" role="group" aria-label={t('requests.filters')}>
        <MultiSelect
          label={t('requests.status')}
          data={STATUSES.map((s) => ({ value: s, label: t(`reqstatus.${s}`) }))}
          value={statuses}
          placeholder={statuses.length === 0 ? t('emptyFlow.anyStatus') : undefined}
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
              // An empty vault is not "no match": say what to do first (UI review O-22).
              empty={filtered ? t('requests.empty') : t('emptyFlow.requests')}
              {...(filtered ? {} : { emptyHint: t('emptyFlow.requestsHint') })}
              rowId={(r) => r.id}
              tableId="requests"
              columns={[
                col<RequestSummary>(
                  'event',
                  t('requests.event'),
                  (r) => <a href={`#/requests/${r.id}`}>{r.eventName}</a>,
                  { sticky: 'first', minWidth: 220, grow: true, truncate: true, tooltip: (r) => r.eventName },
                ),
                col<RequestSummary>('received', t('requests.received'), (r) => fmtDate(r.receivedAt.slice(0, 10)), {
                  width: 120,
                  nowrap: true,
                }),
                col<RequestSummary>('requestor', t('requests.requestor'), (r) => r.requestor.name, {
                  maxWidth: 200,
                  truncate: true,
                  tooltip: (r) => r.requestor.name,
                }),
                col<RequestSummary>('status', t('requests.status'), (r) => <RequestStatusBadge status={r.status} />, {
                  minWidth: 150,
                  nowrap: true,
                }),
                col<RequestSummary>('items', t('requests.items'), (r) => `${r.answeredCount}/${r.itemCount}`, {
                  width: 88,
                  nowrap: true,
                }),
                col<RequestSummary>(
                  'issues',
                  t('requests.issues'),
                  (r) =>
                    r.unresolvedLinkCount + r.errorCount > 0 ? (
                      <Badge color="orange">{r.unresolvedLinkCount + r.errorCount}</Badge>
                    ) : (
                      '-'
                    ),
                  { width: 88, nowrap: true },
                ),
                col<RequestSummary>(
                  'aging',
                  t('requests.aging'),
                  (r) => (r.agingDays === null ? '-' : t('common.days', { count: r.agingDays })),
                  { width: 100, nowrap: true },
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
