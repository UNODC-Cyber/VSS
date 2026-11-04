import { Button, Group, Modal, Stack, TextInput } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PersonSummary } from '@shared/ipc/contract';
import { vss } from '../lib/api';
import { col, DataTable } from './DataTable';
import { Sensitive } from './common';

/** Search persons and pick one. */
export function PersonPicker({
  opened,
  title,
  onClose,
  onPick,
  excludeId,
}: {
  opened: boolean;
  title: string;
  onClose: () => void;
  onPick: (p: PersonSummary) => void;
  excludeId?: string;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [rows, setRows] = useState<PersonSummary[]>([]);
  const [searched, setSearched] = useState(false);
  const search = async () => {
    const r = await vss().persons.list({ offset: 0, limit: 20, text });
    setRows(r.ok ? r.value.items.filter((p) => p.id !== excludeId) : []);
    setSearched(true);
  };
  return (
    <Modal opened={opened} onClose={onClose} title={title} size="lg" trapFocus returnFocus>
      <Stack>
        <Group align="flex-end">
          <TextInput
            style={{ flex: 1 }}
            data-autofocus
            label={t('people.searchLabel')}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void search();
            }}
          />
          <Button onClick={() => void search()}>{t('common.search')}</Button>
        </Group>
        {searched && (
          <DataTable
            caption={t('people.pickerCaption')}
            data={rows}
            empty={t('common.none')}
            columns={[
              col<PersonSummary>('n', t('people.name'), (p) => p.displayName),
              col<PersonSummary>('d', t('people.dob'), (p) => <Sensitive value={p.dob} />),
              col<PersonSummary>('u', t('people.unit'), (p) => p.currentUnitName ?? '-'),
              col<PersonSummary>('a', '', (p) => (
                <Button
                  size="compact-sm"
                  onClick={() => onPick(p)}
                  aria-label={t('common.selectName', { name: p.displayName })}
                >
                  {t('common.select')}
                </Button>
              )),
            ]}
          />
        )}
      </Stack>
    </Modal>
  );
}
