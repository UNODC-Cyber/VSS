/**
 * Correct the person a review item is about (lane K, R12): name, date of birth, country of birth. Shows the changes
 * before saving and requires a reason; the service records the previous values (person_edit).
 */
import { Button, Group, Modal, SimpleGrid, Stack, Table, Textarea, TextInput } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Person } from '@shared/domain/types';
import type { PersonPatch, ReviewItemDetail } from '@shared/ipc/contract';
import { useAction, vss } from '../../lib/api';
import { mask } from '../../lib/format';
import { useUi } from '../../store';
import { isCalendarIsoDate } from '@shared/domain/dob';

/** A real calendar day in YYYY-MM-DD (so 1995-20-07 is refused, UI review R2O-02). */
const ISO = { test: (s: string): boolean => isCalendarIsoDate(s) };
interface Form {
  surname: string;
  given: string;
  dob: string;
  pobCountry: string;
}
const formOf = (p: Person): Form => ({
  surname: p.canonical.surname,
  given: p.canonical.given.join(' '),
  dob: p.dob ?? '',
  pobCountry: p.pob.country ?? '',
});

export function personPatchOf(p: Person, f: Form): PersonPatch['patch'] {
  const o = formOf(p);
  const out: PersonPatch['patch'] = {};
  if (f.surname.trim() !== o.surname || f.given.trim() !== o.given) {
    const given = f.given.trim().split(/\s+/).filter(Boolean);
    const surname = f.surname.trim();
    out.canonical = {
      surname,
      given,
      raw: given.length ? `${surname}, ${given.join(' ')}` : surname,
      script: p.canonical.script,
    };
  }
  if (f.dob.trim() !== o.dob) out.dob = f.dob.trim() === '' ? null : f.dob.trim();
  if (f.pobCountry.trim() !== o.pobCountry) out.pob = { ...p.pob, country: f.pobCountry.trim() || null };
  return out;
}

export function EditPersonDialog({
  opened,
  onClose,
  itemId,
  personId,
  onDone,
}: {
  opened: boolean;
  onClose: () => void;
  itemId: string;
  personId: string | null;
  onDone: (d: ReviewItemDetail) => void;
}) {
  const { t } = useTranslation();
  const act = useAction();
  const redact = useUi((s) => s.settings.redactionMode);
  const [person, setPerson] = useState<Person | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (!opened || !personId) return;
    setReason('');
    void vss()
      .persons.get({ id: personId })
      .then((r) => {
        if (r.ok) {
          setPerson(r.value.person);
          setForm(formOf(r.value.person));
        }
      });
  }, [opened, personId]);
  if (!opened || !person || !form) return null;
  const before = formOf(person);
  const label: Record<keyof Form, string> = {
    surname: t('reviewAct.surname'),
    given: t('reviewAct.given'),
    dob: t('reviewAct.dob'),
    pobCountry: t('reviewAct.pobCountry'),
  };
  const changed = (Object.keys(form) as (keyof Form)[]).filter((k) => form[k].trim() !== before[k]);
  const badDob = form.dob.trim() !== '' && !ISO.test(form.dob.trim());
  const ready = changed.length > 0 && !badDob && reason.trim().length >= 3;
  const show = (v: string) => (v === '' ? '-' : redact ? mask(v) : v);
  return (
    <Modal opened={opened} onClose={onClose} title={t('reviewAct.editPersonTitle')} size="lg" trapFocus>
      <Stack>
        <SimpleGrid cols={2}>
          {(Object.keys(form) as (keyof Form)[]).map((k) => (
            <TextInput
              key={k}
              label={label[k]}
              value={form[k]}
              onChange={(e) => setForm({ ...form, [k]: e.currentTarget.value })}
              error={k === 'dob' && badDob ? t('reviewAct.badDate') : undefined}
            />
          ))}
        </SimpleGrid>
        <Table withTableBorder data-testid="edit-person-diff">
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
                  <Table.Td>{show(before[k])}</Table.Td>
                  <Table.Td>{show(form[k].trim())}</Table.Td>
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
                  subject: { kind: 'person', personId: person.id, patch: personPatchOf(person, form) },
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
