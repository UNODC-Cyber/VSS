import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  Radio,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { VettingRequest } from '@shared/domain/types';
import type { EmailDraft, EmailTemplateId, ExportMode, ExportPreview } from '@shared/ipc/contract';
import { useAction, vss } from '../lib/api';
import { useCopy } from '../lib/clipboard';
import { addDaysIso, localInputToIso, nowLocalInput, todayIso } from '../lib/format';
import { useUi } from '../store';
import { col, DataTable } from './DataTable';
import { PersonPicker, Sensitive, StatusBadge } from './common';

interface DialogProps {
  opened: boolean;
  onClose: () => void;
  request: VettingRequest;
  onChanged: () => void;
}

// ---------------------------------------------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------------------------------------------
export function MarkSentDialog({ opened, onClose, request, onChanged }: DialogProps) {
  const { t } = useTranslation();
  const act = useAction();
  const [at, setAt] = useState(nowLocalInput());
  return (
    <Modal opened={opened} onClose={onClose} title={t('sent.title')} trapFocus returnFocus>
      <Stack>
        <TextInput
          label={t('sent.when')}
          type="datetime-local"
          data-autofocus
          value={at}
          onChange={(e) => setAt(e.currentTarget.value)}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={async () => {
              const r = await act(
                vss().requests.setStatus({ id: request.id, status: 'sent-to-dc', at: localInputToIso(at) }),
                t('sent.done'),
              );
              if (r) {
                onChanged();
                onClose();
              }
            }}
          >
            {t('sent.confirm')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
export function EmailClearanceDialog({ opened, onClose, request, onChanged }: DialogProps) {
  const { t } = useTranslation();
  const act = useAction();
  const days = useUi((s) => s.settings.emailClearanceDefaultDays);
  const [date, setDate] = useState(todayIso());
  const [scope, setScope] = useState<'all' | 'some'>('all');
  const [picked, setPicked] = useState<string[]>([]);
  const [disposition, setDisposition] = useState<'approved' | 'non-approved'>('approved');
  /** Per-person outcome when it differs from the overall one (scope 'some'). */
  const [perItem, setPerItem] = useState<Record<string, 'approved' | 'non-approved'>>({});
  const [expiry, setExpiry] = useState<string | null>(null); // null = assumed default
  const [note, setNote] = useState('');
  const defaultExpiry = addDaysIso(date, days);
  const allIds = scope === 'all' ? request.items.map((i) => i.id) : picked;

  return (
    <Modal opened={opened} onClose={onClose} title={t('email.clearanceTitle')} size="lg" trapFocus returnFocus>
      <Stack>
        <TextInput
          label={t('email.certDate')}
          type="date"
          data-autofocus
          value={date}
          onChange={(e) => setDate(e.currentTarget.value)}
        />
        <Radio.Group
          label={t('email.outcome')}
          value={disposition}
          onChange={(v) => setDisposition(v as 'approved' | 'non-approved')}
        >
          <Group mt="xs">
            <Radio value="approved" label={t('email.approved')} />
            <Radio value="non-approved" label={t('email.nonApproved')} />
          </Group>
        </Radio.Group>
        <Radio.Group label={t('email.scope')} value={scope} onChange={(v) => setScope(v as 'all' | 'some')}>
          <Group mt="xs">
            <Radio value="all" label={t('email.allClear')} />
            <Radio value="some" label={t('email.perPerson')} />
          </Group>
        </Radio.Group>
        {scope === 'some' && (
          <Stack gap={4} role="group" aria-label={t('email.perPerson')}>
            {request.items.map((i) => {
              const label = `${i.observed.surname}, ${i.observed.name1} (${i.observed.rowRef})`;
              return (
                <Group key={i.id} justify="space-between" wrap="nowrap">
                  <Checkbox
                    label={label}
                    checked={picked.includes(i.id)}
                    onChange={(e) =>
                      setPicked(e.currentTarget.checked ? [...picked, i.id] : picked.filter((x) => x !== i.id))
                    }
                  />
                  {picked.includes(i.id) && (
                    <Select
                      size="xs"
                      w={170}
                      aria-label={t('email.outcomeFor', { name: label })}
                      allowDeselect={false}
                      value={perItem[i.id] ?? disposition}
                      data={[
                        { value: 'approved', label: t('email.approved') },
                        { value: 'non-approved', label: t('email.nonApproved') },
                      ]}
                      onChange={(v) => v && setPerItem({ ...perItem, [i.id]: v as 'approved' | 'non-approved' })}
                    />
                  )}
                </Group>
              );
            })}
          </Stack>
        )}
        {(disposition === 'approved' || Object.values(perItem).includes('approved')) && (
          <div>
            <TextInput
              label={t('email.expiry')}
              type="date"
              value={expiry ?? defaultExpiry}
              onChange={(e) => setExpiry(e.currentTarget.value || null)}
              description={expiry === null ? t('email.expiryAssumed', { days }) : t('email.expiryStated')}
            />
            {expiry === null && (
              <Badge color="yellow" mt={4} data-testid="expiry-assumed">
                {t('email.assumedBadge')}
              </Badge>
            )}
          </div>
        )}
        <Textarea label={t('request.notes')} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={allIds.length === 0}
            onClick={async () => {
              const r = await act(
                vss().responses.recordEmailClearance({
                  requestId: request.id,
                  itemIds: allIds,
                  certDate: date,
                  expiresAt: expiry,
                  disposition,
                  ...(scope === 'some'
                    ? {
                        dispositions: Object.fromEntries(
                          allIds
                            .filter((id) => perItem[id] && perItem[id] !== disposition)
                            .map((id) => [id, perItem[id]!]),
                        ),
                      }
                    : {}),
                  note,
                }),
                t('email.recorded', { count: allIds.length }),
              );
              if (r) {
                onChanged();
                onClose();
              }
            }}
          >
            {t('email.record')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
export function EmailRequestorDialog({ opened, onClose, request }: Omit<DialogProps, 'onChanged'>) {
  const { t } = useTranslation();
  const act = useAction();
  const copy = useCopy();
  const toast = useUi((s) => s.pushToast);
  const [template, setTemplate] = useState<EmailTemplateId>('request-acknowledgement');
  const [draft, setDraft] = useState<EmailDraft | null>(null);
  const [mailState, setMailState] = useState<'opened' | 'too-long' | null>(null);
  /** Optional columns: off by default, chosen per email. */
  const [withDob, setWithDob] = useState(false);
  const [withIds, setWithIds] = useState(false);

  useEffect(() => {
    if (!opened) return;
    setMailState(null);
    const fields = { ...(withDob ? { dob: true } : {}), ...(withIds ? { ids: true } : {}) };
    void act(vss().email.draft({ template, requestId: request.id, fields })).then((d) => d && setDraft(d));
  }, [opened, template, withDob, withIds]);

  return (
    <Modal opened={opened} onClose={onClose} title={t('compose.title')} size="lg" trapFocus returnFocus>
      <Stack>
        <Select
          label={t('compose.template')}
          data={(
            [
              'request-acknowledgement',
              'clearance-notice',
              'reminder-outstanding',
              'request-to-dc',
            ] as EmailTemplateId[]
          ).map((v) => ({
            value: v,
            label: t(`template.${v}`),
          }))}
          value={template}
          allowDeselect={false}
          onChange={(v) => v && setTemplate(v as EmailTemplateId)}
        />
        {(template === 'clearance-notice' || template === 'reminder-outstanding') && (
          <Group role="group" aria-label={t('compose.columns')}>
            <Checkbox
              label={t('compose.withDob')}
              checked={withDob}
              onChange={(e) => setWithDob(e.currentTarget.checked)}
            />
            <Checkbox
              label={t('compose.withIds')}
              checked={withIds}
              onChange={(e) => setWithIds(e.currentTarget.checked)}
            />
          </Group>
        )}
        {draft && (
          <>
            {draft.containsPersonalData && <Alert color="orange">{t('compose.personalData')}</Alert>}
            <TextInput
              label={t('compose.to')}
              value={draft.to.join(', ')}
              onChange={(e) => setDraft({ ...draft, to: e.currentTarget.value.split(/[,;\s]+/).filter(Boolean) })}
            />
            <TextInput
              label={t('compose.cc')}
              value={draft.cc.join(', ')}
              onChange={(e) => setDraft({ ...draft, cc: e.currentTarget.value.split(/[,;\s]+/).filter(Boolean) })}
            />
            <TextInput
              label={t('compose.subject')}
              value={draft.subject}
              onChange={(e) => setDraft({ ...draft, subject: e.currentTarget.value })}
            />
            <Textarea
              label={t('compose.body')}
              rows={8}
              value={draft.bodyText}
              onChange={(e) => setDraft({ ...draft, bodyText: e.currentTarget.value })}
            />
            {draft.attachmentName && <Text size="sm">{t('compose.attachment', { name: draft.attachmentName })}</Text>}
            {mailState && (
              <Alert color={mailState === 'opened' ? 'blue' : 'orange'} role="status" data-testid="mailto-status">
                <Text size="sm">{mailState === 'opened' ? t('compose.mailtoReady') : t('compose.truncated')}</Text>
              </Alert>
            )}
            <Group justify="flex-end">
              <Button
                variant="default"
                onClick={async () => {
                  // Main opens the mail client (the renderer cannot navigate); a body too long for mailto: is not
                  // opened and the user saves an .eml or copies the text instead.
                  const r = await act(vss().email.mailto(draft));
                  if (r) setMailState(r.truncated ? 'too-long' : 'opened');
                }}
              >
                {t('compose.openMail')}
              </Button>
              <Button
                variant="default"
                onClick={async () => {
                  const f = await act(vss().files.pickSave({ kind: 'eml', suggestedName: 'draft.eml' }));
                  if (!f?.path) return;
                  const r = await act(vss().email.writeEml({ draft, destPath: f.path }), t('compose.saved'));
                  if (r?.path) toast({ kind: 'info', message: r.path });
                }}
              >
                {t('compose.saveEml')}
              </Button>
              <Button onClick={() => void copy(draft.bodyText, t('compose.bodyCopied'))}>
                {t('compose.copyBody')}
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
export function LinkItemDialog({
  opened,
  onClose,
  itemId,
  onChanged,
}: {
  opened: boolean;
  onClose: () => void;
  itemId: string | null;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const act = useAction();
  if (!itemId) return null;
  return (
    <PersonPicker
      opened={opened}
      title={t('link.title')}
      onClose={onClose}
      onPick={async (p) => {
        const r = await act(vss().requests.linkItem({ itemId, personId: p.id }), t('link.done'));
        if (r) {
          onChanged();
          onClose();
        }
      }}
    />
  );
}

export function EditRequestDialog({ opened, onClose, request, onChanged }: DialogProps) {
  const { t } = useTranslation();
  const act = useAction();
  const [batch, setBatch] = useState(request.batchId ?? '');
  const [notes, setNotes] = useState(request.notes);
  return (
    <Modal opened={opened} onClose={onClose} title={t('request.edit')} trapFocus returnFocus>
      <Stack>
        <TextInput
          label={t('request.batchId')}
          data-autofocus
          value={batch}
          onChange={(e) => setBatch(e.currentTarget.value)}
        />
        <Textarea label={t('request.notes')} value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={async () => {
              const r = await act(
                vss().requests.update({ id: request.id, patch: { batchId: batch.trim() || null, notes } }),
                t('common.saved'),
              );
              if (r) {
                onChanged();
                onClose();
              }
            }}
          >
            {t('common.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
