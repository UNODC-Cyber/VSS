import { Button, Group, Modal, Stack, Textarea, TextInput } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAction, vss } from '../../lib/api';
import type { DialogProps } from './types';

export function EditRequestDialog({ opened, onClose, request, onChanged }: DialogProps) {
  const { t } = useTranslation();
  const act = useAction();
  const [batch, setBatch] = useState(request.batchId ?? '');
  const [notes, setNotes] = useState(request.notes);
  return (
    <Modal opened={opened} onClose={onClose} title={t('request.edit')} trapFocus returnFocus>
      <Stack>
        <TextInput
          label={t('request.batchId')}
          data-autofocus
          value={batch}
          onChange={(e) => setBatch(e.currentTarget.value)}
        />
        <Textarea label={t('request.notes')} value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={async () => {
              const r = await act(
                vss().requests.update({ id: request.id, patch: { batchId: batch.trim() || null, notes } }),
                t('common.saved'),
              );
              if (r) {
                onChanged();
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
