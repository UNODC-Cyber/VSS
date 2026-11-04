import { Button, Card, Group, Text, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { useAction, vss } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useUi } from '../../store';
import { useAppInfo } from '../useAppInfo';

export function UpdatesCard() {
  const { t } = useTranslation();
  const act = useAction();
  const upd = useUi((s) => s.update);
  const setUpdate = useUi((s) => s.setUpdate);
  const info = useAppInfo();
  // Alpha builds ship no updater: the card is replaced by one line (docs/PLAN-ALPHA.md section 12).
  if (info?.channel === 'alpha') {
    return (
      <Text size="sm" c="dimmed" role="status" data-testid="updates-alpha-note">
        {t('updates.alphaDisabled')}
      </Text>
    );
  }
  return (
    <Card withBorder>
      <Title order={2} size="h4">
        {t('settings.updates')}
      </Title>
      <Text size="sm" role="status" data-testid="updates-state">
        {t('settings.updateState', {
          version: upd?.currentVersion ?? '-',
          phase: upd ? t(`updphase.${upd.phase}`) : '-',
        })}
        {upd?.checkedAt
          ? ` (${t('settings.updateLastChecked', { at: fmtDateTime(upd.checkedAt, { zone: true }) })})`
          : ''}
      </Text>
      {/* A failed check is explained in plain words with a next step, never as a bare "error" (R2O-08 / R2S-05). */}
      {upd && (upd.phase === 'error' || upd.phase === 'verify-failed' || upd.phase === 'disabled') && (
        <Text size="sm" c="dimmed" mt={4} data-testid="updates-help">
          {t(`settings.updateHelp.${upd.phase}`)}
        </Text>
      )}
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
