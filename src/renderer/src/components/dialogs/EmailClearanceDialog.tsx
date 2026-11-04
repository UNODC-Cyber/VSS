/**
 * "Responded by email": record the vetting authority's e-mailed outcome. Nothing is pre-chosen (UI review O-04):
 * the user picks the outcome and whom it applies to (everyone, explicitly, or selected people), then sees a summary
 * of exactly what will be recorded for whom before anything is saved.
 */
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  Radio,
  Select,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RequestItem } from '@shared/domain/types';
import { useAction, vss } from '../../lib/api';
import { addDaysIso, todayIso } from '../../lib/format';
import { useUi } from '../../store';
import { Sensitive } from '../common';
import type { DialogProps } from './types';

type Outcome = 'approved' | 'non-approved';

const itemLabel = (i: RequestItem) => `${i.observed.surname}, ${i.observed.name1} (${i.observed.rowRef})`;

export function EmailClearanceDialog({ opened, onClose, request, onChanged }: DialogProps) {
  const { t } = useTranslation();
  const act = useAction();
  const days = useUi((s) => s.settings.emailClearanceDefaultDays);
  const [date, setDate] = useState(todayIso());
  const [scope, setScope] = useState<'all' | 'some' | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [disposition, setDisposition] = useState<Outcome | null>(null);
  /** Per-person outcome when it differs from the overall one (scope 'some'). */
  const [perItem, setPerItem] = useState<Record<string, Outcome>>({});
  const [expiry, setExpiry] = useState<string | null>(null); // null = assumed default
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const defaultExpiry = addDaysIso(date, days);
  const ids = scope === 'all' ? request.items.map((i) => i.id) : scope === 'some' ? picked : [];
  const outcomeOf = (id: string): Outcome | null => (scope === 'some' ? (perItem[id] ?? disposition) : disposition);
  const anyApproved = ids.some((id) => outcomeOf(id) === 'approved') || disposition === 'approved';
  const ready = disposition !== null && scope !== null && ids.length > 0 && date !== '';
  const items = request.items.filter((i) => ids.includes(i.id));

  const record = async () => {
    if (!disposition) return;
    setBusy(true);
    const r = await act(
      vss().responses.recordEmailClearance({
        requestId: request.id,
        itemIds: ids,
        certDate: date,
        expiresAt: expiry,
        disposition,
        ...(scope === 'some'
          ? {
              dispositions: Object.fromEntries(
                ids.filter((id) => perItem[id] && perItem[id] !== disposition).map((id) => [id, perItem[id]!]),
              ),
            }
          : {}),
        note,
      }),
      t('email.recorded', { count: ids.length }),
    );
    setBusy(false);
    if (r) {
      onChanged();
      onClose();
    }
  };

  const outcomeText = (o: Outcome | null) =>
    o === 'approved' ? t('email.approved') : o === 'non-approved' ? t('email.nonApproved') : '-';

  return (
    <Modal opened={opened} onClose={onClose} title={t('email.clearanceTitle')} size="lg" trapFocus returnFocus>
      {confirming ? (
        <Stack data-testid="clearance-summary">
          <Text fw={600}>{t('clearance.summaryTitle', { count: ids.length })}</Text>
          <Text size="sm">
            {t('clearance.summaryDates', {
              cert: date,
              expiry: anyApproved ? (expiry ?? defaultExpiry) : '-',
            })}
            {anyApproved && expiry === null ? ` ${t('clearance.summaryAssumed')}` : ''}
          </Text>
          <Table withTableBorder>
            <Table.Caption>{t('clearance.summaryCaption')}</Table.Caption>
            <Table.Thead>
              <Table.Tr>
                <Table.Th scope="col">{t('import.name')}</Table.Th>
                <Table.Th scope="col">{t('email.outcome')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {items.map((i) => (
                <Table.Tr key={i.id}>
                  <Table.Td>
                    <Sensitive value={itemLabel(i)} />
                  </Table.Td>
                  <Table.Td>{outcomeText(outcomeOf(i.id))}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          {scope === 'some' && request.items.length > ids.length && (
            <Text size="sm">{t('clearance.notIncluded', { count: request.items.length - ids.length })}</Text>
          )}
          <Group justify="flex-end">
            <Button variant="default" data-autofocus onClick={() => setConfirming(false)}>
              {t('clearance.back')}
            </Button>
            <Button loading={busy} onClick={() => void record()}>
              {t('email.record')}
            </Button>
          </Group>
        </Stack>
      ) : (
        <Stack>
          <Text size="sm">{t('clearance.intro')}</Text>
          <TextInput
            label={t('email.certDate')}
            type="date"
            data-autofocus
            value={date}
            onChange={(e) => setDate(e.currentTarget.value)}
          />
          <Radio.Group
            label={t('email.outcome')}
            description={t('clearance.outcomeHelp')}
            value={disposition ?? ''}
            onChange={(v) => setDisposition(v as Outcome)}
            required
          >
            <Group mt="xs">
              <Radio value="approved" label={t('email.approved')} />
              <Radio value="non-approved" label={t('email.nonApproved')} />
            </Group>
          </Radio.Group>
          <Radio.Group
            label={t('email.scope')}
            value={scope ?? ''}
            onChange={(v) => setScope(v as 'all' | 'some')}
            required
          >
            <Group mt="xs">
              <Radio value="all" label={t('clearance.everyone', { count: request.items.length })} />
              <Radio value="some" label={t('email.perPerson')} />
            </Group>
          </Radio.Group>
          {scope === 'some' && (
            <Stack gap={4} role="group" aria-label={t('email.perPerson')}>
              <Group gap="xs">
                <Button size="compact-xs" variant="default" onClick={() => setPicked(request.items.map((i) => i.id))}>
                  {t('clearance.selectAll')}
                </Button>
                <Button size="compact-xs" variant="default" onClick={() => setPicked([])}>
                  {t('clearance.selectNone')}
                </Button>
              </Group>
              {request.items.map((i) => {
                const label = itemLabel(i);
                return (
                  <Group key={i.id} justify="space-between" wrap="nowrap">
                    <Checkbox
                      label={label}
                      checked={picked.includes(i.id)}
                      onChange={(e) =>
                        setPicked(e.currentTarget.checked ? [...picked, i.id] : picked.filter((x) => x !== i.id))
                      }
                    />
                    {picked.includes(i.id) && (
                      <Select
                        size="xs"
                        w={170}
                        aria-label={t('email.outcomeFor', { name: label })}
                        allowDeselect={false}
                        placeholder={t('clearance.choose')}
                        value={perItem[i.id] ?? disposition}
                        data={[
                          { value: 'approved', label: t('email.approved') },
                          { value: 'non-approved', label: t('email.nonApproved') },
                        ]}
                        onChange={(v) => v && setPerItem({ ...perItem, [i.id]: v as Outcome })}
                      />
                    )}
                  </Group>
                );
              })}
            </Stack>
          )}
          {anyApproved && (
            <div>
              <TextInput
                label={t('email.expiry')}
                type="date"
                value={expiry ?? defaultExpiry}
                onChange={(e) => setExpiry(e.currentTarget.value || null)}
                description={expiry === null ? t('email.expiryAssumed', { days }) : t('email.expiryStated')}
              />
              {expiry === null && (
                <Badge color="yellow" mt={4} data-testid="expiry-assumed">
                  {t('email.assumedBadge')}
                </Badge>
              )}
            </div>
          )}
          <Textarea label={t('request.notes')} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
          {!ready && (
            <Alert color="gray" data-testid="clearance-missing">
              {disposition === null
                ? t('clearance.needOutcome')
                : scope === null
                  ? t('clearance.needScope')
                  : t('clearance.needPeople')}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button disabled={!ready} onClick={() => setConfirming(true)}>
              {t('clearance.review')}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
