import { Badge, Button, Card, Group, Modal, Stack, Text, Title } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RequestItem, VettingRequest } from '@shared/domain/types';
import { col, DataTable } from '../components/DataTable';
import { DobValue } from '../components/DobValue';
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
/** Event dates and place without empty parts: "2026-12-01 - 2026-12-03, Example City", or "-" (UI review R2S-17). */
export function eventText(req: Pick<VettingRequest, 'eventStart' | 'eventEnd' | 'eventLocation'>): string {
  const dates =
    req.eventStart && req.eventEnd && req.eventStart !== req.eventEnd
      ? `${fmtDate(req.eventStart)} - ${fmtDate(req.eventEnd)}`
      : (req.eventStart ?? req.eventEnd ?? '');
  const place = (req.eventLocation ?? '').trim();
  return [dates, place].filter(Boolean).join(', ') || '-';
}
function rowFields(i: RequestItem): string[] {
  const o = i.observed;
  return [itemName(i), o.dob.parsed ?? o.dob.value, o.passport, o.nationalId, o.unitName];
}

export interface RequestActions {
  export: boolean;
  markSent: boolean;
  /** Import response / Responded by email. */
  answer: boolean;
  edit: boolean;
  delete: boolean;
  /** The one emphasised action for this state (none once the request is answered). */
  primary: 'export' | 'import' | null;
  /** Next-step line shown under the action bar. */
  hint: 'export' | 'markSent' | 'import' | 'review' | 'close' | 'closed' | null;
}

/** Which request actions make sense in each state (UI review O-16): a closed request offers no new work. */
export function requestActions(status: VettingRequest['status']): RequestActions {
  const open = { export: true, markSent: true, answer: true, edit: true, delete: true };
  switch (status) {
    case 'received':
    case 'validated':
      return { ...open, primary: 'export', hint: 'export' };
    case 'exported':
      return { ...open, primary: null, hint: 'markSent' };
    case 'sent-to-dc':
      return { ...open, primary: 'import', hint: 'import' };
    case 'responded':
      return { ...open, primary: null, hint: 'review' };
    case 'finished':
      // Every person has an outcome (UI review R2O-19): no new export, sent mark or answer is offered. A corrected
      // response can still be imported from the Responses screen.
      return { ...open, export: false, markSent: false, answer: false, primary: null, hint: 'close' };
    case 'closed':
    case 'withdrawn':
      return {
        export: false,
        markSent: false,
        answer: false,
        edit: false,
        delete: false,
        primary: null,
        hint: status === 'closed' ? 'closed' : null,
      };
  }
}

