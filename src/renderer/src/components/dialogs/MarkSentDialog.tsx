import { Button, Group, Modal, Stack, TextInput } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAction, vss } from '../../lib/api';
import { localInputToIso, nowLocalInput } from '../../lib/format';
import type { DialogProps } from './types';

export function MarkSentDialog({ opened, onClose, request, onChanged }: DialogProps) {
  const { t } = useTranslation();
  const act = useAction();
  const [at, setAt] = useState(nowLocalInput());
  return (
    <Modal opened={opened} onClose={onClose} title={t('sent.title')} trapFocus returnFocus>
      <Stack>
        <TextInput
          label={t('sent.when')}
          type="datetime-local"
          data-autofocus
          value={at}
          onChange={(e) => setAt(e.currentTarget.value)}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={async () => {
              const r = await act(
                vss().requests.setStatus({ id: request.id, status: 'sent-to-dc', at: localInputToIso(at) }),
                t('sent.done'),
              );
              if (r) {
                onChanged();
                onClose();
              }
            }}
          >
            {t('sent.confirm')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
