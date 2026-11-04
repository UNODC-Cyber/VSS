import { Badge, Button, Group, MultiSelect, Stack, Text, TextInput } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { VettingStatus } from '@shared/domain/types';
import type { PersonSummary } from '@shared/ipc/contract';
import type { TFunction } from 'i18next';
import type { Col } from '../../components/DataTable';
import { col, DataTable } from '../../components/DataTable';
import { PageHeader, QueryBoundary, Sensitive, SimplePager, StatusBadge } from '../../components/common';
import { useAction, useQuery, vss } from '../../lib/api';
import { useUi } from '../../store';
import { fmtDate } from '../../lib/format';

const PAGE = 25;
const STATUSES: VettingStatus[] = ['unknown', 'pending', 'approved', 'expiring', 'expired', 'non-approved'];

/**
 * Reference case of the table engine (R13, docs/PLAN-ALPHA.md section 9): dates and status never wrap, the unit is
 * narrow with an ellipsis and a tooltip, the name is pinned and takes the spare width. Exported for the layout test.
 */
export const PERSON_COLUMNS = (t: TFunction): Col<PersonSummary>[] => [
  col<PersonSummary>(
    'name',
    t('people.name'),
    (p) => (
      <a href={`#/people/${p.id}`}>
        <Sensitive value={p.displayName} />
      </a>
    ),
    { sticky: 'first', minWidth: 200, grow: true, truncate: true, tooltip: (p) => p.displayName },
  ),
  col<PersonSummary>('dob', t('people.dob'), (p) => <Sensitive value={p.dob} />, { width: 112, nowrap: true }),
  col<PersonSummary>('nat', t('people.nationality'), (p) => p.nationality ?? '-', {
    width: 110,
    truncate: true,
    hideable: true,
    drop: 1,
    tooltip: (p) => p.nationality,
  }),
  col<PersonSummary>('unit', t('people.unit'), (p) => p.currentUnitName ?? '-', {
    minWidth: 160,
    grow: true,
    truncate: true,
    tooltip: (p) => p.currentUnitName,
  }),
  col<PersonSummary>('status', t('items.status'), (p) => <StatusBadge status={p.status} />, {
    minWidth: 150,
    nowrap: true,
  }),
  col<PersonSummary>('exp', t('items.expiry'), (p) => fmtDate(p.expiresAt), { width: 112, nowrap: true }),
  col<PersonSummary>(
    'rev',
    t('people.review'),
    (p) => (p.hasOpenReview ? <Badge color="orange">{t('people.openReview')}</Badge> : '-'),
    { width: 136, nowrap: true, hideable: true, drop: 2 },
  ),
];

export function PersonTable({ rows, caption }: { rows: PersonSummary[]; caption: string }) {
  const { t } = useTranslation();
  return (
    <DataTable<PersonSummary>
      caption={caption}
      data={rows}
      empty={t('people.empty')}
      rowId={(p) => p.id}
      tableId="people"
      emptyHint={t('ui.people.emptyHint')}
      columns={PERSON_COLUMNS(t)}
    />
  );
}

export function PeopleScreen() {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [statuses, setStatuses] = useState<string[]>([]);
  const [offset, setOffset] = useState(0);
  const q = useQuery(
    () =>
      vss().persons.list({
        offset,
        limit: PAGE,
        ...(submitted ? { text: submitted } : {}),
        statuses: statuses as VettingStatus[],
      }),
    [offset, submitted, statuses.join()],
  );
  const act = useAction();
  return (
    <Stack>
      <PageHeader
        title={t('people.title')}
        actions={
          <Button
            variant="default"
            onClick={async () => {
              const r = await act(vss().persons.scanDuplicates());
              if (r)
                useUi.getState().pushToast({ kind: 'info', message: t('people.scanDone', { count: r.pairsFound }) });
            }}
          >
            {t('people.scan')}
          </Button>
        }
      />
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(text);
          setOffset(0);
        }}
      >
        <Group align="flex-end">
          <TextInput
            label={t('people.searchLabel')}
            description={t('people.searchHelp')}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            w={360}
          />
          <MultiSelect
            label={t('items.status')}
            data={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
            value={statuses}
            onChange={(v) => {
              setStatuses(v);
              setOffset(0);
            }}
            clearable
            w={260}
          />
          <Button type="submit">{t('common.search')}</Button>
        </Group>
      </form>
      <QueryBoundary loading={q.loading && !q.data} error={q.error}>
        {q.data && (
          <>
            <Text size="sm" c="dimmed" role="status">
              {t('people.count', { count: q.data.total })}
            </Text>
            <PersonTable rows={q.data.items} caption={t('people.caption')} />
            <SimplePager total={q.data.total} offset={offset} limit={PAGE} onChange={setOffset} />
          </>
        )}
      </QueryBoundary>
    </Stack>
  );
}
