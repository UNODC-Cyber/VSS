import { Alert, Badge, Button, Card, Code, Group, Stack, Tabs, Text, Textarea, TextInput, Title } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EMAIL_TEMPLATE_PURPOSES } from '@shared/domain/types';
import type { EmailTemplatePurpose } from '@shared/domain/types';
import { DEFAULT_TEMPLATES, PERSONAL_DATA_PURPOSES, PLACEHOLDERS } from '@shared/email-templates';
import type { EmailTemplateRender } from '@shared/ipc/contract';
import { vss } from '../../lib/api';
import type { SettingsDraftProps } from './types';

const SUBJECT_MAX = 200;
const BODY_MAX = 20_000;
// eslint-disable-next-line no-control-regex
const BAD_SUBJECT = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const BAD_BODY = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** E-mail templates per purpose: editors, placeholder chips, live preview on synthetic data, reset to default. */
export function EmailTemplatesCard({ value, onChange }: SettingsDraftProps) {
  const { t } = useTranslation();
  const [purpose, setPurpose] = useState<EmailTemplatePurpose>('status-to-requestor');
  const [focus, setFocus] = useState<'subject' | 'body'>('body');
  const [preview, setPreview] = useState<EmailTemplateRender | null | 'failed'>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);

  const override = value.emailTemplates[purpose];
  const text = override ?? DEFAULT_TEMPLATES[purpose];
  const tableAllowed = PERSONAL_DATA_PURPOSES.includes(purpose);

  const setText = (next: { subject: string; body: string }) => {
    const d = DEFAULT_TEMPLATES[purpose];
    const same = next.subject === d.subject && next.body === d.body;
    onChange({ ...value, emailTemplates: { ...value.emailTemplates, [purpose]: same ? null : next } });
  };

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      vss()
        .email.previewTemplate({ template: purpose, subject: text.subject, body: text.body })
        .then(
          (r) => alive && setPreview(r.ok ? r.value : 'failed'),
          () => alive && setPreview('failed'),
        );
    }, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [purpose, text.subject, text.body]);

  const insert = (name: string) => {
    const token = `{${name}}`;
    const el = focus === 'subject' ? subjectRef.current : bodyRef.current;
    const cur = focus === 'subject' ? text.subject : text.body;
    const start = el?.selectionStart ?? cur.length;
    const end = el?.selectionEnd ?? start;
    const next = cur.slice(0, start) + token + cur.slice(end);
    setText(focus === 'subject' ? { ...text, subject: next } : { ...text, body: next });
    const caret = start + token.length;
    setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    }, 0);
  };

  const subjectError =
    text.subject.length > SUBJECT_MAX
      ? t('emailTpl.subjectTooLong', { max: SUBJECT_MAX })
      : BAD_SUBJECT.test(text.subject)
        ? t('emailTpl.controlChars')
        : undefined;
  const bodyError =
    text.body.length > BODY_MAX
      ? t('emailTpl.bodyTooLong', { max: BODY_MAX })
      : BAD_BODY.test(text.body)
        ? t('emailTpl.controlChars')
        : undefined;
  const rendered = preview && preview !== 'failed' ? preview : null;

  return (
    <Card withBorder id="card-email-templates">
      <Stack>
        <Title order={2} size="h4">
          {t('emailTpl.title')}
        </Title>
        <Text size="sm" c="dimmed">
          {t('emailTpl.help')}
        </Text>
        <Tabs value={purpose} onChange={(v) => v && setPurpose(v as EmailTemplatePurpose)}>
          <Tabs.List aria-label={t('emailTpl.purposes')}>
            {EMAIL_TEMPLATE_PURPOSES.map((p) => (
              <Tabs.Tab key={p} value={p}>
                {t(`emailTpl.purpose.${p}`)}
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs>
        <Group gap="xs">
          {override ? (
            <Badge color="orange" variant="light">
              {t('emailTpl.modified')}
            </Badge>
          ) : (
            <Badge color="gray" variant="light">
              {t('emailTpl.isDefault')}
            </Badge>
          )}
          <Button
            size="xs"
            variant="default"
            disabled={!override}
            onClick={() => onChange({ ...value, emailTemplates: { ...value.emailTemplates, [purpose]: null } })}
          >
            {t('emailTpl.reset')}
          </Button>
        </Group>
        <TextInput
          ref={subjectRef}
          label={t('emailTpl.subject')}
          value={text.subject}
          error={subjectError}
          onFocus={() => setFocus('subject')}
          onChange={(e) => setText({ ...text, subject: e.currentTarget.value })}
        />
        <Textarea
          ref={bodyRef}
          label={t('emailTpl.body')}
          value={text.body}
          rows={9}
          error={bodyError}
          onFocus={() => setFocus('body')}
          onChange={(e) => setText({ ...text, body: e.currentTarget.value })}
        />
        <Group gap="xs" role="group" aria-label={t('emailTpl.placeholders')}>
          {PLACEHOLDERS.filter((n) => n !== 'status_table' || tableAllowed).map((n) => (
            <Button
              key={n}
              size="compact-xs"
              variant="light"
              aria-label={t('emailTpl.insert', { name: `{${n}}`, interpolation: { escapeValue: false } })}
              title={t(`emailTpl.placeholderHelp.${n}`)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insert(n)}
            >
              {`{${n}}`}
            </Button>
          ))}
        </Group>
        <Stack gap={4} aria-live="polite" data-testid="email-template-preview">
          <Text fw={600} size="sm">
            {t('emailTpl.preview')}
          </Text>
          {preview === 'failed' && <Alert color="orange">{t('emailTpl.previewFailed')}</Alert>}
          {rendered && (
            <>
              {rendered.unknownPlaceholders.length > 0 && (
                <Alert color="orange" role="status">
                  {t('emailTpl.unknown', {
                    names: rendered.unknownPlaceholders.map((n) => `{${n}}`).join(', '),
                    interpolation: { escapeValue: false },
                  })}
                </Alert>
              )}
              {rendered.containsPersonalData && <Alert color="blue">{t('emailTpl.personalData')}</Alert>}
              <Text size="sm" fw={500}>
                {t('emailTpl.previewSubject')}
              </Text>
              <Code block data-testid="preview-subject">
                {rendered.subject}
              </Code>
              <Text size="sm" fw={500}>
                {t('emailTpl.previewBody')}
              </Text>
              <Code block data-testid="preview-body" style={{ whiteSpace: 'pre-wrap' }}>
                {rendered.body}
              </Code>
            </>
          )}
        </Stack>
      </Stack>
    </Card>
  );
}
