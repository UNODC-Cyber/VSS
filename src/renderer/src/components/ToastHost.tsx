import { CloseButton, Group, Paper, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUi } from '../store';
import type { Toast } from '../store';

const COLOR = { success: 'green', error: 'red', info: 'blue' } as const;

function ToastItem({ toast }: { toast: Toast }) {
  const { t } = useTranslation();
  const dismiss = useUi((s) => s.dismissToast);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (toast.countdownUntil) {
      const i = setInterval(() => setNow(Date.now()), 500);
      return () => clearInterval(i);
    }
    const id = setTimeout(() => dismiss(toast.id), toast.kind === 'error' ? 8000 : 4000);
    return () => clearTimeout(id);
  }, [toast, dismiss]);
  const left = toast.countdownUntil ? Math.max(0, Math.ceil((toast.countdownUntil - now) / 1000)) : null;
  useEffect(() => {
    if (left === 0) dismiss(toast.id);
  }, [left, dismiss, toast.id]);
  return (
    <Paper
      shadow="md"
      p="sm"
      withBorder
      style={{ borderLeft: `4px solid var(--mantine-color-${COLOR[toast.kind]}-6)` }}
    >
      <Group justify="space-between" wrap="nowrap" gap="sm">
        <Text size="sm">
          {toast.message}
          {left !== null ? ` ${t('toast.clearsIn', { count: left })}` : ''}
        </Text>
        <CloseButton aria-label={t('common.dismiss')} onClick={() => dismiss(toast.id)} />
      </Group>
    </Paper>
  );
}

export function ToastHost() {
  const toasts = useUi((s) => s.toasts);
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        maxWidth: 380,
      }}
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}
