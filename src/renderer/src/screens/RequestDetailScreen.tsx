import { Badge, Button, Card, Group, Modal, Stack, Text, Title } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RequestItem, VettingRequest } from '@shared/domain/types';
import { col, DataTable } from '../components/DataTable';
import { RequestStatusBadge } from '../components/RequestStatusBadge';
import { ReviewAndClosePanel } from '../components/ReviewAndClosePanel';
import {
  EditRequestDialog,
  EmailClearanceDialog,
  EmailRequestorDialog,
  ExportDialog,
  LinkItemDialog,
  MarkSentDialog,
} from '../components/RequestDialogs';
import {
  CopyButton,
  KeyValue,
  LinkBadge,
  PageHeader,
  QueryBoundary,
  Sensitive,
  StatusBadge,
} from '../components/common';
import { useAction, useQuery, vss } from '../lib/api';
import { CopyIconButton } from '../components/ui/CopyIconButton';
import { fmtDate, fmtDateTime, mask } from '../lib/format';
import { navigate } from '../lib/router';
import { useUi } from '../store';

type Dlg = 'export' | 'sent' | 'clearance' | 'email' | 'edit' | 'delete' | null;

function itemName(i: RequestItem): string {
  const o = i.observed;
  return `${o.surname}, ${[o.name1, o.name2, o.name3, o.name4].filter(Boolean).join(' ')}`;
}
function rowFields(i: RequestItem): string[] {
  const o = i.observed;
  return [itemName(i), o.dob.parsed ?? o.dob.value, o.passport, o.nationalId, o.unitName];
}

/** A value with its copy icon; the value is cut with an ellipsis (full text on hover) so the icon stays visible. */
function CopyField({ value, label }: { value: string; label: string }) {
  const redact = useUi((s) => s.settings.redactionMode);
  const shown = redact ? mask(value) : value;
  return (
    <Group gap={4} wrap="nowrap">
      <Text span truncate="end" title={shown} style={{ flex: '1 1 auto', minWidth: 0 }}>
        <Sensitive value={value} />
      </Text>
      <CopyButton text={value} label={label} />
    </Group>
  );
}

