import { Button, Group, Stack, Text, TextInput, Title } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RequestSummary, UnitSummary } from '@shared/ipc/contract';
import { col, DataTable } from '../components/DataTable';
import { PageHeader, QueryBoundary } from '../components/common';
import { useQuery, vss } from '../lib/api';
import { fmtLocalDate } from '../lib/format';
import { PersonTable } from './people/PeopleScreen';

/** Global search: people (any field), requests and units for one query. */
export function SearchScreen({ initial }: { initial: string }) {
  const { t } = useTranslation();
  const [text, setText] = useState(initial);
  const [submitted, setSubmitted] = useState(initial);
  const people = useQuery(
    () =>
      submitted
        ? vss().persons.list({ offset: 0, limit: 50, text: submitted })
        : Promise.resolve({ ok: true as const, value: { items: [], total: 0, offset: 0, limit: 50 } }),
    [submitted],
  );
  const requests = useQuery(
    () =>
      submitted
        ? vss().requests.list({ offset: 0, limit: 50, text: submitted })
        : Promise.resolve({ ok: true as const, value: { items: [], total: 0, offset: 0, limit: 50 } }),
    [submitted],
  );
  const units = useQuery(
    () =>
      submitted
        ? vss().units.list({ offset: 0, limit: 50, text: submitted })
        : Promise.resolve({ ok: true as const, value: { items: [], total: 0, offset: 0, limit: 50 } }),
    [submitted],
  );
  return (
    <Stack>
      <PageHeader title={t('search.title')} />
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(text.trim());
        }}
      >
        <Group align="flex-end">
          <TextInput
            label={t('search.label')}
            description={t('people.searchHelp')}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            w={420}
            data-autofocus
          />
          <Button type="submit">{t('common.search')}</Button>
        </Group>
      </form>
      {submitted === '' ? (
        <Text c="dimmed">{t('search.prompt')}</Text>
      ) : (
        <>
          <Title order={3}>{t('search.people', { count: people.data?.total ?? 0 })}</Title>
          <QueryBoundary loading={people.loading && !people.data} error={people.error}>
            {people.data && <PersonTable rows={people.data.items} caption={t('people.caption')} context="search" />}
          </QueryBoundary>
          <Title order={3}>{t('search.requests', { count: requests.data?.total ?? 0 })}</Title>
          <QueryBoundary loading={requests.loading && !requests.data} error={requests.error}>
            {requests.data && (
              <DataTable<RequestSummary>
                caption={t('requests.caption')}
                data={requests.data.items}
                empty={t('requests.empty')}
                rowId={(r) => r.id}
                columns={[
                  col<RequestSummary>('e', t('requests.event'), (r) => (
                    <a href={`#/requests/${r.id}`}>{r.eventName}</a>
                  )),
                  col<RequestSummary>('d', t('requests.received'), (r) => fmtLocalDate(r.receivedAt), {
                    width: 120,
                    nowrap: true,
                  }),
                  col<RequestSummary>('r', t('requests.requestor'), (r) => r.requestor.name, {
                    maxWidth: 200,
                    truncate: true,
                    tooltip: (r) => r.requestor.name,
                  }),
                ]}
              />
            )}
          </QueryBoundary>
          <Title order={3}>{t('search.units', { count: units.data?.total ?? 0 })}</Title>
          <QueryBoundary loading={units.loading && !units.data} error={units.error}>
            {units.data && (
              <DataTable<UnitSummary>
                caption={t('units.caption')}
                data={units.data.items}
                empty={t('units.empty')}
                rowId={(u) => u.id}
                columns={[
                  col<UnitSummary>('n', t('units.name'), (u) => <a href={`#/units/${u.id}`}>{u.name}</a>),
                  col<UnitSummary>('t', t('units.type'), (u) => t(`unittype.${u.type}`), {
                    maxWidth: 180,
                    truncate: true,
                  }),
                ]}
              />
            )}
          </QueryBoundary>
        </>
      )}
    </Stack>
  );
}
