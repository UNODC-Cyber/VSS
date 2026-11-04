import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/domain/types';
import type { EmailTemplatePurpose, Settings } from '@shared/domain/types';
import {
  DEFAULT_TEMPLATES,
  PLACEHOLDERS,
  SAMPLE_CONTEXT,
  placeholdersIn,
  renderTemplateText,
  unknownIn,
} from '@shared/email-templates';
import { emailTemplatePurposeSchema, emailTemplateTextSchema, settingsSchema } from '@shared/ipc/schemas';
import { buildDraft, buildSubject } from '../../../src/main/services/email';
import type { RequestStatusSnapshot } from '../../../src/main/services/email';
import { createEmailTemplatesService } from '../../../src/main/services/email-templates';
import type { EmailTemplatesDeps } from '../../../src/main/services/email-templates';

// Synthetic data only.
const snap: RequestStatusSnapshot = {
  eventName: 'Example Workshop',
  asOf: '2027-01-10',
  attachmentName: 'example-request.xlsx',
  requestorName: 'Sample Requestor',
  requestorOrg: 'Example Org',
  requestorEmail: 'requestor@example.invalid',
  eventStart: '2027-03-01',
  eventEnd: '2027-03-05',
  batchId: 'EX-1',
  rows: [
    { name: 'EXAMPLE, Ada', unit: 'Unit A', status: 'Approved', validUntil: '2027-09-01' },
    { name: 'SAMPLE, Bao', unit: 'Unit B', status: 'Approved', validUntil: '2027-06-30' },
    { name: 'TEST, Cam', unit: 'Unit B', status: 'Pending', validUntil: '2027-01-01' },
  ],
};

const withTemplate = (p: EmailTemplatePurpose, t: { subject: string; body: string } | null): Settings => ({
  ...DEFAULT_SETTINGS,
  emailTemplates: { ...DEFAULT_SETTINGS.emailTemplates, [p]: t },
});

describe('template engine', () => {
  it('replaces every known placeholder', () => {
    const body = PLACEHOLDERS.filter((n) => n !== 'status_table')
      .map((n) => `{${n}}`)
      .join('|');
    const r = renderTemplateText('acknowledgement', { subject: '{event} {event_dates}', body }, SAMPLE_CONTEXT);
    expect(r.unknownPlaceholders).toEqual([]);
    expect(r.body).not.toMatch(/\{[a-z_]+\}/);
    expect(r.body).toContain('Example Vetting Office');
  });

  it('keeps unknown placeholders literal and reports them once', () => {
    const r = renderTemplateText(
      'acknowledgement',
      { subject: 'S {nope}', body: '{nope} {oops} {nope} {a b} {event}' },
      SAMPLE_CONTEXT,
    );
    expect(r.subject).toBe('S {nope}');
    expect(r.body).toBe('{nope} {oops} {nope} {a b} Example Regional Workshop');
    expect(r.unknownPlaceholders).toEqual(['nope', 'oops']);
  });

  it('expands {status_table} only in status and reminder bodies and flags personal data', () => {
    for (const p of ['status-to-requestor', 'reminder'] as const) {
      const r = renderTemplateText(p, { subject: 'x', body: '{status_table}' }, SAMPLE_CONTEXT);
      expect(r.containsPersonalData).toBe(true);
      expect(r.body).toContain('EXAMPLE, Sample Person');
    }
    for (const p of ['all-clear', 'request-to-dc', 'acknowledgement'] as const) {
      const r = renderTemplateText(p, { subject: 'x', body: '{status_table}' }, SAMPLE_CONTEXT);
      expect(r.containsPersonalData).toBe(false);
      expect(r.body).toBe('{status_table}');
      expect(r.unknownPlaceholders).toEqual(['status_table']);
    }
    const s = renderTemplateText('reminder', { subject: '{status_table}', body: 'b' }, SAMPLE_CONTEXT);
    expect(s.subject).toBe('{status_table}');
    expect(unknownIn('reminder', '{status_table} {x}')).toEqual(['x']);
    expect(placeholdersIn('{a}{b}{a}')).toEqual(['a', 'b']);
  });

  it('values cannot inject line breaks into the subject', () => {
    const ctx = { ...SAMPLE_CONTEXT, event: 'A\r\nBcc: x@example.invalid' };
    const r = renderTemplateText('acknowledgement', { subject: '{event}', body: 'b' }, ctx);
    expect(r.subject).not.toMatch(/[\r\n]/);
  });

  it('every default only uses allowed placeholders and fits the schema', () => {
    for (const p of Object.keys(DEFAULT_TEMPLATES) as EmailTemplatePurpose[]) {
      const t = DEFAULT_TEMPLATES[p];
      expect(unknownIn(p, `${t.subject}\n${t.body}`)).toEqual([]);
      expect(emailTemplateTextSchema.safeParse(t).success).toBe(true);
      expect(emailTemplatePurposeSchema.safeParse(p).success).toBe(true);
    }
  });
});

