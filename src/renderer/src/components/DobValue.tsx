/**
 * A date of birth exactly as VSS holds it, never normalised behind the user's back (UI review round 2, R2O-02 /
 * R2O-04): an impossible date shows the text as written plus an "Invalid date" badge; a day/month-ambiguous date
 * shows the reading VSS used, an "Ambiguous" badge and the value as written in the file, with both readings in the
 * badge's accessible description.
 */
import { Badge, Group, Stack, Text, Tooltip } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { classifyDob } from '@shared/domain/dob';
import type { DobView } from '@shared/domain/dob';
import { Sensitive } from './common';
import { useUi } from '../store';

export interface DobValueProps {
  /** The ISO date VSS read (or stored); null when none. */
  parsed: string | null | undefined;
  /** The value as written in the source; '' or undefined when unknown. */
  raw?: string | null | undefined;
  /** The source already flagged day/month as ambiguous. */
  ambiguous?: boolean;
  /** Show the "in the file" line under an ambiguous value (tables); off in one-line places. */
  showRaw?: boolean;
}

export function dobHelp(t: (k: string, o?: Record<string, unknown>) => string, v: DobView, redact: boolean): string {
  if (v.state === 'invalid') return t('dobView.invalidHelp');
  if (v.state === 'ambiguous' && v.readings)
    return redact
      ? t('dobView.ambiguousHelpRedacted')
      : t('dobView.ambiguousHelp', { md: v.readings.md, dm: v.readings.dm });
  return '';
}

export function DobValue({ parsed, raw, ambiguous, showRaw = true }: DobValueProps) {
  const { t } = useTranslation();
  const redact = useUi((s) => s.settings.redactionMode);
  const v = classifyDob(parsed, raw, ambiguous ? { ambiguous: true } : {});
  if (v.state === 'empty') return <>-</>;
  if (v.state === 'ok') return <Sensitive value={v.text} />;
  const help = dobHelp(t, v, redact);
  const badge = (
    <Tooltip label={help} multiline w={280} withArrow>
      <Badge
        size="xs"
        color={v.state === 'invalid' ? 'red' : 'orange'}
        variant="light"
        data-testid={`dob-${v.state}`}
        aria-label={`${t(`dobView.${v.state}`)}: ${help}`}
      >
        {t(`dobView.${v.state}`)}
      </Badge>
    </Tooltip>
  );
  return (
    <Stack gap={0} data-dob-state={v.state}>
      {/* wrap: in a narrow cell the badge moves under the date instead of being cut (R3S-02, R3S-03). */}
      <Group gap={4} wrap="wrap" style={{ rowGap: 2 }}>
        <Sensitive value={v.text} />
        {badge}
      </Group>
      {showRaw && v.state === 'ambiguous' && v.raw && (
        <Text size="xs" data-testid="dob-as-written" style={{ whiteSpace: 'normal' }}>
          {t('matchRequest.dobInFile')} <Sensitive value={v.raw} />
        </Text>
      )}
    </Stack>
  );
}
