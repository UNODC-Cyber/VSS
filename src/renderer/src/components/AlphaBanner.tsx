import { Alert, Anchor, CloseButton, Group, Text } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAction, vss } from '../lib/api';
import { useAppInfo } from './useAppInfo';

/** Top strip on alpha builds only. Dismissed for the session (component state; it returns after a restart). */
export function AlphaBanner() {
  const { t } = useTranslation();
  const info = useAppInfo();
  const act = useAction();
  const [hidden, setHidden] = useState(false);
  if (!info || info.channel !== 'alpha' || hidden) return null;
  return (
    <Alert
      role="status"
      color="yellow"
      variant="light"
      radius="sm"
      py={6}
      mb="sm"
      data-testid="alpha-banner"
      style={{ position: 'sticky', top: 60, zIndex: 20 }}
    >
      <Group justify="space-between" wrap="nowrap" gap="sm">
        <Text size="sm">
          {t('alpha.bannerText', { version: info.version })}{' '}
          <Anchor
            component="button"
            type="button"
            size="sm"
            onClick={() => void act(vss().app.openFeedback(), t('alpha.feedbackOpened'))}
          >
            {t('alpha.feedbackLink')}
          </Anchor>
        </Text>
        <CloseButton size="sm" aria-label={t('alpha.bannerDismiss')} onClick={() => setHidden(true)} />
      </Group>
    </Alert>
  );
}
