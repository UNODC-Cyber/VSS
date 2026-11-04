import { Button, Card, Group, Stack, Text, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { useAction, vss } from '../../lib/api';
import { useAppInfo } from '../useAppInfo';

/** Version, schema, channel, licence pointer and the feedback button. Shown in Settings and in the Help > About dialog. */
export function AboutBody() {
  const { t } = useTranslation();
  const info = useAppInfo();
  const act = useAction();
  const unknown = t('alpha.unknown');
  return (
    <Stack gap="xs" data-testid="about-body">
      <Text size="sm">
        {t('alpha.version')}: <b data-testid="about-version">{info?.version ?? unknown}</b>
      </Text>
      <Text size="sm">
        {t('alpha.channel')}: {info ? t(`alpha.channelValue.${info.channel}`) : unknown}
      </Text>
      <Text size="sm">
        {t('alpha.schema')}: {info?.schemaVersion ?? unknown}
      </Text>
      <Text size="sm" c="dimmed">
        {t('alpha.licence')}
      </Text>
      <Text size="sm" c="dimmed">
        {t('alpha.feedbackHelp')}
      </Text>
      <Group>
        <Button variant="default" onClick={() => void act(vss().app.openFeedback(), t('alpha.feedbackOpened'))}>
          {t('alpha.feedbackLink')}
        </Button>
      </Group>
    </Stack>
  );
}

export function AboutCard() {
  const { t } = useTranslation();
  return (
    <Card withBorder id="card-about">
      <Title order={4} mb="xs">
        {t('alpha.aboutTitle')}
      </Title>
      <AboutBody />
    </Card>
  );
}
