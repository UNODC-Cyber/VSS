import { Button, Card, Group, Text, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { useAction, vss } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useUi } from '../../store';

export function UpdatesCard() {
  const { t } = useTranslation();
  const act = useAction();
  const upd = useUi((s) => s.update);
  const setUpdate = useUi((s) => s.setUpdate);
  return (
    <Card withBorder>
      <Title order={4}>{t('settings.updates')}</Title>
      <Text size="sm" role="status">
        {t('settings.updateState', {
          version: upd?.currentVersion ?? '-',
          phase: upd ? t(`updphase.${upd.phase}`) : '-',
        })}
        {upd?.checkedAt ? ` (${fmtDateTime(upd.checkedAt)})` : ''}
      </Text>
      <Group mt="sm">
        <Button
          variant="default"
          onClick={async () => {
            const r = await act(vss().updates.check());
            if (r) setUpdate(r);
          }}
        >
          {t('settings.checkNow')}
        </Button>
        {upd?.phase === 'available' && (
          <Button
            onClick={async () => {
              const r = await act(vss().updates.download());
              if (r) setUpdate(r);
            }}
          >
            {t('settings.download')}
          </Button>
        )}
        {upd?.phase === 'verified' && (
          <Button onClick={() => void act(vss().updates.install())}>{t('settings.install')}</Button>
        )}
      </Group>
    </Card>
  );
}
