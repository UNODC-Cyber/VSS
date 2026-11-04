import { Button, Card, Group, SegmentedControl, Stack, Text, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { useTableState } from '../ui/tableState';
import type { SettingsDraftProps } from './types';

/** Row density and table column memory. Edits the settings draft; stored together by SaveCard. */
export function AppearanceCard({ value: s, onChange: setS }: SettingsDraftProps) {
  const { t } = useTranslation();
  const session = useTableState((st) => st.hidden);
  const resetSession = useTableState((st) => st.reset);
  return (
    <Card withBorder>
      <Stack>
        <Title order={2} size="h4">
          {t('ui.appearance.title')}
        </Title>
        <div>
          <Text size="sm" fw={500} id="vss-density-label">
            {t('ui.appearance.density')}
          </Text>
          <Text size="xs" c="dimmed" mb={6}>
            {t('ui.appearance.densityHelp')}
          </Text>
          <SegmentedControl
            aria-labelledby="vss-density-label"
            value={s.uiDensity}
            onChange={(v) => setS({ ...s, uiDensity: v === 'compact' ? 'compact' : 'comfortable' })}
            data={[
              { value: 'comfortable', label: t('ui.appearance.comfortable') },
              { value: 'compact', label: t('ui.appearance.compact') },
            ]}
          />
        </div>
        <Group align="flex-start">
          <Stack gap={4} maw={320}>
            <Button
              variant="default"
              disabled={Object.keys(session).length === 0}
              onClick={() => setS({ ...s, tableColumns: { ...s.tableColumns, ...session } })}
            >
              {t('ui.appearance.rememberColumns')}
            </Button>
            <Text size="xs" c="dimmed">
              {t('ui.appearance.rememberColumnsHelp')}
            </Text>
          </Stack>
          <Stack gap={4} maw={320}>
            <Button
              variant="default"
              onClick={() => {
                resetSession();
                setS({ ...s, tableColumns: {} });
              }}
            >
              {t('ui.appearance.resetColumns')}
            </Button>
            <Text size="xs" c="dimmed">
              {t('ui.appearance.resetColumnsHelp')}
            </Text>
          </Stack>
        </Group>
      </Stack>
    </Card>
  );
}
