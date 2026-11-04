import { Card, NumberInput, Select, Stack, Switch, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { Settings } from '@shared/domain/types';
import { asNum } from './types';
import type { SettingsDraftProps } from './types';

export function ExportPolicyCard({ value: s, onChange: setS }: SettingsDraftProps) {
  const { t } = useTranslation();
  const policy = s.exportPolicy;
  const setPolicy = (patch: Partial<Settings['exportPolicy']>) => setS({ ...s, exportPolicy: { ...policy, ...patch } });
  return (
    <Card withBorder>
      <Stack>
        <Title order={2} size="h4">
          {t('settings.exportPolicy')}
        </Title>
        <NumberInput
          label={t('settings.expiringWithin')}
          min={1}
          max={365}
          value={policy.expiringWithinDays}
          onChange={(v) => setPolicy({ expiringWithinDays: asNum(v, policy.expiringWithinDays) })}
        />
        <Switch
          label={t('settings.includePending')}
          checked={policy.includePending}
          onChange={(e) => setPolicy({ includePending: e.currentTarget.checked })}
        />
        <Switch
          label={t('settings.includeUnitChanged')}
          checked={policy.includeUnitChanged}
          onChange={(e) => setPolicy({ includeUnitChanged: e.currentTarget.checked })}
        />
        <Switch
          label={t('settings.includeNonApproved')}
          checked={policy.includeNonApproved}
          onChange={(e) => setPolicy({ includeNonApproved: e.currentTarget.checked })}
        />
        <Select
          label={t('settings.flagged')}
          data={(['include', 'exclude', 'block'] as const).map((v) => ({ value: v, label: t(`flagged.${v}`) }))}
          value={policy.includeFlaggedUnresolved}
          allowDeselect={false}
          onChange={(v) =>
            v && setPolicy({ includeFlaggedUnresolved: v as Settings['exportPolicy']['includeFlaggedUnresolved'] })
          }
        />
      </Stack>
    </Card>
  );
}
