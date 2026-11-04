import { Badge, Button, Checkbox, Group, Modal, Radio, Select, Stack, Textarea, TextInput } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAction, vss } from '../../lib/api';
import { addDaysIso, todayIso } from '../../lib/format';
import { useUi } from '../../store';
import type { DialogProps } from './types';

export function EmailClearanceDialog({ opened, onClose, request, onChanged }: DialogProps) {
  const { t } = useTranslation();
  const act = useAction();
  const days = useUi((s) => s.settings.emailClearanceDefaultDays);
  const [date, setDate] = useState(todayIso());
  const [scope, setScope] = useState<'all' | 'some'>('all');
  const [picked, setPicked] = useState<string[]>([]);
  const [disposition, setDisposition] = useState<'approved' | 'non-approved'>('approved');
  /** Per-person outcome when it differs from the overall one (scope 'some'). */
  const [perItem, setPerItem] = useState<Record<string, 'approved' | 'non-approved'>>({});
  const [expiry, setExpiry] = useState<string | null>(null); // null = assumed default
  const [note, setNote] = useState('');
  const defaultExpiry = addDaysIso(date, days);
  const allIds = scope === 'all' ? request.items.map((i) => i.id) : picked;

  return (
    <Modal opened={opened} onClose={onClose} title={t('email.clearanceTitle')} size="lg" trapFocus returnFocus>
      <Stack>
        <TextInput
          label={t('email.certDate')}
          type="date"
          data-autofocus
          value={date}
          onChange={(e) => setDate(e.currentTarget.value)}
        />
        <Radio.Group
          label={t('email.outcome')}
          value={disposition}
          onChange={(v) => setDisposition(v as 'approved' | 'non-approved')}
        >
          <Group mt="xs">
            <Radio value="approved" label={t('email.approved')} />
            <Radio value="non-approved" label={t('email.nonApproved')} />
          </Group>
        </Radio.Group>
        <Radio.Group label={t('email.scope')} value={scope} onChange={(v) => setScope(v as 'all' | 'some')}>
          <Group mt="xs">
            <Radio value="all" label={t('email.allClear')} />
            <Radio value="some" label={t('email.perPerson')} />
          </Group>
        </Radio.Group>
        {scope === 'some' && (
          <Stack gap={4} role="group" aria-label={t('email.perPerson')}>
            {request.items.map((i) => {
              const label = `${i.observed.surname}, ${i.observed.name1} (${i.observed.rowRef})`;
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
                      value={perItem[i.id] ?? disposition}
                      data={[
                        { value: 'approved', label: t('email.approved') },
                        { value: 'non-approved', label: t('email.nonApproved') },
                      ]}
                      onChange={(v) => v && setPerItem({ ...perItem, [i.id]: v as 'approved' | 'non-approved' })}
                    />
                  )}
                </Group>
              );
            })}
          </Stack>
        )}
        {(disposition === 'approved' || Object.values(perItem).includes('approved')) && (
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
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={allIds.length === 0}
            onClick={async () => {
              const r = await act(
                vss().responses.recordEmailClearance({
                  requestId: request.id,
                  itemIds: allIds,
                  certDate: date,
                  expiresAt: expiry,
                  disposition,
                  ...(scope === 'some'
                    ? {
                        dispositions: Object.fromEntries(
                          allIds
                            .filter((id) => perItem[id] && perItem[id] !== disposition)
                            .map((id) => [id, perItem[id]!]),
                        ),
                      }
                    : {}),
                  note,
                }),
                t('email.recorded', { count: allIds.length }),
              );
              if (r) {
                onChanged();
                onClose();
              }
            }}
          >
            {t('email.record')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