/** A value with its copy icon; the value is cut with an ellipsis (full text on hover) so the icon stays visible. */
function CopyField({ value, label, wrap }: { value: string; label: string; wrap?: boolean }) {
  const redact = useUi((s) => s.settings.redactionMode);
  const shown = redact ? mask(value) : value;
  return (
    <Group gap={4} wrap="nowrap">
      <Text
        span
        {...(wrap ? {} : { truncate: 'end' as const })}
        title={shown}
        style={{ flex: '1 1 auto', minWidth: 0, ...(wrap ? { overflowWrap: 'anywhere' } : {}) }}
      >
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
  const actions = requestActions(req.status);
  const sentBlocked = ['responded', 'finished'].includes(req.status);
  return (
    <Stack>
      <PageHeader
        title={req.eventName}
        actions={
          <>
            {actions.export && (
              <Button variant={actions.primary === 'export' ? 'filled' : 'default'} onClick={() => setDlg('export')}>
                {t('request.exportForVetting')}
              </Button>
            )}
            {actions.markSent && (
              <Button
                variant="default"
                onClick={() => setDlg('sent')}
                disabled={sentBlocked}
                title={sentBlocked ? t('requestFlow.markSentDisabled') : undefined}
              >
                {t('request.markSent')}
              </Button>
            )}
            {actions.answer && (
              <Button
                variant={actions.primary === 'import' ? 'filled' : 'default'}
                onClick={() => navigate(`/responses/import?requestId=${req.id}`)}
              >
                {t('request.importResponse')}
              </Button>
            )}
            {actions.answer && (
              <Button variant="default" onClick={() => setDlg('clearance')}>
                {t('request.respondedByEmail')}
              </Button>
            )}
            <Button variant="default" onClick={() => setDlg('email')}>
              {t('request.emailRequestor')}
            </Button>
            {actions.edit && (
              <Button variant="subtle" onClick={() => setDlg('edit')}>
                {t('request.edit')}
              </Button>
            )}
            {actions.delete && (
              <Button variant="subtle" color="red" onClick={() => setDlg('delete')}>
                {t('request.delete')}
              </Button>
            )}
          </>
        }
      />
      {actions.hint && <Text size="sm">{t(`requestFlow.next.${actions.hint}`)}</Text>}
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
            // Local time with the zone shown (UI review R2O-07): the same clock the Mark sent input uses.
            [t('request.received'), fmtDateTime(req.receivedAt, { zone: true })],
            [t('request.sent'), fmtDateTime(req.sentToDcAt, { zone: true })],
            [
              t('request.responded'),
              `${fmtDateTime(req.respondedAt, { zone: true })}${req.responseKind ? ` (${t(`respkind.${req.responseKind}`)})` : ''}`,
            ],
            [t('request.event'), eventText(req)],
            [t('request.batchId'), req.batchId ?? '-'],
            [t('request.notes'), req.notes || '-'],
          ]}
        />
      </Card>

      <Group justify="space-between">
        <Title order={2} size="h3">
          {t('request.itemsTitle', { count: req.items.length })}
        </Title>
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
            (i) => <CopyField wrap value={itemName(i)} label={t('items.fieldName')} />,
            {
              sticky: 'first',
              minWidth: 168,
              grow: true,
            },
          ),
          col<RequestItem>('row', t('import.row'), (i) => i.observed.rowRef, {
            width: 84,
            nowrap: true,
            drop: 4,
          }),
          col<RequestItem>(
            'dob',
            t('import.dob'),
            // Invalid or ambiguous dates carry a badge and are never shown as if valid (UI review R2O-02).
            (i) => (
              <Group gap={4} wrap="nowrap">
                <DobValue
                  parsed={i.observed.dob.parsed}
                  raw={i.observed.dob.value}
                  ambiguous={i.observed.dob.ambiguousDayMonth}
                  showRaw={false}
                />
                {(i.observed.dob.parsed ?? i.observed.dob.value) && (
                  <CopyButton text={i.observed.dob.parsed ?? i.observed.dob.value} label={t('items.fieldDob')} />
                )}
              </Group>
            ),
            { width: 156, nowrap: true },
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
            { minWidth: 190, drop: 1 },
          ),
          col<RequestItem>('unit', t('import.unit'), (i) => i.observed.unitName, {
            minWidth: 140,
            grow: true,
            drop: 5,
            truncate: true,
            tooltip: (i) => i.observed.unitName,
          }),
          col<RequestItem>('status', t('items.status'), (i) => <StatusBadge status={i.prior?.status ?? 'unknown'} />, {
            minWidth: 118,
            nowrap: true,
          }),
          col<RequestItem>('expiry', t('items.expiry'), (i) => fmtDate(i.prior?.expiresAt), {
            width: 96,
            nowrap: true,
          }),
          col<RequestItem>(
            'person',
            t('items.person'),
            (i) => (i.personId ? <a href={`#/people/${i.personId}`}>{t('items.openPerson')}</a> : '-'),
            { width: 110, nowrap: true, hideable: true, drop: 2 },
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
            { minWidth: 226, nowrap: true },
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
            { width: 96, nowrap: true, drop: 3 },
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
          {...((it) => (it ? { item: it } : {}))(req.items.find((x) => x.id === linkItem))}
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
