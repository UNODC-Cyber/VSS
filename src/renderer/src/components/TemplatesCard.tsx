import { Alert, Button, Card, Group, Stack, Text, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { TemplateInfo, TemplateList } from '@shared/ipc/contract';
import { useAction, useQuery, vss } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useUi } from '../store';
import { col, DataTable } from './DataTable';

/**
 * Settings > Templates: the INVESTc export template kept in the vault (VSS ships none). Import / replace with a blank
 * or any INVESTc workbook (sanitised in main), re-activate an earlier one, or remove one.
 */
export function TemplatesCard() {
  const { t } = useTranslation();
  const act = useAction();
  const toast = useUi((s) => s.pushToast);
  const q = useQuery<TemplateList>(() => vss().templates.list(), []);
  const list = q.data;

  const importOne = async () => {
    const f = await act(vss().files.pickOpen({ kind: 'request-xlsx', title: t('templates.pickTitle') }));
    if (!f?.path) return;
    const r = await act(vss().templates.import({ path: f.path }));
    if (!r) return;
    toast({
      kind: 'success',
      message: t('templates.imported', { version: r.template.templateVersion ?? '?', count: r.removedParts }),
    });
    q.reload();
  };
  const activate = async (id: string) => {
    if (await act(vss().templates.setActive({ id }), t('templates.activated'))) q.reload();
  };
  const remove = async (id: string) => {
    if (await act(vss().templates.remove({ id }), t('templates.removed'))) q.reload();
  };

  const describe = (tpl: TemplateInfo) => (
    <Stack gap={2} data-testid="template-active">
      <Text size="sm">
        {t('templates.version')}: {tpl.templateVersion ?? '-'}
        {tpl.instructionsVersion ? ` (${tpl.instructionsVersion})` : ''}
      </Text>
      <Text size="sm">
        {t('templates.source')}: {t(`templates.source.${tpl.source}`)}
      </Text>
      <Text size="sm">
        {t('templates.file')}: {tpl.originalName || '-'}
      </Text>
      <Text size="sm">
        {t('templates.added')}: {fmtDateTime(tpl.createdAt)}
      </Text>
    </Stack>
  );

  return (
    <Card withBorder>
      <Stack>
        <Title order={4}>{t('templates.title')}</Title>
        <Text size="sm">{t('templates.intro')}</Text>
        {list && !list.active && (
          <Alert color="yellow" role="status">
            {t('templates.none')}
          </Alert>
        )}
        {list?.active && (
          <Stack gap="xs">
            <Text fw={600}>{t('templates.active')}</Text>
            {describe(list.active)}
            <Group>
              <Button variant="default" color="red" onClick={() => void remove(list.active!.id)}>
                {t('templates.remove')}
              </Button>
            </Group>
          </Stack>
        )}
        <Group>
          <Button onClick={() => void importOne()}>{t('templates.importButton')}</Button>
        </Group>
        {list && list.history.length > 0 && (
          <DataTable
            caption={t('templates.history')}
            data={list.history}
            rowId={(r) => r.id}
            columns={[
              col<TemplateInfo>('v', t('templates.version'), (r) => r.templateVersion ?? '-', {
                sticky: 'first',
                width: 100,
                nowrap: true,
              }),
              col<TemplateInfo>('s', t('templates.source'), (r) => t(`templates.source.${r.source}`), {
                width: 140,
                truncate: true,
              }),
              col<TemplateInfo>('f', t('templates.file'), (r) => r.originalName || '-', {
                minWidth: 160,
                grow: true,
                truncate: true,
                tooltip: (r) => r.originalName,
              }),
              col<TemplateInfo>('a', t('templates.added'), (r) => fmtDateTime(r.createdAt), {
                width: 160,
                nowrap: true,
              }),
              col<TemplateInfo>('r', t('templates.replaced'), (r) => (r.replacedAt ? fmtDateTime(r.replacedAt) : '-'), {
                width: 160,
                nowrap: true,
              }),
              col<TemplateInfo>(
                'x',
                '',
                (r) => (
                  <Group gap="xs" wrap="nowrap">
                    <Button size="xs" variant="default" onClick={() => void activate(r.id)}>
                      {t('templates.use')}
                    </Button>
                    <Button size="xs" variant="subtle" color="red" onClick={() => void remove(r.id)}>
                      {t('templates.remove')}
                    </Button>
                  </Group>
                ),
                { width: 190, nowrap: true },
              ),
            ]}
          />
        )}
      </Stack>
    </Card>
  );
}
