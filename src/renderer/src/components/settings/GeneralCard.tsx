import { Card, NumberInput, Stack, Switch, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { asNum } from './types';
import type { SettingsDraftProps } from './types';

export function GeneralCard({ value: s, onChange: setS }: SettingsDraftProps) {
  const { t } = useTranslation();
  return (
    <Card withBorder>
      <Stack>
        <Title order={4}>{t('settings.general')}</Title>
        <NumberInput
          label={t('settings.autoLock')}
          min={1}
          max={120}
          value={s.autoLockMinutes}
          onChange={(v) => setS({ ...s, autoLockMinutes: asNum(v, s.autoLockMinutes) })}
        />
        <NumberInput
          label={t('settings.clipboardClear')}
          min={5}
          max={300}
          value={s.clipboardClearSeconds}
          onChange={(v) => setS({ ...s, clipboardClearSeconds: asNum(v, s.clipboardClearSeconds) })}
        />
        <NumberInput
          label={t('settings.emailDays')}
          description={t('settings.emailDaysHelp')}
          min={1}
          max={3650}
          value={s.emailClearanceDefaultDays}
          onChange={(v) => setS({ ...s, emailClearanceDefaultDays: asNum(v, s.emailClearanceDefaultDays) })}
        />
        <Switch
          label={t('settings.redaction')}
          description={t('settings.redactionHelp')}
          checked={s.redactionMode}
          onChange={(e) => setS({ ...s, redactionMode: e.currentTarget.checked })}
        />
        <Switch
          label={t('settings.updateCheck')}
          description={t('settings.updateCheckHelp')}
          checked={s.updateCheckEnabled}
          onChange={(e) => setS({ ...s, updateCheckEnabled: e.currentTarget.checked })}
        />
      </Stack>
    </Card>
  );
}
