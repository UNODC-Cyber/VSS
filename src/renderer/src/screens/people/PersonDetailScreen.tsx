import {
  Badge,
  Button,
  Card,
  Checkbox,
  PasswordInput,
  Group,
  List,
  Modal,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  Timeline,
  Title,
} from '@mantine/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { latestRecord } from '@shared/domain/status';
import type { VettingRecord } from '@shared/domain/types';
import type { MergeLogEntry, PersonDetail, PersonSummary, RequestSummary } from '@shared/ipc/contract';
import { col, DataTable } from '../../components/DataTable';
import { DobValue } from '../../components/DobValue';
import {
  CopyButton,
  KeyValue,
  PageHeader,
  QueryBoundary,
  ReasonDialog,
  Sensitive,
  StatusBadge,
} from '../../components/common';
import { PersonPicker } from '../../components/PersonPicker';
import { useAction, useQuery, vss } from '../../lib/api';
import { fmtDate, fmtDateTime, fmtLocalDate, todayIso } from '../../lib/format';
import { navigate } from '../../lib/router';

/**
 * The line next to the status badge (UI review O-28 / S-32): the status is computed for today, from the latest
 * record, so the line names both (never "APPROVED as of <today>", which read like the approval date).
 */
export function statusBasis(
  t: (k: string, o?: Record<string, unknown>) => string,
  d: Pick<PersonDetail, 'statusAsOf' | 'records'>,
): string {
  const rec = latestRecord(d.records);
  const today = t('personFlow.checkedOn', { date: d.statusAsOf });
  if (!rec) return `${today} ${t('personFlow.noRecord')}`;
  return `${today} ${t(rec.expiresAt ? 'personFlow.basedOn' : 'personFlow.basedOnNoExpiry', {
    disp: t(`disp.${rec.disposition}`),
    cert: fmtDate(rec.certDate),
    expires: fmtDate(rec.expiresAt),
  })}${rec.expiryAssumed ? ` ${t('personFlow.assumed')}` : ''}`;
}

