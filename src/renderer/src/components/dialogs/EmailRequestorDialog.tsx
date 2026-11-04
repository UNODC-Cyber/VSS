import { Alert, Anchor, Button, Checkbox, Group, Modal, Select, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EmailTemplatePurpose, RequestorRecord } from '@shared/domain/types';
import { isValidEmailAddress } from '@shared/email-address';
import type { EmailDraft, EmailTemplateId } from '@shared/ipc/contract';
import { useAction, vss } from '../../lib/api';
import { useCopy } from '../../lib/clipboard';
import { useUi } from '../../store';
import type { DialogProps } from './types';

const PICKER: EmailTemplatePurpose[] = [
  'acknowledgement',
  'status-to-requestor',
  'all-clear',
  'reminder',
  'request-to-dc',
];
/** Purposes served by email.draft (all but all-clear, which is rendered through email.renderTemplate). */
const DRAFT_ID: Partial<Record<EmailTemplatePurpose, EmailTemplateId>> = {
  acknowledgement: 'request-acknowledgement',
  'status-to-requestor': 'clearance-notice',
  reminder: 'reminder-outstanding',
  'request-to-dc': 'request-to-dc',
};

export function EmailRequestorDialog({ opened, onClose, request }: Omit<DialogProps, 'onChanged'>) {
  const { t } = useTranslation();
  const act = useAction();
  const copy = useCopy();
  const toast = useUi((s) => s.pushToast);
  const [template, setTemplate] = useState<EmailTemplatePurpose>('acknowledgement');
  /** Saved requestors matching the request's requestor (lane B); empty when that lane's API is unavailable. */
  const [requestors, setRequestors] = useState<RequestorRecord[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const requestorEmail = request.requestor.email;
  const [draft, setDraft] = useState<EmailDraft | null>(null);
  const [mailState, setMailState] = useState<'opened' | 'too-long' | null>(null);
  /** Optional columns: off by default, chosen per email. */
  const [withDob, setWithDob] = useState(false);
  const [withIds, setWithIds] = useState(false);

  useEffect(() => {
    if (!opened) return;
    setMailState(null);
    const fields = { ...(withDob ? { dob: true } : {}), ...(withIds ? { ids: true } : {}) };
    const id = DRAFT_ID[template];
    const apply = (d: EmailDraft) => {
      // The requestor's e-mail pre-fills To for requestor-facing messages when main had none to offer.
      const fallback = template !== 'request-to-dc' && requestorEmail && isValidEmailAddress(requestorEmail);
      setDraft(d.to.length === 0 && fallback ? { ...d, to: [requestorEmail] } : d);
    };
    if (id) {
      void act(vss().email.draft({ template: id, requestId: request.id, fields })).then((d) => d && apply(d));
    } else {
      void act(vss().email.renderTemplate({ template, requestId: request.id })).then(
        (r) =>
          r &&
          apply({
            to: [],
            cc: [],
            subject: r.subject,
            bodyText: r.body,
            attachmentName: null,
            containsPersonalData: r.containsPersonalData,
          }),
      );
    }
  }, [opened, template, withDob, withIds]);

  // Saved requestors (lane B) offered by name; NOT_SUPPORTED or any failure just hides the picker.
  useEffect(() => {
    if (!opened) return;
    let alive = true;
    setChosen(null);
    vss()
      .requestors.search({ text: request.requestor.name, limit: 8 })
      .then(
        (r) => alive && setRequestors(r.ok ? r.value.filter((x) => x.email) : []),
        () => alive && setRequestors([]),
      );
    return () => {
      alive = false;
    };
  }, [opened, request.id]);

  return (
    <Modal opened={opened} onClose={onClose} title={t('compose.title')} size="lg" trapFocus returnFocus>
      <Stack>
        <Select
          label={t('compose.template')}
          data={PICKER.map((v) => ({ value: v, label: t(`emailTpl.purpose.${v}`) }))}
          value={template}
          allowDeselect={false}
          onChange={(v) => v && setTemplate(v as EmailTemplatePurpose)}
        />
        <Anchor href="#/settings?card=email-templates" size="sm" onClick={onClose}>
          {t('emailTpl.editLink')}
        </Anchor>
        {requestors.length > 0 && template !== 'request-to-dc' && (
          <Select
            label={t('emailTpl.pickRequestor')}
            description={t('emailTpl.pickRequestorHelp')}
            data={requestors.map((r) => ({ value: r.id, label: `${r.name} <${r.email}>` }))}
            value={chosen}
            clearable
            onChange={(v) => {
              setChosen(v);
              const rec = requestors.find((r) => r.id === v);
              if (rec?.email && draft) setDraft({ ...draft, to: [rec.email] });
            }}
          />
        )}
        {draft && template !== 'request-to-dc' && draft.to.length === 0 && (
          <Alert color="gray" role="status">
            {t('emailTpl.noRequestorEmail')}
          </Alert>
        )}
        {(template === 'status-to-requestor' || template === 'reminder') && (
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
