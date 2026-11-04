import { Button, Card, Group, PasswordInput, Title } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAction, vss } from '../../lib/api';
import { MIN_PASSWORD } from '../../screens/CreateVaultScreen';

export function PasswordCard() {
  const { t } = useTranslation();
  const act = useAction();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [conf, setConf] = useState('');
  const ok = cur !== '' && next.length >= MIN_PASSWORD && next === conf;
  return (
    <Card withBorder>
      <Title order={4}>{t('settings.changePassword')}</Title>
      <Group align="flex-end" mt="sm">
        <PasswordInput
          label={t('settings.currentPassword')}
          value={cur}
          onChange={(e) => setCur(e.currentTarget.value)}
          autoComplete="current-password"
        />
        <PasswordInput
          label={t('settings.newPassword')}
          value={next}
          onChange={(e) => setNext(e.currentTarget.value)}
          autoComplete="new-password"
          description={t('vault.guidanceLength', { min: MIN_PASSWORD })}
        />
        <PasswordInput
          label={t('vault.confirm')}
          value={conf}
          onChange={(e) => setConf(e.currentTarget.value)}
          autoComplete="new-password"
          error={conf !== '' && conf !== next ? t('vault.mismatch') : undefined}
        />
        <Button
          disabled={!ok}
          onClick={async () => {
            const r = await act(
              vss().vault.changePassword({ currentPassword: cur, newPassword: next }),
              t('settings.passwordChanged'),
            );
            setCur('');
            if (r) {
              setNext('');
              setConf('');
            }
          }}
        >
          {t('settings.changePassword')}
        </Button>
      </Group>
    </Card>
  );
}
