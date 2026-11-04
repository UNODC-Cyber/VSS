import { Badge, Button, Group, MultiSelect, Stack, Switch, TextInput } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RequestStatus } from '@shared/domain/types';
import type { RequestSummary } from '@shared/ipc/contract';
import { col, DataTable } from '../components/DataTable';
import { PageHeader, QueryBoundary, SimplePager } from '../components/common';
import { useQuery, vss } from '../lib/api';
import { fmtDate } from '../lib/format';
import { navigate } from '../lib/router';

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
