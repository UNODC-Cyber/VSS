import { Alert, Button, Checkbox, Group, Modal, Select, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EmailDraft, EmailTemplateId } from '@shared/ipc/contract';
import { useAction, vss } from '../../lib/api';
import { useCopy } from '../../lib/clipboard';
import { useUi } from '../../store';
import type { DialogProps } from './types';

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
