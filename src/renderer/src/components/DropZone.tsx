import { useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import { Box } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { DropFileKind, FilePickResult } from '@shared/ipc/contract';
import { useAction, vss } from '../lib/api';

/**
 * Drag and drop for the import screens. Wraps the area that already has a "Choose file" button; dropping one workbook
 * asks main for the same read-only token the file dialog would give (files.grantDrop re-checks the path, the kind and
 * the extension), then calls `onFile` exactly as the picker does. The picker stays; keyboard users never need the drop.
 */
export function DropZone({
  kind,
  onFile,
  disabled = false,
  children,
}: {
  kind: DropFileKind;
  onFile: (f: FilePickResult) => void | Promise<void>;
  disabled?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const act = useAction();
  const [over, setOver] = useState(false);

  const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files');

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (disabled) return;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length !== 1) {
      await act(Promise.resolve({ ok: false as const, error: { code: 'BAD_REQUEST', message: t('drop.oneFile') } }));
      return;
    }
    const path = vss().pathForDrop(files[0]!);
    if (!path) {
      await act(Promise.resolve({ ok: false as const, error: { code: 'BAD_REQUEST', message: t('drop.noPath') } }));
      return;
    }
    const f = await act(vss().files.grantDrop({ kind, path }));
    if (f?.path) await onFile(f);
  };

  return (
    <Box
      data-testid="drop-zone"
      onDragEnter={(e: DragEvent) => {
        if (!disabled && hasFiles(e)) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragOver={(e: DragEvent) => {
        if (!disabled && hasFiles(e)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e: DragEvent) => void onDrop(e)}
      p="md"
      style={{
        border: `2px dashed var(--mantine-color-${over ? 'blue-6' : 'gray-5'})`,
        borderRadius: 'var(--mantine-radius-md)',
        background: over ? 'var(--mantine-color-blue-light)' : undefined,
      }}
    >
      {children}
      <Box mt="xs" fz="sm" c="dimmed" role="note">
        {t('drop.hint')}
      </Box>
    </Box>
  );
}
