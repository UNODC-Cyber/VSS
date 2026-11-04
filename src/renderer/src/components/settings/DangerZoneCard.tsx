import { Anchor, Button, Card, List, Stack, Text, Title } from '@mantine/core';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, vss } from '../../lib/api';
import { WipeDialog } from '../dialogs/WipeDialog';

/** Settings > Danger zone: Delete database (docs/PLAN-ALPHA.md section 15, R15). Always the last card. */
/** Memoised: it has no props, so typing in the Settings draft cards never re-renders it. */
export const DangerZoneCard = memo(function DangerZoneCard() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const backups = useQuery(() => vss().backup.list(), []);
  const hasBackupConfig = backups.data?.config != null;
  return (
    <Card withBorder id="card-danger" style={{ borderColor: 'var(--mantine-color-red-6)' }}>
      <Stack>
        <Title order={4} c="var(--mantine-color-red-text)">
          {t('danger.title')}
        </Title>
        <Text>{t('danger.intro')}</Text>
        <div>
          <Text fw={600}>{t('danger.deletedHeading')}</Text>
          <List size="sm">
            <List.Item>{t('danger.deleted.vault')}</List.Item>
            <List.Item>{t('danger.deleted.stored')}</List.Item>
            <List.Item>{t('danger.deleted.migration')}</List.Item>
          </List>
        </div>
        <div>
          <Text fw={600}>{t('danger.keptHeading')}</Text>
          <List size="sm">
            <List.Item>{t('danger.kept.exports')}</List.Item>
            <List.Item>{t('danger.kept.backups')}</List.Item>
          </List>
        </div>
        <Text size="sm">
          {t('danger.backupAdvice')} {/* Lane D's ScreenLink replaces this plain anchor once it lands. */}
          <Anchor href="#/settings?card=backup">{t('danger.backupLink')}</Anchor>
        </Text>
        <Text size="sm" c="dimmed">
          {t('danger.afterwards')}
        </Text>
        <div>
          <Button color="red" variant="outline" onClick={() => setOpen(true)}>
            {t('danger.open')}
          </Button>
        </div>
      </Stack>
      <WipeDialog opened={open} onClose={() => setOpen(false)} hasBackupConfig={hasBackupConfig} />
    </Card>
  );
});
