import { Alert, Badge, Button, Card, Group, Modal, PasswordInput, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { VettingStatus } from '@shared/domain/types';
import type { Dashboard, DashboardOutstandingRequest } from '@shared/ipc/contract';
import { col, DataTable } from '../components/DataTable';
import { PageHeader, QueryBoundary, Sensitive, StatusBadge } from '../components/common';
import { useAction, useQuery, vss } from '../lib/api';
import { fmtDate } from '../lib/format';

function Stat({ label, value, testId }: { label: string; value: string | number; testId?: string }) {
  return (
    <Card withBorder padding="sm">
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Title order={2} data-testid={testId}>
        {value}
      </Title>
    </Card>
  );
}

const num = (n: number | null) => (n === null ? '-' : n.toFixed(1));
const AGING_BUCKETS = ['0-7', '8-14', '15-30', '>30'] as const;

/** Password-gated CSV of upcoming expiries (holds personal data; saved only where the user picks). */
function ExpiryCsvButton() {
  const { t } = useTranslation();
  const act = useAction();
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState('');
  const run = async () => {
    const f = await act(
      vss().files.pickSave({ kind: 'csv', suggestedName: `vss-expiries-${new Date().toISOString().slice(0, 10)}.csv` }),
    );
    if (!f?.path) return;
    const r = await act(
      vss().stats.exportExpiryCsv({ withinDays: 90, password: pw, destPath: f.path }),
      t('dashboard.csvDone'),
    );
    setPw('');
    if (r) setOpen(false);
  };
  return (
    <>
      <Button variant="default" size="xs" onClick={() => setOpen(true)}>
        {t('dashboard.csv')}
      </Button>
      <Modal opened={open} onClose={() => setOpen(false)} title={t('dashboard.csv')} trapFocus returnFocus>
        <Stack>
          <Text size="sm">{t('dashboard.csvHelp')}</Text>
          <PasswordInput
            label={t('settings.reauth')}
            value={pw}
            onChange={(e) => setPw(e.currentTarget.value)}
            autoComplete="current-password"
            data-autofocus
          />
          <Group justify="flex-end">
            <Button disabled={pw === ''} onClick={() => void run()}>
              {t('dashboard.csvSave')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

function Body({ d }: { d: Dashboard }) {
  const { t } = useTranslation();
  const ta = d.turnaroundByKind;
  const months = d.perMonth.slice(-6);
  const max = Math.max(1, ...months.map((m) => m.received));
  const exp = d.expiringWithin;
  const backupDays = d.lastBackupAgeDays;

  return (
    <Stack>
      <PageHeader title={t('dashboard.title')} />
      {(backupDays === null || backupDays > 30) && (
        <Alert color="orange" role="status">
          {backupDays === null ? t('dashboard.noBackup') : t('dashboard.backupOld', { count: backupDays })}
        </Alert>
      )}
      <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }}>
        <Stat label={t('dashboard.outstanding')} value={d.outstandingRequests.length} testId="stat-outstanding" />
        <Stat label={t('dashboard.review')} value={d.openReviewItems} testId="stat-review" />
        <Stat label={t('dashboard.people')} value={d.totalPersons} testId="stat-people" />
        <Stat
          label={t('dashboard.lastBackup')}
          value={backupDays === null ? t('common.never') : t('common.daysAgo', { count: backupDays })}
          testId="stat-backup"
        />
      </SimpleGrid>

      <Title order={3}>{t('dashboard.outstandingTitle')}</Title>
      <Group role="group" aria-label={t('dashboard.aging')}>
        {AGING_BUCKETS.map((b) => (
          <Badge
            key={b}
            size="lg"
            variant="light"
            color={b === '>30' ? 'red' : b === '15-30' ? 'orange' : 'blue'}
            data-testid={`aging-${b}`}
          >
            {t('dashboard.bucket', { bucket: b, count: d.agingBuckets[b] })}
          </Badge>
        ))}
      </Group>
      <DataTable<DashboardOutstandingRequest>
        caption={t('dashboard.outstandingCaption')}
        data={d.outstandingRequests}
        empty={t('dashboard.noOutstanding')}
        rowId={(r) => r.requestId}
        columns={[
          col<DashboardOutstandingRequest>('e', t('requests.event'), (r) => (
            <a href={`#/requests/${r.requestId}`}>{r.eventName}</a>
          )),
          col<DashboardOutstandingRequest>('s', t('request.sent'), (r) => fmtDate(r.sentToDcAt.slice(0, 10))),
          col<DashboardOutstandingRequest>('a', t('requests.aging'), (r) => t('common.days', { count: r.agingDays })),
          col<DashboardOutstandingRequest>('i', t('requests.items'), (r) => `${r.answeredCount}/${r.itemCount}`),
        ]}
      />

      <Title order={3}>{t('dashboard.turnaround')}</Title>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Card withBorder>
          <Text fw={600}>{t('dashboard.viaFile')}</Text>
          <Text data-testid="ta-file">
            {t('dashboard.meanMedian', {
              n: ta.file.count,
              mean: num(ta.file.meanDays),
              median: num(ta.file.medianDays),
            })}
          </Text>
        </Card>
        <Card withBorder>
          <Text fw={600}>{t('dashboard.viaEmail')}</Text>
          <Text data-testid="ta-email">
            {t('dashboard.meanMedian', {
              n: ta.email.count,
              mean: num(ta.email.meanDays),
              median: num(ta.email.medianDays),
            })}
          </Text>
        </Card>
      </SimpleGrid>

      <Title order={3}>{t('dashboard.perMonth')}</Title>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label={t('dashboard.perMonth')}>
        {months.map((m) => (
          <li key={m.month} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <code style={{ width: 70 }}>{m.month}</code>
            <div
              style={{
                height: 12,
                width: `${(m.received / max) * 240}px`,
                minWidth: m.received ? 4 : 0,
                background: 'var(--mantine-color-blue-6)',
              }}
              aria-hidden="true"
            />
            <span data-testid={`month-${m.month}`}>{m.received}</span>
          </li>
        ))}
      </ul>

      <Group justify="space-between">
        <Title order={3}>{t('dashboard.expiring')}</Title>
        <ExpiryCsvButton />
      </Group>
      <Group>
        <Badge size="lg" variant="light" color="red" data-testid="exp-30">
          {t('dashboard.within', { days: 30, count: exp.d30 })}
        </Badge>
        <Badge size="lg" variant="light" color="orange" data-testid="exp-60">
          {t('dashboard.within', { days: 60, count: exp.d60 })}
        </Badge>
        <Badge size="lg" variant="light" color="yellow" data-testid="exp-90">
          {t('dashboard.within', { days: 90, count: exp.d90 })}
        </Badge>
      </Group>
      <ul>
        {d.expiringSoon.map((e) => (
          <li key={e.personId}>
            <a href={`#/people/${e.personId}`}>
              <Sensitive value={e.displayName} />
            </a>{' '}
            - {fmtDate(e.expiresAt)}
          </li>
        ))}
      </ul>

      <Title order={3}>{t('dashboard.statusCounts')}</Title>
      <Group>
        {(Object.keys(d.counts) as VettingStatus[]).map((s) => (
          <Group key={s} gap={4}>
            <StatusBadge status={s} />
            <Text size="sm">{d.counts[s]}</Text>
          </Group>
        ))}
      </Group>

      {d.inactivePersons.count > 0 && (
        <Alert
          color="gray"
          title={t('dashboard.inactiveTitle', { count: d.inactivePersons.count })}
          data-testid="inactive-hint"
        >
          <Text size="sm">{t('dashboard.inactiveHelp')}</Text>
          <ul style={{ margin: 0 }}>
            {d.inactivePersons.sample.map((p) => (
              <li key={p.personId}>
                <a href={`#/people/${p.personId}`}>
                  <Sensitive value={p.displayName} />
                </a>{' '}
                - {t('dashboard.lastActivity', { date: fmtDate(p.lastActivityAt) })}
              </li>
            ))}
          </ul>
        </Alert>
      )}
    </Stack>
  );
}

export function DashboardScreen() {
  const q = useQuery(() => vss().stats.dashboard({ sinceDays: 365 }), []);
  return (
    <QueryBoundary loading={q.loading && !q.data} error={q.error}>
      {q.data && <Body d={q.data} />}
    </QueryBoundary>
  );
}