function RecordDialog({ personId, onClose, onSaved }: { personId: string; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const act = useAction();
  const [disp, setDisp] = useState<VettingRecord['disposition']>('approved');
  const [cert, setCert] = useState(todayIso());
  const [exp, setExp] = useState('');
  const [note, setNote] = useState('');
  return (
    <Modal opened onClose={onClose} title={t('person.recordTitle')} trapFocus returnFocus>
      <Stack>
        <Select
          label={t('person.disposition')}
          data={(['approved', 'non-approved', 'email-cleared'] as const).map((d) => ({
            value: d,
            label: t(`disp.${d}`),
          }))}
          value={disp}
          allowDeselect={false}
          onChange={(v) => v && setDisp(v as VettingRecord['disposition'])}
          data-autofocus
        />
        <TextInput
          label={t('email.certDate')}
          type="date"
          value={cert}
          onChange={(e) => setCert(e.currentTarget.value)}
        />
        <TextInput label={t('email.expiry')} type="date" value={exp} onChange={(e) => setExp(e.currentTarget.value)} />
        <Textarea label={t('request.notes')} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={async () => {
              const r = await act(
                vss().responses.recordManual({
                  personId,
                  unitId: null,
                  disposition: disp,
                  certDate: cert || null,
                  expiresAt: exp || null,
                  note,
                }),
                t('person.recorded'),
              );
              if (r) {
                onSaved();
                onClose();
              }
            }}
          >
            {t('common.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Move request items that belong to someone else off this person (a new person is created; undo via merge history). */
function SplitDialog({ d, onClose }: { d: PersonDetail; onClose: () => void }) {
  const { t } = useTranslation();
  const act = useAction();
  const [items, setItems] = useState<{ id: string; label: string }[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  useEffect(() => {
    void Promise.all(d.requests.map((r) => vss().requests.get({ id: r.id }))).then((rs) =>
      setItems(
        rs.flatMap((r) =>
          r.ok
            ? r.value.items
                .filter((i) => i.personId === d.person.id)
                .map((i) => ({
                  id: i.id,
                  label: `${r.value.eventName}: ${i.observed.surname}, ${i.observed.name1} (${i.observed.rowRef})`,
                }))
            : [],
        ),
      ),
    );
  }, [d]);
  const tooMany = items !== null && picked.length >= items.length;
  return (
    <Modal opened onClose={onClose} title={t('person.splitOffTitle')} size="lg" trapFocus returnFocus>
      <Stack>
        <Text size="sm">{t('person.splitOffIntro')}</Text>
        {items?.map((i) => (
          <Checkbox
            key={i.id}
            label={<Sensitive value={i.label} />}
            checked={picked.includes(i.id)}
            onChange={(e) => setPicked(e.currentTarget.checked ? [...picked, i.id] : picked.filter((x) => x !== i.id))}
          />
        ))}
        {tooMany && (
          <Text size="sm" c="red">
            {t('person.splitKeepOne')}
          </Text>
        )}
        <TextInput label={t('common.reason')} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            color="red"
            disabled={picked.length === 0 || tooMany || reason.trim().length < 3}
            onClick={async () => {
              const r = await act(
                vss().persons.split({ personId: d.person.id, itemIds: picked, reason: reason.trim() }),
                t('person.splitOffDone'),
              );
              if (r) {
                onClose();
                navigate(`/people/${r.person.id}`);
              }
            }}
          >
            {t('person.splitOff')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Manual retention tool: permanently removes one person (password required). Nothing is ever purged automatically. */
function PurgeDialog({ personId, onClose }: { personId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const act = useAction();
  const [pw, setPw] = useState('');
  return (
    <Modal opened onClose={onClose} title={t('person.purgeTitle')} trapFocus returnFocus>
      <Stack>
        <Text size="sm">{t('person.purgeIntro')}</Text>
        <PasswordInput
          label={t('settings.reauth')}
          value={pw}
          onChange={(e) => setPw(e.currentTarget.value)}
          autoComplete="current-password"
          data-autofocus
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            color="red"
            disabled={pw === ''}
            onClick={async () => {
              const r = await act(vss().persons.purge({ id: personId, password: pw }), t('person.purged'));
              setPw('');
              if (r) {
                onClose();
                navigate('/people');
              }
            }}
          >
            {t('person.purge')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function PersonBody({ d, reload }: { d: PersonDetail; reload: () => void }) {
  const { t } = useTranslation();
  const act = useAction();
  const p = d.person;
  const [picker, setPicker] = useState(false);
  const [mergeWith, setMergeWith] = useState<PersonSummary | null>(null);
  const [splitting, setSplitting] = useState<MergeLogEntry | null>(null);
  const [record, setRecord] = useState(false);
  const [splitOff, setSplitOff] = useState(false);
  const [purge, setPurge] = useState(false);
  const name = `${p.canonical.surname}, ${p.canonical.given.join(' ')}`;
  const unitName = (id: string | null) => d.units.find((u) => u.id === id)?.name ?? '-';

  return (
    <Stack>
      <PageHeader
        title={name}
        actions={
          <>
            <Button variant="default" onClick={() => setRecord(true)}>
              {t('person.recordManual')}
            </Button>
            <Button variant="default" onClick={() => setPicker(true)}>
              {t('person.mergeAnother')}
            </Button>
            {d.requests.length > 0 && (
              <Button variant="default" onClick={() => setSplitOff(true)}>
                {t('person.splitOff')}
              </Button>
            )}
            <Button variant="subtle" color="red" onClick={() => setPurge(true)}>
              {t('person.purge')}
            </Button>
          </>
        }
      />
      <Group>
        <StatusBadge status={d.status} />
        <Text size="sm" c="dimmed" data-testid="person-status-basis">
          {statusBasis(t, d)}
        </Text>
        {d.openReviewItemIds.map((id) => (
          <a key={id} href={`#/review/${id}`}>
            <Badge color="orange">{t('person.openReviewLink')}</Badge>
          </a>
        ))}
      </Group>
      <Card withBorder>
        <KeyValue
          rows={[
            [t('people.dob'), <DobValue key="d" parsed={p.dob} showRaw={false} />],
            [t('person.sex'), p.sex ?? '-'],
            [t('people.nationality'), p.nationality ?? '-'],
            [t('person.pob'), [p.pob.city, p.pob.state, p.pob.country].filter(Boolean).join(', ') || '-'],
            [t('request.notes'), p.notes || '-'],
          ]}
        />
      </Card>
      <Card withBorder>
        <Title order={2} size="h4">
          {t('person.aliases')}
        </Title>
        {p.aliases.length === 0 ? (
          <Text size="sm">{t('common.none')}</Text>
        ) : (
          <List>
            {p.aliases.map((a, i) => (
              <List.Item key={i}>
                <Sensitive value={a.raw} />
              </List.Item>
            ))}
          </List>
        )}
        <Title order={2} size="h4" mt="sm">
          {t('person.identifiers')}
        </Title>
        {p.identifiers.length === 0 ? (
          <Text size="sm">{t('common.none')}</Text>
        ) : (
          <List>
            {p.identifiers.map((i, n) => (
              <List.Item key={n}>
                <Group gap={6}>
                  <Text size="sm" component="span">
                    {t(`idtype.${i.type}`)}:
                  </Text>
                  <Sensitive value={i.value} />
                  <CopyButton text={i.value} label={t(`idtype.${i.type}`)} />
                </Group>
              </List.Item>
            ))}
          </List>
        )}
      </Card>

      <Title order={2} size="h3">
        {t('person.history')}
      </Title>
      {d.records.length === 0 ? (
        <Text>{t('person.noHistory')}</Text>
      ) : (
        <Timeline bulletSize={14} active={d.records.length} aria-label={t('person.history')}>
          {d.records.map((r) => (
            <Timeline.Item key={r.id} title={`${t(`disp.${r.disposition}`)} - ${fmtDate(r.certDate)}`}>
              <Text size="sm">
                {t('person.historyLine', {
                  unit: unitName(r.unitId),
                  expires: fmtDate(r.expiresAt),
                  source: t(`source.${r.source}`),
                })}
                {r.expiryAssumed && (
                  <Badge ml={6} color="yellow">
                    {t('email.assumedBadge')}
                  </Badge>
                )}
              </Text>
              {r.note && (
                <Text size="xs" c="dimmed">
                  {r.note}
                </Text>
              )}
            </Timeline.Item>
          ))}
        </Timeline>
      )}

      <Title order={2} size="h3">
        {t('person.requests')}
      </Title>
      <DataTable<RequestSummary>
        caption={t('person.requestsCaption')}
        data={d.requests}
        empty={t('common.none')}
        rowId={(r) => r.id}
        columns={[
          col<RequestSummary>('e', t('requests.event'), (r) => <a href={`#/requests/${r.id}`}>{r.eventName}</a>, {
            sticky: 'first',
            minWidth: 220,
            grow: true,
            truncate: true,
            tooltip: (r) => r.eventName,
          }),
          col<RequestSummary>('r', t('requests.received'), (r) => fmtLocalDate(r.receivedAt), {
            width: 120,
            nowrap: true,
          }),
          col<RequestSummary>('s', t('requests.status'), (r) => t(`reqstatus.${r.status}`), {
            minWidth: 150,
            nowrap: true,
          }),
        ]}
      />

      <Title order={2} size="h3">
        {t('person.units')}
      </Title>
      <List>
        {d.units.map((u) => (
          <List.Item key={u.id}>
            <a href={`#/units/${u.id}`}>{u.name}</a>
          </List.Item>
        ))}
        {d.units.length === 0 && <Text size="sm">{t('common.none')}</Text>}
      </List>

      <Title order={2} size="h3">
        {t('person.mergeHistory')}
      </Title>
      {d.mergeHistory.length === 0 ? (
        <Text size="sm">{t('common.none')}</Text>
      ) : (
        <DataTable<MergeLogEntry>
          caption={t('person.mergeHistory')}
          data={d.mergeHistory}
          rowId={(m) => m.id}
          columns={[
            col<MergeLogEntry>('at', t('audit.time'), (m) => fmtDateTime(m.at), { width: 170, nowrap: true }),
            col<MergeLogEntry>('reason', t('common.reason'), (m) => m.reason, {
              minWidth: 220,
              grow: true,
              truncate: true,
              tooltip: (m) => m.reason,
            }),
            col<MergeLogEntry>(
              'split',
              '',
              (m) =>
                m.survivorId === p.id ? (
                  <Button size="compact-xs" color="red" variant="light" onClick={() => setSplitting(m)}>
                    {t('person.split')}
                  </Button>
                ) : (
                  <Text size="xs">{t('person.mergedInto')}</Text>
                ),
              { width: 140, nowrap: true },
            ),
          ]}
        />
      )}

      <PersonPicker
        opened={picker}
        title={t('person.mergePickTitle')}
        excludeId={p.id}
        onClose={() => setPicker(false)}
        onPick={(x) => {
          setPicker(false);
          setMergeWith(x);
        }}
      />
      <ReasonDialog
        opened={mergeWith !== null}
        title={t('person.mergeConfirm', { name: mergeWith?.displayName ?? '' })}
        confirmLabel={t('person.merge')}
        onClose={() => setMergeWith(null)}
        onConfirm={async (reason) => {
          if (!mergeWith) return;
          const r = await act(
            vss().persons.merge({ survivorId: p.id, mergedId: mergeWith.id, reason }),
            t('person.merged'),
          );
          setMergeWith(null);
          if (r) reload();
        }}
      />
      <ReasonDialog
        opened={splitting !== null}
        title={t('person.splitConfirm')}
        confirmLabel={t('person.split')}
        onClose={() => setSplitting(null)}
        onConfirm={async (reason) => {
          if (!splitting) return;
          const r = await act(vss().persons.unmerge({ mergeLogId: splitting.id, reason }), t('person.splitDone'));
          setSplitting(null);
          if (r) reload();
        }}
      />
      {record && <RecordDialog personId={p.id} onClose={() => setRecord(false)} onSaved={reload} />}
      {splitOff && <SplitDialog d={d} onClose={() => setSplitOff(false)} />}
      {purge && <PurgeDialog personId={p.id} onClose={() => setPurge(false)} />}
    </Stack>
  );
}

export function PersonDetailScreen({ id }: { id: string }) {
  const q = useQuery(() => vss().persons.get({ id }), [id]);
  return (
    <QueryBoundary loading={q.loading && !q.data} error={q.error}>
      {q.data && <PersonBody d={q.data} reload={q.reload} />}
    </QueryBoundary>
  );
}
