/**
 * The explicit compare step before any identity decision (link, merge, "same person"). Identity matching must never
 * feel automatic: the records are shown side by side, every field where they state different values is listed at the
 * top, and while such conflict evidence exists the confirm button is not emphasised and stays disabled until the user
 * ticks that they checked those fields. Back is always the focused (safe) default.
 */
import { Alert, Button, Checkbox, Group, Modal, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { classifyDob } from '@shared/domain/dob';
import { DiffGrid, fieldConflicts } from './Diff';
import type { DiffField } from './Diff';

export interface IdentityConfirmProps {
  caption: string;
  headers: string[];
  fields: DiffField[];
  confirmLabel: string;
  backLabel?: string;
  /** Conflicts the matcher found that the fields shown may not reveal (e.g. father's name), as labels. */
  extraConflicts?: string[];
  /** False while the records are still loading: nothing can be confirmed against a partial comparison. */
  ready?: boolean;
  onConfirm: () => void;
  onBack: () => void;
}

/**
 * Labels of the fields whose stated values differ between the records. A date of birth that is not a real date on
 * either side counts too (UI review R2O-02): it cannot be compared, so it must be acknowledged like a conflict.
 */
export function conflictLabels(fields: DiffField[]): string[] {
  return fields.filter((f) => fieldConflicts(f) || hasInvalidDob(f)).map((f) => f.label);
}
function hasInvalidDob(f: DiffField): boolean {
  return f.kind === 'dob' && f.values.some((v) => v.trim() !== '' && classifyDob(v, v).state === 'invalid');
}

export function IdentityConfirm({
  caption,
  headers,
  fields,
  confirmLabel,
  backLabel,
  extraConflicts = [],
  ready = true,
  onConfirm,
  onBack,
}: IdentityConfirmProps) {
  const { t } = useTranslation();
  const conflicts = [...new Set([...conflictLabels(fields), ...extraConflicts])];
  const [checked, setChecked] = useState(false);
  const key = conflicts.join('|') + headers.join('|');
  useEffect(() => setChecked(false), [key]);
  const hasConflicts = conflicts.length > 0;
  return (
    <Stack>
      {!ready ? (
        <Text size="sm">{t('identity.loading')}</Text>
      ) : hasConflicts ? (
        <Alert color="orange" title={t('identity.conflictTitle')} data-testid="identity-conflicts">
          {t('identity.conflictBody', { fields: conflicts.join(', ') })}
        </Alert>
      ) : (
        <Text size="sm">{t('identity.noConflict')}</Text>
      )}
      <DiffGrid caption={caption} headers={headers} fields={fields} />
      {ready && hasConflicts && (
        <Checkbox
          label={t('identity.ack', { fields: conflicts.join(', ') })}
          checked={checked}
          onChange={(e) => setChecked(e.currentTarget.checked)}
        />
      )}
      <Group justify="flex-end">
        <Button variant="default" data-autofocus onClick={onBack}>
          {backLabel ?? t('identity.back')}
        </Button>
        <Button
          variant={hasConflicts ? 'default' : 'filled'}
          disabled={!ready || (hasConflicts && !checked)}
          data-conflicts={hasConflicts ? 'true' : 'false'}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </Group>
    </Stack>
  );
}

/** IdentityConfirm in its own dialog (review detail: "Compare and decide"). */
export function IdentityConfirmDialog({
  opened,
  title,
  ...props
}: IdentityConfirmProps & { opened: boolean; title: string }) {
  return (
    <Modal opened={opened} onClose={props.onBack} title={title} size="xl" trapFocus returnFocus>
      {opened && <IdentityConfirm {...props} />}
    </Modal>
  );
}
