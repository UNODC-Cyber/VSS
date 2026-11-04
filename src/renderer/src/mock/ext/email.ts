/**
 * LANE E mock (docs/PLAN-ALPHA.md section 7): e-mail templates. Renders with the same shared engine as main, so the
 * browser mock and the real app produce the same drafts; `email.draft` is overridden to apply the saved templates
 * and the vetting-authority / requestor default recipients.
 */
import { deriveSnapshot, isRequestAwaitingResponse } from '@shared/domain/status';
import type { EmailTemplatePurpose, VettingRequest } from '@shared/domain/types';
import {
  DEFAULT_TEMPLATES,
  SAMPLE_CONTEXT,
  buildPurposeDraft,
  renderTemplateText,
  snapshotContext,
} from '@shared/email-templates';
import type { RequestStatusSnapshot } from '@shared/email-templates';
import type { EmailTemplateId } from '@shared/ipc/contract';
import type { MockDb } from '../db';
import { mockFail, mockOk } from './types';
import type { MockExtension } from './types';

const PURPOSE: Record<EmailTemplateId, EmailTemplatePurpose> = {
  'clearance-notice': 'status-to-requestor',
  'reminder-outstanding': 'reminder',
  'request-to-dc': 'request-to-dc',
  'request-acknowledgement': 'acknowledgement',
};

const STATUS_LABEL: Record<string, string> = {
  unknown: 'Not yet vetted',
  pending: 'Pending',
  approved: 'Approved',
  expiring: 'Approved (expiring soon)',
  expired: 'Expired',
  'non-approved': 'Not approved',
};

function snapshotOf(db: MockDb, r: VettingRequest): RequestStatusSnapshot {
  const asOf = new Date().toISOString().slice(0, 10);
  return {
    eventName: r.eventName,
    asOf,
    attachmentName: r.sourceFile?.originalName ?? 'vetting-request.xlsx',
    requestorName: r.requestor.name,
    requestorOrg: r.requestor.organisation,
    requestorEmail: r.requestor.email,
    eventStart: r.eventStart,
    eventEnd: r.eventEnd,
    batchId: r.batchId,
    rows: r.items.map((i) => {
      const o = i.observed;
      const snap = i.personId
        ? deriveSnapshot({
            records: db.records.filter((x) => x.personId === i.personId),
            pending: db.requests.some(
              (q) => isRequestAwaitingResponse(q.status) && q.items.some((it) => it.personId === i.personId),
            ),
            asOf,
            expiringWithinDays: db.settings.exportPolicy.expiringWithinDays,
          })
        : null;
      const status = snap?.status ?? (i.personId ? 'unknown' : 'pending');
      return {
        name: `${o.surname}, ${[o.name1, o.name2, o.name3, o.name4].filter(Boolean).join(' ')}`,
        unit: o.unitName,
        status: STATUS_LABEL[status] ?? status,
        validUntil: status === 'non-approved' ? null : (snap?.expiresAt ?? null),
        dob: o.dob.parsed ?? (o.dob.value || null),
        idNumber: [o.passport, o.nationalId].filter((x) => x.trim() !== '').join(' / ') || null,
        approved: status === 'approved' || status === 'expiring',
      };
    }),
  };
}

export const emailMock: MockExtension = ({ db }) => {
  const locked = () => (db.vault.locked ? mockFail('VAULT_LOCKED', 'The vault is locked.') : null);
  return {
    email: {
      draft: async (req) => {
        const l = locked();
        if (l) return l;
        const r = db.requests.find((x) => x.id === req.requestId);
        if (!r) return mockFail('NOT_FOUND', 'Request not found.');
        const fields = { dob: req.fields?.dob === true, ids: req.fields?.ids === true };
        return mockOk(
          buildPurposeDraft(
            PURPOSE[req.template],
            snapshotOf(db, r),
            fields,
            { templates: db.settings.emailTemplates, authority: db.settings.vettingAuthority },
            { to: req.to, cc: req.cc },
          ),
        );
      },
      renderTemplate: async (req) => {
        const l = locked();
        if (l) return l;
        const r = db.requests.find((x) => x.id === req.requestId);
        if (!r) return mockFail('NOT_FOUND', 'Request not found.');
        const stored = db.settings.emailTemplates[req.template] ?? DEFAULT_TEMPLATES[req.template];
        const text = { subject: req.overrides?.subject ?? stored.subject, body: req.overrides?.body ?? stored.body };
        return mockOk(renderTemplateText(req.template, text, snapshotContext(snapshotOf(db, r))));
      },
      previewTemplate: async (req) =>
        mockOk(renderTemplateText(req.template, { subject: req.subject, body: req.body }, SAMPLE_CONTEXT)),
    },
  };
};
