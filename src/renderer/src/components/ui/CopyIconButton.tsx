import { ActionIcon, Tooltip, VisuallyHidden } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCopy } from '../../lib/clipboard';
import { IconCheck, IconCopy } from './icons';

const FEEDBACK_MS = 1200;

/**
 * Icon-only copy button. The accessible name is "Copy <field>"; after a successful copy the icon becomes a checkmark
 * for 1.2 s and a polite live region announces it. The copy itself goes through main (`useCopy`), never the browser
 * clipboard, so the exclude-from-history format and the auto-clear apply.
 */
export function CopyIconButton({ text, label }: { text: string; label: string }) {
  const copy = useCopy();
  const { t } = useTranslation();
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  if (!text) return null;
  const name = t('ui.copyIcon.label', { field: label });
  return (
    <>
      <Tooltip label={name} openDelay={300}>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          aria-label={name}
          data-copied={done ? 'true' : undefined}
          onClick={() => {
            void copy(text, t('common.copied', { field: label })).then((ok) => {
              if (!ok) return;
              setDone(true);
              if (timer.current) clearTimeout(timer.current);
              timer.current = setTimeout(() => setDone(false), FEEDBACK_MS);
            });
          }}
        >
          {done ? <IconCheck size={16} aria-hidden="true" /> : <IconCopy size={16} aria-hidden="true" />}
        </ActionIcon>
      </Tooltip>
      <VisuallyHidden aria-live="polite" role="status">
        {done ? t('ui.copyIcon.done') : ''}
      </VisuallyHidden>
    </>
  );
}