function RequestBody({ req, reload }: { req: VettingRequest; reload: () => void }) {
  const { t } = useTranslation();
  const act = useAction();
  const [dlg, setDlg] = useState<Dlg>(null);
  const [linkItem, setLinkItem] = useState<string | null>(null);
  const awaiting = req.status === 'sent-to-dc' || req.status === 'exported';
  const unresolved = req.items.filter((i) => i.linkState === 'pending-review').length;
  const close = () => setDlg(null);
  return (
    <Stack>
      <PageHeader
        title={req.eventName}
        actions={
          <>
            <Button onClick={() => setDlg('export')}>{t('request.exportForVetting')}</Button>
            <Button
              variant="default"
              onClick={() => setDlg('sent')}
              disabled={['responded', 'finished', 'closed'].includes(req.status)}
            >
              {t('request.markSent')}
            </Button>
            <Button variant="default" onClick={() => setDlg('clearance')}>
              {t('request.respondedByEmail')}
            </Button>
            <Button variant="default" onClick={() => navigate(`/responses/import?requestId=${req.id}`)}>
              {t('request.importResponse')}
            </Button>
            <Button variant="default" onClick={() => setDlg('email')}>
              {t('request.emailRequestor')}
            </Button>
            <Button variant="subtle" onClick={() => setDlg('edit')}>
              {t('request.edit')}
            </Button>
            <Button variant="subtle" color="red" onClick={() => setDlg('delete')}>
              {t('request.delete')}
            </Button>
          </>
        }
      />
      <Group>
        <RequestStatusBadge status={req.status} />
        {awaiting && <Badge color="yellow">{t('request.awaiting')}</Badge>}
        {unresolved > 0 && (
          <Badge color="orange" data-testid="unresolved-count">
            {t('request.unresolved', { count: unresolved })}
          </Badge>
        )}
      </Group>
      <ReviewAndClosePanel req={req} reload={reload} />
      <Card withBorder>
        <KeyValue
          rows={[
            [
              t('request.requestorName'),
              `${req.requestor.name}${req.requestor.organisation ? `, ${req.requestor.organisation}` : ''}`,
            ],
            [t('request.requestorEmail'), req.requestor.email ?? '-'],
            [t('request.received'), fmtDateTime(req.receivedAt)],
            [t('request.sent'), fmtDateTime(req.sentToDcAt)],
            [
              t('request.responded'),
              `${fmtDateTime(req.respondedAt)}${req.responseKind ? ` (${t(`respkind.${req.responseKind}`)})` : ''}`,
            ],
            [t('request.event'), `${fmtDate(req.eventStart)} - ${fmtDate(req.eventEnd)} ${req.eventLocation ?? ''}`],
            [t('request.batchId'), req.batchId ?? '-'],
            [t('request.notes'), req.notes || '-'],
          ]}
        />
      </Card>

      <Group justify="space-between">
        <Title order={3}>{t('request.itemsTitle', { count: req.items.length })}</Title>
        <CopyIconButton
          text={req.items.map((i) => rowFields(i).join('\t')).join('\n')}
          label={t('ui.copyField.allTsv')}
        />
      </Group>
      <DataTable<RequestItem>
        caption={t('items.caption')}
        data={req.items}
        rowId={(i) => i.id}
        tableId="request-items"
        columns={[
          col<RequestItem>(
            'name',
            t('import.name'),
            (i) => <CopyField value={itemName(i)} label={t('items.fieldName')} />,
            {
              sticky: 'first',
              minWidth: 240,
              grow: true,
            },
          ),
          col<RequestItem>('row', t('import.row'), (i) => i.observed.rowRef, { width: 72, nowrap: true }),
          col<RequestItem>(
            'dob',
            t('import.dob'),
            (i) => <CopyField value={i.observed.dob.parsed ?? i.observed.dob.value} label={t('items.fieldDob')} />,
            { width: 150, nowrap: true },
          ),
          col<RequestItem>(
            'ids',
            t('items.ids'),
            (i) => (
              <Stack gap={0}>
                {i.observed.passport && <CopyField value={i.observed.passport} label={t('items.fieldPassport')} />}
                {i.observed.nationalId && (
                  <CopyField value={i.observed.nationalId} label={t('items.fieldNationalId')} />
                )}
                {!i.observed.passport && !i.observed.nationalId && '-'}
              </Stack>
            ),
            { minWidth: 190 },
          ),
          col<RequestItem>('unit', t('import.unit'), (i) => i.observed.unitName, {
            maxWidth: 200,
            truncate: true,
            tooltip: (i) => i.observed.unitName,
          }),
          col<RequestItem>('status', t('items.status'), (i) => <StatusBadge status={i.prior?.status ?? 'unknown'} />, {
            minWidth: 150,
            nowrap: true,
          }),
          col<RequestItem>('expiry', t('items.expiry'), (i) => fmtDate(i.prior?.expiresAt), {
            width: 120,
            nowrap: true,
          }),
          col<RequestItem>(
            'person',
            t('items.person'),
            (i) => (i.personId ? <a href={`#/people/${i.personId}`}>{t('items.openPerson')}</a> : '-'),
            { width: 110, nowrap: true, hideable: true },
          ),
          col<RequestItem>(
            'link',
            t('import.link'),
            (i) => (
              <Group gap={4} wrap="nowrap">
                <LinkBadge state={i.linkState} />
                {(i.linkState === 'pending-review' || i.linkState === 'unlinked') && (
                  <Button
                    size="compact-xs"
                    onClick={() => setLinkItem(i.id)}
                    aria-label={t('items.resolveRow', { row: i.observed.rowRef })}
                  >
                    {t('items.resolve')}
                  </Button>
                )}
              </Group>
            ),
            { minWidth: 210, nowrap: true },
          ),
          col<RequestItem>(
            'copy',
            t('items.copy'),
            (i) => (
              <Group gap={2} wrap="nowrap">
                <CopyIconButton
                  text={rowFields(i).join(' | ')}
                  label={t('ui.copyField.rowText', { row: i.observed.rowRef })}
                />
                <CopyIconButton
                  text={rowFields(i).join('\t')}
                  label={t('ui.copyField.rowTsv', { row: i.observed.rowRef })}
                />
              </Group>
            ),
            { width: 96, nowrap: true },
          ),
        ]}
      />

      {dlg === 'export' && <ExportDialog opened onClose={close} request={req} onChanged={reload} />}
      {dlg === 'sent' && <MarkSentDialog opened onClose={close} request={req} onChanged={reload} />}
      {dlg === 'clearance' && <EmailClearanceDialog opened onClose={close} request={req} onChanged={reload} />}
      {dlg === 'email' && <EmailRequestorDialog opened onClose={close} request={req} />}
      {dlg === 'edit' && <EditRequestDialog opened onClose={close} request={req} onChanged={reload} />}
      {linkItem && (
        <LinkItemDialog
          opened
          onClose={() => setLinkItem(null)}
          itemId={linkItem}
          onChanged={reload}
          itemName={((it) => (it ? itemName(it) : ''))(req.items.find((x) => x.id === linkItem))}
        />
      )}
      <Modal opened={dlg === 'delete'} onClose={close} title={t('request.deleteTitle')} trapFocus returnFocus>
        <Text>{t('request.deleteBody')}</Text>
        <Group mt="md" justify="flex-end">
          <Button variant="default" onClick={close} data-autofocus>
            {t('common.cancel')}
          </Button>
          <Button
            color="red"
            onClick={async () => {
              const r = await act(vss().requests.remove({ id: req.id }), t('request.deleted'));
              if (r) navigate('/requests');
            }}
          >
            {t('request.delete')}
          </Button>
        </Group>
      </Modal>
    </Stack>
  );
}

export function RequestDetailScreen({ id }: { id: string }) {
  const q = useQuery(() => vss().requests.get({ id }), [id]);
  return (
    <QueryBoundary loading={q.loading && !q.data} error={q.error}>
      {q.data && <RequestBody req={q.data} reload={q.reload} />}
    </QueryBoundary>
  );
}
