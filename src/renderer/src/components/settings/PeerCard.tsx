import { Alert, Card, Stack, Switch, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { SettingsDraftProps } from './types';

export function PeerCard({ value: s, onChange: setS }: SettingsDraftProps) {
  const { t } = useTranslation();
  return (
    <Card withBorder>
      <Stack>
        <Title order={2} size="h4">
          {t('settings.peer')}
        </Title>
        <Switch
          label={t('settings.peerMode')}
          checked={s.peerModeEnabled}
          onChange={(e) => setS({ ...s, peerModeEnabled: e.currentTarget.checked })}
        />
        {s.peerModeEnabled && (
          <Alert color="red" title={t('settings.peerWarningTitle')}>
            {t('settings.peerWarning')}
          </Alert>
        )}
      </Stack>
    </Card>
  );
}
