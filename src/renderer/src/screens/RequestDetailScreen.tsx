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
import { useCopy } from '../lib/clipboard';
import { fmtDate, fmtDateTime } from '../lib/format';
import { navigate } from '../lib/router';

type Dlg = 'export' | 'sent' | 'clearance' | 'email' | 'edit' | 'delete' | null;

function itemName(i: RequestItem): string {
  const o = i.observed;
  return `${o.surname}, ${[o.name1, o.name2, o.name3, o.name4].filter(Boolean).join(' ')}`;
}
function rowFields(i: RequestItem): string[] {
  const o = i.observed;
  return [itemName(i), o.dob.parsed ?? o.dob.value, o.passport, o.nationalId, o.unitName];
}

function RequestBody({ req, reload }: { req: VettingRequest; reload: () => void }) {
  const { t } = useTranslation();
  const act = useAction();
  const copy = useCopy();
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
        <Button
          size="compact-sm"
          variant="default"
          onClick={() => void copy(req.items.map((i) => rowFields(i).join('\t')).join('\n'), t('items.tableCopied'))}
        >
          {t('items.copyAllTsv')}
        </Button>
      </Group>
      <DataTable<RequestItem>
        caption={t('items.caption')}
        data={req.items}
        rowId={(i) => i.id}
        columns={[
          col<RequestItem>('row', t('import.row'), (i) => i.observed.rowRef),
          col<RequestItem>('name', t('import.name'), (i) => (
            <Group gap={4} wrap="nowrap">
              <Sensitive value={itemName(i)} />
              <CopyButton text={itemName(i)} label={t('items.fieldName')} />
            </Group>
          )),
          col<RequestItem>('dob', t('import.dob'), (i) => (
            <Group gap={4} wrap="nowrap">
              <Sensitive value={i.observed.dob.parsed ?? i.observed.dob.value} />
              <CopyButton text={i.observed.dob.parsed ?? i.observed.dob.value} label={t('items.fieldDob')} />
            </Group>
          )),
          col<RequestItem>('ids', t('items.ids'), (i) => (
            <Stack gap={0}>
              {i.observed.passport && (
                <Group gap={4} wrap="nowrap">
                  <Sensitive value={i.observed.passport} />
                  <CopyButton text={i.observed.passport} label={t('items.fieldPassport')} />
                </Group>
              )}
              {i.observed.nationalId && (
                <Group gap={4} wrap="nowrap">
                  <Sensitive value={i.observed.nationalId} />
                  <CopyButton text={i.observed.nationalId} label={t('items.fieldNationalId')} />
                </Group>
              )}
              {!i.observed.passport && !i.observed.nationalId && '-'}
            </Stack>
          )),
          col<RequestItem>('unit', t('import.unit'), (i) => i.observed.unitName),
          col<RequestItem>('status', t('items.status'), (i) => <StatusBadge status={i.prior?.status ?? 'unknown'} />),
          col<RequestItem>('expiry', t('items.expiry'), (i) => fmtDate(i.prior?.expiresAt)),
          col<RequestItem>('person', t('items.person'), (i) =>
            i.personId ? <a href={`#/people/${i.personId}`}>{t('items.openPerson')}</a> : '-',
          ),
          col<RequestItem>('link', t('import.link'), (i) => (
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
          )),
          col<RequestItem>('copy', t('items.copy'), (i) => (
            <Group gap={4} wrap="nowrap">
              <Button
                size="compact-xs"
                variant="light"
                onClick={() => void copy(rowFields(i).join(' | '), t('items.rowCopied'))}
                aria-label={t('items.copyRowText', { row: i.observed.rowRef })}
              >
                {t('items.copyText')}
              </Button>
              <Button
                size="compact-xs"
                variant="light"
                onClick={() => void copy(rowFields(i).join('\t'), t('items.rowCopied'))}
                aria-label={t('items.copyRowTsv', { row: i.observed.rowRef })}
              >
                {t('items.copyTsv')}
              </Button>
            </Group>
          )),
        ]}
      />

      {dlg === 'export' && <ExportDialog opened onClose={close} request={req} onChanged={reload} />}
      {dlg === 'sent' && <MarkSentDialog opened onClose={close} request={req} onChanged={reload} />}
      {dlg === 'clearance' && <EmailClearanceDialog opened onClose={close} request={req} onChanged={reload} />}
      {dlg === 'email' && <EmailRequestorDialog opened onClose={close} request={req} />}
      {dlg === 'edit' && <EditRequestDialog opened onClose={close} request={req} onChanged={reload} />}
      {linkItem && <LinkItemDialog opened onClose={() => setLinkItem(null)} itemId={linkItem} onChanged={reload} />}
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
