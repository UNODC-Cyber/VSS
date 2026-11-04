import { Button, Card, Checkbox, Group, Select, Stack, Text, Textarea, TextInput, Title } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RequestorRecord, Sex, UnitType } from '@shared/domain/types';
import type { ManualRequestItemInput } from '@shared/ipc/contract';
import { PageHeader } from '../components/common';
import {
  affectedRequests,
  EMPTY_REQUESTOR,
  RequestorChoiceModal,
  RequestorField,
  toRequestor,
} from '../components/RequestorField';
import type { RequestorForm } from '../components/RequestorField';
import { useAction, vss } from '../lib/api';
import { navigate } from '../lib/router';

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
  const [requestor, setRequestor] = useState<RequestorForm>(EMPTY_REQUESTOR);
  const [saved, setSaved] = useState<RequestorRecord | null>(null);
  const [askCount, setAskCount] = useState<number | null>(null);
  const [form, setForm] = useState({
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
    requestor.name.trim() !== '' &&
    form.event.trim() !== '' &&
    items.length > 0 &&
    items.every((i) => i.surname.trim() && i.unitName.trim());

  const submit = async (choice?: 'update' | 'only-this-request') => {
    const affected = affectedRequests(requestor, saved);
    if (affected !== null && !choice) {
      setAskCount(affected);
      return;
    }
    setAskCount(null);
    const s = await act(
      vss().requests.createManual({
        requestor: toRequestor(requestor, choice),
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
    <Stack maw={720} component="form" onSubmit={(e: React.FormEvent) => e.preventDefault()}>
      <PageHeader title={t('manual.title')} />
      <Text c="dimmed">{t('manual.intro')}</Text>
      <RequestorField
        value={requestor}
        saved={saved}
        onChange={(next, rec) => {
          setRequestor(next);
          setSaved(rec);
        }}
      />
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
      <RequestorChoiceModal count={askCount} onChoose={(c) => void submit(c)} onCancel={() => setAskCount(null)} />
    </Stack>
  );
}