describe('drafts', () => {
  it('default templates reproduce the 0.1 subjects and bodies', () => {
    const d = buildDraft({ template: 'clearance-notice' }, snap);
    expect(d.subject).toBe(buildSubject('Example Workshop', '2027-01-10', 'clearance-notice'));
    expect(d.bodyText).toMatch(
      /^Dear colleagues,\n\nPlease find below the vetting status for Example Workshop as of 2027-01-10\.\n\nName/,
    );
    expect(d.bodyText.endsWith('\n\nKind regards')).toBe(true);
    const ack = buildDraft({ template: 'request-acknowledgement' }, snap);
    expect(ack.bodyText).toBe(
      'Dear colleagues,\n\nWe acknowledge receipt of the vetting request for Example Workshop.\n\nKind regards',
    );
    expect(ack.subject).toBe(buildSubject('Example Workshop', '2027-01-10', 'request-acknowledgement'));
    expect(buildDraft({ template: 'request-to-dc' }, snap).subject).toBe(
      buildSubject('Example Workshop', '2027-01-10', 'request-to-dc'),
    );
    expect(buildDraft({ template: 'reminder-outstanding' }, snap).subject).toBe(
      buildSubject('Example Workshop', '2027-01-10', 'reminder-outstanding'),
    );
  });

  it('an empty status table leaves no hole', () => {
    const d = buildDraft({ template: 'clearance-notice' }, { ...snap, rows: [] });
    expect(d.bodyText).toBe(
      'Dear colleagues,\n\nPlease find below the vetting status for Example Workshop as of 2027-01-10.\n\nKind regards',
    );
    expect(d.containsPersonalData).toBe(false);
  });

  it('a changed template appears in the draft; null restores the default', () => {
    const custom = withTemplate('acknowledgement', { subject: 'Got it: {event}', body: 'Hello {requestor_name}' });
    const d = buildDraft({ template: 'request-acknowledgement' }, snap, {}, { templates: custom.emailTemplates });
    expect(d.subject).toBe('Got it: Example Workshop');
    expect(d.bodyText).toBe('Hello Sample Requestor');
    const back = buildDraft(
      { template: 'request-acknowledgement' },
      snap,
      {},
      { templates: DEFAULT_SETTINGS.emailTemplates },
    );
    expect(back.subject).toContain('vetting request received');
  });

  it('{valid_until} is the earliest expiry among approved individuals', () => {
    const s = withTemplate('acknowledgement', { subject: 's', body: '{valid_until} {event_dates} {batch_id}' });
    const d = buildDraft({ template: 'request-acknowledgement' }, snap, {}, { templates: s.emailTemplates });
    expect(d.bodyText).toBe('2027-06-30 2027-03-01 – 2027-03-05 EX-1');
  });

  it('request-to-dc defaults To/Cc from the vetting authority; requestor purposes To the requestor', () => {
    const authority = {
      to: [{ name: 'Desk', email: 'desk@example.invalid' }],
      cc: [{ name: 'Lead', email: 'lead@example.invalid' }],
    };
    const dc = buildDraft({ template: 'request-to-dc' }, snap, {}, { authority });
    expect(dc.to).toEqual(['desk@example.invalid']);
    expect(dc.cc).toEqual(['lead@example.invalid']);
    expect(dc.attachmentName).toBe('example-request.xlsx');
    const rq = buildDraft({ template: 'clearance-notice' }, snap, {}, { authority });
    expect(rq.to).toEqual(['requestor@example.invalid']);
    expect(rq.cc).toEqual([]);
    const explicit = buildDraft({ template: 'request-to-dc', to: ['x@example.invalid'] }, snap, {}, { authority });
    expect(explicit.to).toEqual(['x@example.invalid']);
    expect(buildDraft({ template: 'clearance-notice' }, { ...snap, requestorEmail: 'not an address' }).to).toEqual([]);
  });
});

