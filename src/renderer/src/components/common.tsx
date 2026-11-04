import { Alert, Badge, Button, Group, Loader, Modal, Pagination, Stack, Text, TextInput, Title } from '@mantine/core';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { DispClass, IsoDate, MatchTier, VettingStatus } from '@shared/domain/types';
import type { LinkState } from '@shared/domain/types';
import { CopyIconButton } from './ui/CopyIconButton';
import { mask, STATUS_COLOR } from '../lib/format';
import { useUi } from '../store';

export function PageHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <Group justify="space-between" mb="md" wrap="wrap">
      <Title order={2}>{title}</Title>
      <Group gap="xs">{actions}</Group>
    </Group>
  );
}

export function QueryBoundary({
  loading,
  error,
  children,
}: {
  loading: boolean;
  error: string | null;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  if (error) {
    return (
      <Alert color="red" title={t('common.error')} role="alert">
        {error}
      </Alert>
    );
  }
  if (loading) return <Loader size="sm" aria-label={t('common.loading')} />;
  return <>{children}</>;
}

export function StatusBadge({ status }: { status: VettingStatus }) {
  const { t } = useTranslation();
  return (
    <Badge color={STATUS_COLOR[status]} variant="light" data-status={status}>
      {t(`status.${status}`)}
    </Badge>
  );
}

const DISP_COLOR: Record<DispClass, string> = { approved: 'green', 'non-approved': 'red', unknown: 'gray' };
/** Disposition class of a response row (approved / non-approved / unclear); always text, never colour alone. */
export function DispBadge({ value }: { value: DispClass }) {
  const { t } = useTranslation();
  return (
    <Badge color={DISP_COLOR[value]} variant="light" data-disp={value}>
      {t(`ui.dispClass.${value}`)}
    </Badge>
  );
}

const TIER_COLOR: Record<MatchTier, string> = { T1: 'green', T2: 'yellow', T3: 'orange', T4: 'gray' };
export function TierBadge({ tier }: { tier: MatchTier }) {
  const { t } = useTranslation();
  return (
    <Badge color={TIER_COLOR[tier]} variant="light" aria-label={t('tier.label', { tier })}>
      {tier}
    </Badge>
  );
}

const LINK_COLOR: Record<LinkState, string> = {
  auto: 'green',
  confirmed: 'green',
  'pending-review': 'orange',
  unlinked: 'gray',
  'new-person': 'blue',
};
export function LinkBadge({ state }: { state: LinkState }) {
  const { t } = useTranslation();
  return (
    <Badge color={LINK_COLOR[state]} variant="light">
      {t(`link.${state}`)}
    </Badge>
  );
}

/** Renders a personal-data value, masked when redaction mode is on. */
export function Sensitive({ value }: { value: string | null | undefined }) {
  const redact = useUi((s) => s.settings.redactionMode);
  if (!value) return <>-</>;
  return <span data-sensitive="true">{redact ? mask(value) : value}</span>;
}

/** Icon-only copy button (kept under its old name so every call site now renders the icon). */
export const CopyButton = CopyIconButton;

export function SimplePager({
  total,
  offset,
  limit,
  onChange,
}: {
  total: number;
  offset: number;
  limit: number;
  onChange: (offset: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / limit));
  if (pages <= 1) return null;
  return (
    <Pagination
      mt="sm"
      total={pages}
      value={Math.floor(offset / limit) + 1}
      onChange={(p) => onChange((p - 1) * limit)}
    />
  );
}

export function KeyValue({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 16px', margin: 0 }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt>
            <Text c="dimmed" size="sm" component="span">
              {k}
            </Text>
          </dt>
          <dd style={{ margin: 0 }}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Dialog that asks for a free-text reason before an action. */
export function ReasonDialog({
  opened,
  title,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  opened: boolean;
  title: string;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  return (
    <Modal opened={opened} onClose={onClose} title={title} trapFocus returnFocus>
      <Stack>
        <TextInput
          label={t('common.reason')}
          data-autofocus
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={reason.trim().length < 3}
            onClick={() => {
              onConfirm(reason.trim());
              setReason('');
            }}
          >
            {confirmLabel}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function expiryText(d: IsoDate | null): string {
  return d ?? '-';
}
