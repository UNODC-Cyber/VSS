import { Alert, Badge, Button, Group, Modal, Radio, Stack, Text, TextInput } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExportMode, ExportPreview } from '@shared/ipc/contract';
import { useAction, vss } from '../../lib/api';
import { col, DataTable } from '../DataTable';
import { Sensitive, StatusBadge } from '../common';
import type { DialogProps } from './types';

export function ExportDialog({ opened, onClose, request, onChanged }: DialogProps) {
  const { t } = useTranslation();
  const act = useAction();
  const [mode, setMode] = useState<ExportMode>('regenerate');
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [reason, setReason] = useState('');
  /** Confirmed override reason: export anyway with the flagged items included. */
  const [override, setOverride] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [notices, setNotices] = useState<string[]>([]);

  const load = async (m: ExportMode) => {
    const p = await act(vss().requests.exportPreview({ requestId: request.id, mode: m }));
    if (p) setPreview(p);
  };
  useEffect(() => {
    if (opened) {
      setResult(null);
      setNotices([]);
      setReason('');
      setOverride(null);
      void load(mode);
    }
  }, [opened, mode]);

  const blocked = (preview?.blockingItemIds.length ?? 0) > 0 && override === null;
  const nameOf = (id: string) => preview?.items.find((i) => i.itemId === id)?.displayName ?? id;

  const doExport = async () => {
    const f = await act(
      vss().files.pickSave({ kind: 'request-xlsx', suggestedName: `vetting-request-${request.id.slice(-6)}.xlsx` }),
    );
    if (!f?.path) return;
    const r = await act(
      vss().requests.export({
        requestId: request.id,
        mode,
        destPath: f.path,
        ...(override !== null ? { overrideReason: override } : {}),
      }),
      t('export.done'),
    );
    if (r) {
      setResult(r.path);
      setNotices(r.notices ?? []);
      onChanged();
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title={t('export.title')} size="xl" trapFocus returnFocus>
      <Stack>
        {preview && !preview.filterOriginalAvailable && <Text size="sm">{t('export.regenerateOnly')}</Text>}
        {preview?.filterOriginalAvailable && (
          <Radio.Group label={t('export.mode')} value={mode} onChange={(v) => setMode(v as ExportMode)}>
            <Group mt="xs">
              <Radio value="regenerate" label={t('export.regenerate')} />
              <Radio value="filter-original" label={t('export.filterOriginal')} />
            </Group>
          </Radio.Group>
        )}
        {blocked && (
          <Alert color="red" title={t('export.blockedTitle')} role="alert">
            <Text size="sm">{t('export.blockedBody')}</Text>
            <ul>
              {preview!.blockingItemIds.map((id) => (
                <li key={id}>
                  <Sensitive value={nameOf(id)} />
                </li>
              ))}
            </ul>
            <TextInput
              label={t('export.overrideReason')}
              value={reason}
              onChange={(e) => setReason(e.currentTarget.value)}
              description={t('export.overrideHelp')}
            />
            <Button
              mt="xs"
              color="red"
              variant="light"
              disabled={reason.trim().length < 3}
              onClick={() => setOverride(reason.trim())}
            >
              {t('export.override')}
            </Button>
          </Alert>
        )}
        {override !== null && (
          <Alert color="orange" role="status">
            {t('export.overridden', { reason: override })}
          </Alert>
        )}
        {preview && (
          <>
            <Group>
              <Badge color="green">{t('export.included', { count: preview.includedCount })}</Badge>
              <Badge color="gray">{t('export.excluded', { count: preview.excludedCount })}</Badge>
            </Group>
            <DataTable
              caption={t('export.caption')}
              data={preview.items}
              rowId={(i) => i.itemId}
              columns={[
                col<ExportPreview['items'][number]>('n', t('import.name'), (i) => <Sensitive value={i.displayName} />),
                col<ExportPreview['items'][number]>('u', t('import.unit'), (i) => i.unitName),
                col<ExportPreview['items'][number]>('s', t('items.status'), (i) => <StatusBadge status={i.status} />),
                col<ExportPreview['items'][number]>('inc', t('export.decision'), (i) =>
                  i.included ? t('export.in') : t('export.out'),
                ),
                col<ExportPreview['items'][number]>('r', t('common.reason'), (i) => i.reason),
              ]}
            />
          </>
        )}
        {preview &&
          preview.templateAvailable === false &&
          (mode === 'regenerate' || !preview.filterOriginalAvailable) && (
            <Alert color="yellow" title={t('export.noTemplateTitle')} role="alert">
              <Text size="sm">{t('export.noTemplateBody')}</Text>
            </Alert>
          )}
        {result && (
          <Alert color="green" role="status">
            {t('export.saved', { path: result })}
          </Alert>
        )}
        {notices.length > 0 && (
          <Alert color="blue" title={t('export.noticesTitle')} role="status">
            {notices.map((n) => (
              <Text size="sm" key={n}>
                {n}
              </Text>
            ))}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button disabled={!preview || blocked || preview.includedCount === 0} onClick={() => void doExport()}>
            {t('export.run')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
