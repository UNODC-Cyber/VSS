import { Button, Card, Group, PasswordInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';

/** Password re-entry + Save / Revert for the settings draft (settings.update is password-gated). */
export function SaveCard({
  password: pw,
  onPasswordChange: setPw,
  dirty,
  onSave: save,
  onRevert,
}: {
  password: string;
  onPasswordChange: (pw: string) => void;
  dirty: boolean;
  onSave: () => void;
  onRevert: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Card withBorder>
      <Group align="flex-end">
        <PasswordInput
          label={t('settings.reauth')}
          description={t('settings.reauthHelp')}
          value={pw}
          onChange={(e) => setPw(e.currentTarget.value)}
          autoComplete="current-password"
        />
        <Button disabled={!dirty || pw === ''} onClick={save}>
          {t('settings.save')}
        </Button>
        <Button variant="default" disabled={!dirty} onClick={onRevert}>
          {t('settings.revert')}
        </Button>
      </Group>
    </Card>
  );
}
