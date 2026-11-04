import { Button, Card, Group, List, Select, Stack, Text, TextInput } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { UnitType } from '@shared/domain/types';
import type { UnitDetail, UnitSummary } from '@shared/ipc/contract';
import { col, DataTable } from '../components/DataTable';
import { KeyValue, PageHeader, QueryBoundary, SimplePager } from '../components/common';
import { useAction, useQuery, vss } from '../lib/api';
import { fmtDate } from '../lib/format';

const PAGE = 25;

export function UnitsScreen() {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [type, setType] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const q = useQuery(
    () =>
      vss().units.list({ offset, limit: PAGE, ...(text ? { text } : {}), ...(type ? { type: type as UnitType } : {}) }),
    [offset, text, type],
  );
  return (
    <Stack>
      <PageHeader title={t('units.title')} />
      <Group align="flex-end">
        <TextInput
          label={t('units.search')}
          value={text}
          onChange={(e) => {
            setText(e.currentTarget.value);
            setOffset(0);
          }}
        />
        <Select
          label={t('units.type')}
          data={(['Military', 'Police', 'Prison', 'Other'] as UnitType[]).map((u) => ({
            value: u,
            label: t(`unittype.${u}`),
          }))}
          value={type}
          clearable
          onChange={(v) => {
            setType(v);
            setOffset(0);
          }}
        />
      </Group>
      <QueryBoundary loading={q.loading && !q.data} error={q.error}>
        {q.data && (
          <>
            <DataTable<UnitSummary>
              caption={t('units.caption')}
              data={q.data.items}
              empty={t('units.empty')}
              rowId={(u) => u.id}
              tableId="units"
              columns={[
                col<UnitSummary>('n', t('units.name'), (u) => <a href={`#/units/${u.id}`}>{u.name}</a>, {
                  sticky: 'first',
                  minWidth: 240,
                  grow: true,
                  truncate: true,
                  tooltip: (u) => u.name,
                }),
                col<UnitSummary>('t', t('units.type'), (u) => t(`unittype.${u.type}`), {
                  maxWidth: 180,
                  truncate: true,
                }),
                col<UnitSummary>('c', t('units.country'), (u) => u.country, {
                  width: 120,
                  truncate: true,
                  tooltip: (u) => u.country,
                }),
                col<UnitSummary>('p', t('units.people'), (u) => u.personCount, { width: 90, nowrap: true }),
                col<UnitSummary>(
                  'v',
                  t('units.lastVetting'),
                  (u) => (u.lastVetting ? fmtDate(u.lastVetting.certDate) : '-'),
                  { width: 130, nowrap: true },
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

function UnitBody({ d, reload }: { d: UnitDetail; reload: () => void }) {
  const { t } = useTranslation();
  const act = useAction();
  const [alias, setAlias] = useState('');
  const u = d.unit;
  return (
    <Stack>
      <PageHeader title={u.name} />
      <Card withBorder>
        <KeyValue
          rows={[
            [t('units.type'), t(`unittype.${u.type}`)],
            [t('units.country'), u.country],
            [t('units.location'), u.location ?? '-'],
            [t('units.people'), String(d.personIds.length)],
          ]}
        />
      </Card>
      <Card withBorder>
        <Text fw={600}>{t('units.aliases')}</Text>
        {u.aliases.length === 0 ? (
          <Text size="sm">{t('common.none')}</Text>
        ) : (
          <List>
            {u.aliases.map((a) => (
              <List.Item key={a}>{a}</List.Item>
            ))}
          </List>
        )}
        <Group mt="sm" align="flex-end">
          <TextInput label={t('units.newAlias')} value={alias} onChange={(e) => setAlias(e.currentTarget.value)} />
          <Button
            disabled={alias.trim() === ''}
            onClick={async () => {
              const r = await act(vss().units.addAlias({ id: u.id, alias: alias.trim() }), t('common.saved'));
              if (r) {
                setAlias('');
                reload();
              }
            }}
          >
            {t('units.addAlias')}
          </Button>
        </Group>
      </Card>
      <Text fw={600}>{t('units.vettingRecords')}</Text>
      {d.vettingRecords.length === 0 ? (
        <Text size="sm">{t('common.none')}</Text>
      ) : (
        <List>
          {d.vettingRecords.map((r) => (
            <List.Item key={r.id}>
              {t(`disp.${r.disposition}`)} - {fmtDate(r.certDate)} ({t('items.expiry')} {fmtDate(r.expiresAt)})
            </List.Item>
          ))}
        </List>
      )}
      <Text fw={600}>{t('units.people')}</Text>
      <Text size="sm">
        <a href={`#/search?q=${encodeURIComponent(u.name)}`}>{t('units.findPeople')}</a>
      </Text>
    </Stack>
  );
}

export function UnitDetailScreen({ id }: { id: string }) {
  const q = useQuery(() => vss().units.get({ id }), [id]);
  return (
    <QueryBoundary loading={q.loading && !q.data} error={q.error}>
      {q.data && <UnitBody d={q.data} reload={q.reload} />}
    </QueryBoundary>
  );
}
