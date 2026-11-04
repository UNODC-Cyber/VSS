/**
 * Edit in place (lane K, R12): correct a typo in a response row as received. Shows every change (now / after
 * saving) before saving and requires a reason; the DC original is kept by the service and can be restored.
 */
import { Button, Group, Modal, Select, SimpleGrid, Stack, Table, Text, TextInput, Textarea } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DispClass, ResponseRow } from '@shared/domain/types';
import type { ResponseRowPatch, ReviewItemDetail } from '@shared/ipc/contract';
import { useAction, vss } from '../../lib/api';
import { mask } from '../../lib/format';
import { useUi } from '../../store';
import { isCalendarIsoDate } from '@shared/domain/dob';

/** A real calendar day in YYYY-MM-DD (so 1995-20-07 is refused, UI review R2O-02). */
const ISO = { test: (s: string): boolean => isCalendarIsoDate(s) };
interface Form {
  nameRaw: string;
  dob: string;
  pobCountry: string;
  unitName: string;
  certDate: string;
  expires: string;
  dispClass: DispClass;
}
const formOf = (r: ResponseRow): Form => ({
  nameRaw: r.nameRaw,
  dob: r.dob.parsed ?? '',
  pobCountry: r.pob.country ?? '',
  unitName: r.unitName,
  certDate: r.certDate.parsed ?? '',
  expires: r.expires.parsed ?? '',
  dispClass: r.dispClass,
});
const DATE_FIELDS = ['dob', 'certDate', 'expires'] as const;

/** The patch for the fields that changed (dates: '' = no date). */
export function rowPatchOf(row: ResponseRow, f: Form): ResponseRowPatch {
  const o = formOf(row);
  const p: ResponseRowPatch = {};
  if (f.nameRaw.trim() !== o.nameRaw) p.nameRaw = f.nameRaw.trim();
  for (const k of DATE_FIELDS) if (f[k].trim() !== o[k]) p[k] = f[k].trim() === '' ? null : f[k].trim();
  if (f.pobCountry.trim() !== o.pobCountry)
    p.pob = { city: row.pob.city, state: row.pob.state, country: f.pobCountry.trim() || null };
  if (f.unitName.trim() !== o.unitName) p.unitName = f.unitName.trim();
  if (f.dispClass !== o.dispClass) p.dispClass = f.dispClass;
  return p;
}

export function EditRowDialog({
  opened,
  onClose,
  itemId,
  row,
  onDone,
}: {
  opened: boolean;
  onClose: () => void;
  itemId: string;
  row: ResponseRow | null;
  onDone: (d: ReviewItemDetail) => void;
}) {
  const { t } = useTranslation();
  const act = useAction();
  const redact = useUi((s) => s.settings.redactionMode);
  const [form, setForm] = useState<Form | null>(null);
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (opened && row) {
      setForm(formOf(row));
      setReason('');
    }
  }, [opened, row?.id]);
  if (!row || !form) return null;
  const set = (k: keyof Form) => (v: string) => setForm({ ...form, [k]: v });
  const patch = rowPatchOf(row, form);
  const before = formOf(row);
  const changed = (Object.keys(form) as (keyof Form)[]).filter((k) => form[k].trim() !== before[k]);
  const badDates = DATE_FIELDS.filter((k) => form[k].trim() !== '' && !ISO.test(form[k].trim()));
  const ready = changed.length > 0 && badDates.length === 0 && reason.trim().length >= 3;
  const label: Record<keyof Form, string> = {
    nameRaw: t('reviewAct.nameRaw'),
    dob: t('reviewAct.dob'),
    pobCountry: t('reviewAct.pobCountry'),
    unitName: t('reviewAct.unitName'),
    certDate: t('reviewAct.certDate'),
    expires: t('reviewAct.expires'),
    dispClass: t('reviewAct.dispClass'),
  };
  const show = (k: keyof Form, v: string) =>
    v === '' ? '-' : k === 'dispClass' ? t(`reviewAct.disp${dispLabel(v as DispClass)}`) : redact ? mask(v) : v;

  return (
    <Modal opened={opened} onClose={onClose} title={t('reviewAct.editRowTitle')} size="lg" trapFocus>
      <Stack>
        <Text size="sm">{t('reviewAct.editRowIntro')}</Text>
        <TextInput label={label.nameRaw} value={form.nameRaw} onChange={(e) => set('nameRaw')(e.currentTarget.value)} />
        <SimpleGrid cols={2}>
          {DATE_FIELDS.map((k) => (
            <TextInput
              key={k}
              label={label[k]}
              value={form[k]}
              onChange={(e) => set(k)(e.currentTarget.value)}
              error={badDates.includes(k) ? t('reviewAct.badDate') : undefined}
            />
          ))}
          <TextInput
            label={label.pobCountry}
            value={form.pobCountry}
            onChange={(e) => set('pobCountry')(e.currentTarget.value)}
          />
          <TextInput
            label={label.unitName}
            value={form.unitName}
            onChange={(e) => set('unitName')(e.currentTarget.value)}
          />
          <Select
            label={label.dispClass}
            value={form.dispClass}
            allowDeselect={false}
            onChange={(v) => v && set('dispClass')(v)}
            data={(['approved', 'non-approved', 'unknown'] as const).map((d) => ({
              value: d,
              label: t(`reviewAct.disp${dispLabel(d)}`),
            }))}
          />
        </SimpleGrid>
        <Table withTableBorder data-testid="edit-diff">
          <Table.Caption>{t('reviewAct.changes')}</Table.Caption>
          <Table.Thead>
            <Table.Tr>
              <Table.Th scope="col">{t('reviewAct.field')}</Table.Th>
              <Table.Th scope="col">{t('reviewAct.before')}</Table.Th>
              <Table.Th scope="col">{t('reviewAct.after')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {changed.length === 0 ? (
              <Table.Tr>
                <Table.Td colSpan={3}>{t('reviewAct.noChanges')}</Table.Td>
              </Table.Tr>
            ) : (
              changed.map((k) => (
                <Table.Tr key={k}>
                  <Table.Th scope="row">{label[k]}</Table.Th>
                  <Table.Td>{show(k, before[k])}</Table.Td>
                  <Table.Td>{show(k, form[k].trim())}</Table.Td>
                </Table.Tr>
              ))
            )}
          </Table.Tbody>
        </Table>
        <Textarea
          label={t('reviewAct.reason')}
          required
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
          rows={2}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={!ready}
            onClick={async () => {
              const r = await act(
                vss().review.editSubject({
                  id: itemId,
                  subject: { kind: 'response-row', rowId: row.id, patch },
                  reason: reason.trim(),
                }),
                t('reviewAct.saved'),
              );
              if (r) onDone(r);
            }}
          >
            {t('reviewAct.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

const dispLabel = (d: DispClass): 'Approved' | 'NonApproved' | 'Unknown' =>
  d === 'approved' ? 'Approved' : d === 'non-approved' ? 'NonApproved' : 'Unknown';