describe('settings schema', () => {
  it('accepts templates and contacts, rejects bad addresses and oversize text', () => {
    const ok = {
      ...DEFAULT_SETTINGS,
      emailTemplates: { ...DEFAULT_SETTINGS.emailTemplates, reminder: { subject: 'S', body: 'B' } },
      vettingAuthority: { to: [{ name: 'Desk', email: 'desk@example.invalid' }], cc: [] },
    };
    expect(settingsSchema.safeParse(ok).success).toBe(true);
    const badMail = { ...ok, vettingAuthority: { to: [{ name: 'D', email: 'nope' }], cc: [] } };
    expect(settingsSchema.safeParse(badMail).success).toBe(false);
    const longSubject = {
      ...ok,
      emailTemplates: { ...ok.emailTemplates, reminder: { subject: 'x'.repeat(201), body: 'B' } },
    };
    expect(settingsSchema.safeParse(longSubject).success).toBe(false);
  });
});

describe('email template service', () => {
  const deps = (settings: Settings, withSnap = true) =>
    ({
      settings: () => settings,
      snapshot: withSnap ? (id: string) => (id === 'r1' ? snap : null) : undefined,
    }) as unknown as EmailTemplatesDeps;
  const id = (s: string) => s as never;

  it('preview renders the synthetic sample and never needs a snapshot', async () => {
    const svc = createEmailTemplatesService(deps(DEFAULT_SETTINGS, false));
    const r = await svc.previewTemplate({ template: 'reminder', subject: '{event}', body: '{status_table} {zzz}' });
    expect(r.ok && r.value.subject).toBe('Example Regional Workshop');
    expect(r.ok && r.value.unknownPlaceholders).toEqual(['zzz']);
    expect(r.ok && r.value.body).not.toContain('Example Workshop');
  });

  it('renderTemplate uses the stored override, then dialog overrides, on real request data', async () => {
    const s = withTemplate('all-clear', { subject: 'Cleared {event}', body: 'Until {valid_until}' });
    const svc = createEmailTemplatesService(deps(s));
    const a = await svc.renderTemplate({ template: 'all-clear', requestId: id('r1') });
    expect(a.ok && a.value).toMatchObject({ subject: 'Cleared Example Workshop', body: 'Until 2027-06-30' });
    const b = await svc.renderTemplate({
      template: 'all-clear',
      requestId: id('r1'),
      overrides: { body: 'X {batch_id}' },
    });
    expect(b.ok && b.value.body).toBe('X EX-1');
    const missing = await svc.renderTemplate({ template: 'all-clear', requestId: id('zz') });
    expect(!missing.ok && missing.error.code).toBe('NOT_FOUND');
    const none = await createEmailTemplatesService(deps(s, false)).renderTemplate({
      template: 'all-clear',
      requestId: id('r1'),
    });
    expect(!none.ok && none.error.code).toBe('NOT_SUPPORTED');
  });
});
