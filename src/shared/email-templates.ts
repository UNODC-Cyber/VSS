/**
 * E-mail template engine (lane E, docs/PLAN-ALPHA.md section 7). Pure and dependency-free so main (drafts), the
 * IPC preview and the browser mock render exactly the same text. Placeholders are `{name}`; an unknown one stays
 * literal and is reported. `{status_table}` expands only in purposes that may carry personal data.
 */
import type { Contact, EmailTemplatePurpose, EmailTemplateText, Settings } from './domain/types';
import { isValidEmailAddress } from './email-address';

export const EN_DASH = '–';

export const PLACEHOLDERS = [
  'requestor_name',
  'requestor_org',
  'event',
  'event_dates',
  'status_table',
  'valid_until',
  'batch_id',
  'as_of',
  'attachment_name',
  'office_name',
] as const;
export type PlaceholderName = (typeof PLACEHOLDERS)[number];
export type TemplateContext = Record<PlaceholderName, string>;

/** Purposes whose body may list individuals (and therefore may use `{status_table}`). */
export const PERSONAL_DATA_PURPOSES: readonly EmailTemplatePurpose[] = ['status-to-requestor', 'reminder'];
/** Purposes addressed to the requestor by default (To = the requestor's e-mail). */
export const REQUESTOR_PURPOSES: readonly EmailTemplatePurpose[] = [
  'status-to-requestor',
  'all-clear',
  'reminder',
  'acknowledgement',
];

export const DEFAULT_TEMPLATES: Readonly<Record<EmailTemplatePurpose, EmailTemplateText>> = {
  'status-to-requestor': {
    subject: `{event} ${EN_DASH} vetting status ${EN_DASH} {as_of}`,
    body: 'Dear colleagues,\n\nPlease find below the vetting status for {event} as of {as_of}.\n\n{status_table}\n\nKind regards',
  },
  'all-clear': {
    subject: `{event} ${EN_DASH} vetting cleared ${EN_DASH} {as_of}`,
    body: 'Dear colleagues,\n\nAll individuals listed for {event} have been cleared. The earliest clearance is valid until {valid_until}.\n\nKind regards',
  },
  'request-to-dc': {
    subject: `{event} ${EN_DASH} vetting request ${EN_DASH} {as_of}`,
    body: 'Dear colleagues,\n\nPlease find attached the vetting request for {event}.\n\nKind regards',
  },
  reminder: {
    subject: `{event} ${EN_DASH} vetting status reminder ${EN_DASH} {as_of}`,
    body: 'Dear colleagues,\n\nThis is a reminder that vetting for {event} is still outstanding. Current status as of {as_of}:\n\n{status_table}\n\nKind regards',
  },
  acknowledgement: {
    subject: `{event} ${EN_DASH} vetting request received ${EN_DASH} {as_of}`,
    body: 'Dear colleagues,\n\nWe acknowledge receipt of the vetting request for {event}.\n\nKind regards',
  },
};

/** Fixed, invented sample for the live preview. Never vault data. */
export const SAMPLE_CONTEXT: Readonly<TemplateContext> = {
  requestor_name: 'Sample Requestor',
  requestor_org: 'Example Organisation',
  event: 'Example Regional Workshop',
  event_dates: `2027-03-01 ${EN_DASH} 2027-03-05`,
  status_table: [
    '1. Name: EXAMPLE, Sample Person',
    '   Unit: Example Unit',
    '   Status: Approved',
    '   Valid until: 2027-06-30',
    '',
    '2. Name: SAMPLE, Test Person',
    '   Unit: Example Unit',
    '   Status: Pending',
    '   Valid until: -',
  ].join('\n'),
  valid_until: '2027-06-30',
  batch_id: 'EX-0001',
  as_of: '2027-02-15',
  attachment_name: 'example-request.xlsx',
  office_name: 'Example Vetting Office',
};

export interface RenderedTemplate {
  subject: string;
  body: string;
  /** Distinct unrecognised (or not allowed in this purpose) placeholders, in order of appearance, without braces. */
  unknownPlaceholders: string[];
  containsPersonalData: boolean;
}

export const oneLine = (s: string): string => s.replace(/[\r\n\t]+/g, ' ').trim();

const PLACEHOLDER_RE = /\{([A-Za-z0-9_]{1,64})\}/g;
const known = new Set<string>(PLACEHOLDERS);

/** Names of all `{word}` tokens in a text, in order of appearance (with repeats removed). */
export function placeholdersIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

/** Names that are not usable in `purpose` (unknown, or `status_table` where personal data is not allowed). */
export function unknownIn(purpose: EmailTemplatePurpose, text: string): string[] {
  const table = PERSONAL_DATA_PURPOSES.includes(purpose);
  return placeholdersIn(text).filter((n) => !known.has(n) || (n === 'status_table' && !table));
}

/** Render subject and body of one template against `ctx`. */
export function renderTemplateText(
  purpose: EmailTemplatePurpose,
  text: EmailTemplateText,
  ctx: Readonly<TemplateContext>,
): RenderedTemplate {
  const tableOk = PERSONAL_DATA_PURPOSES.includes(purpose);
  const unknown = new Set<string>();
  let tableExpanded = false;
  const expand = (src: string, inBody: boolean): string =>
    src.replace(PLACEHOLDER_RE, (whole, name: string) => {
      if (!known.has(name)) {
        unknown.add(name);
        return whole;
      }
      if (name === 'status_table') {
        if (!tableOk || !inBody) {
          unknown.add(name);
          return whole;
        }
        tableExpanded = tableExpanded || ctx.status_table !== '';
        return ctx.status_table;
      }
      return oneLine(ctx[name as PlaceholderName]);
    });
  const subject = oneLine(expand(text.subject, false));
  let body = expand(text.body, true);
  // An empty table must not leave a hole in the message.
  if (tableOk && ctx.status_table === '' && /\{status_table\}/.test(text.body)) body = body.replace(/\n{3,}/g, '\n\n');
  return {
    subject,
    body,
    unknownPlaceholders: [...unknown],
    containsPersonalData: tableExpanded,
  };
}

/** Render the stored override or the built-in default of a purpose. */
export function renderPurpose(
  purpose: EmailTemplatePurpose,
  override: EmailTemplateText | null | undefined,
  ctx: Readonly<TemplateContext>,
): RenderedTemplate {
  return renderTemplateText(purpose, override ?? DEFAULT_TEMPLATES[purpose], ctx);
}

// ---------------------------------------------------------------------------------------------------------------
// Request snapshot -> context, status table, draft
// ---------------------------------------------------------------------------------------------------------------

export interface RequestStatusRow {
  /** Name exactly as submitted. */
  name: string;
  unit: string;
  /** Human-readable status label. */
  status: string;
  /** ISO date or null. */
  validUntil: string | null;
  dob?: string | null;
  /** Passport / national ID, only used when the field set opts in. */
  idNumber?: string | null;
  /** true when the person is currently approved (drives `{valid_until}`); default: status label starts with Approved. */
  approved?: boolean;
}
export interface RequestStatusSnapshot {
  eventName: string;
  /** ISO date the status is as of. */
  asOf: string;
  attachmentName?: string | null;
  /** Requestor and event details for template placeholders and default recipients (lane E). */
  requestorName?: string | null;
  requestorOrg?: string | null;
  requestorEmail?: string | null;
  eventStart?: string | null;
  eventEnd?: string | null;
  batchId?: string | null;
  officeName?: string | null;
  rows: RequestStatusRow[];
}

/** Which optional columns the body table includes. Default: none (Name, Unit, Status, Valid until only). */
export interface EmailFieldSet {
  dob?: boolean;
  ids?: boolean;
}

const cell = (s: string | null | undefined): string => oneLine(s ?? '') || '-';

/**
 * The `{status_table}` text: one numbered block per person, one labelled field per line, a blank line between
 * people (UI review round 3, R3O-06). It is plain text that survives any mail client: no column alignment (which
 * breaks in proportional fonts and when lines wrap), no `|` rules, and no line depends on the length of another.
 * The same text goes into mailto: links, the clipboard and the text/plain part of a saved .eml.
 */
export function buildStatusTable(rows: RequestStatusRow[], fields: EmailFieldSet = {}): string {
  return rows
    .map((r, i) => {
      const num = `${i + 1}. `;
      const indent = ' '.repeat(num.length);
      const lines = [
        `${num}Name: ${cell(r.name)}`,
        `${indent}Unit: ${cell(r.unit)}`,
        `${indent}Status: ${cell(r.status)}`,
        `${indent}Valid until: ${cell(r.validUntil)}`,
      ];
      if (fields.dob) lines.push(`${indent}Date of birth: ${cell(r.dob)}`);
      if (fields.ids) lines.push(`${indent}ID number: ${cell(r.idNumber)}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

/** Template context for a request snapshot (`fields` choose the optional columns of `{status_table}`). */
export function snapshotContext(snap: RequestStatusSnapshot, fields: EmailFieldSet = {}): TemplateContext {
  const approved = snap.rows.filter((r) => r.approved ?? /^approved/i.test(r.status));
  const expiries = approved.flatMap((r) => (r.validUntil ? [r.validUntil] : [])).sort();
  const dates = [snap.eventStart, snap.eventEnd].filter((d): d is string => !!d);
  return {
    requestor_name: snap.requestorName ?? '',
    requestor_org: snap.requestorOrg ?? '',
    event: snap.eventName,
    event_dates: dates.length === 2 && dates[0] !== dates[1] ? `${dates[0]} ${EN_DASH} ${dates[1]}` : (dates[0] ?? ''),
    status_table: snap.rows.length > 0 ? buildStatusTable(snap.rows, fields) : '',
    valid_until: expiries[0] ?? '',
    batch_id: snap.batchId ?? '',
    as_of: snap.asOf,
    attachment_name: snap.attachmentName ?? '',
    office_name: snap.officeName ?? '',
  };
}

export interface DraftSettings {
  /** Settings.emailTemplates: a user override per purpose, or null = built-in default. */
  templates?: Settings['emailTemplates'];
  /** Settings.vettingAuthority: default To / Cc of the request-to-DC draft. */
  authority?: Settings['vettingAuthority'];
}

export interface TemplateDraft {
  to: string[];
  cc: string[];
  subject: string;
  bodyText: string;
  attachmentName: string | null;
  containsPersonalData: boolean;
}

/**
 * Draft for one purpose. Default recipients: the vetting authority (To/Cc from settings) for `request-to-dc`, the
 * requestor's address (To only) for everything else; explicit `to` / `cc` win.
 */
export function buildPurposeDraft(
  purpose: EmailTemplatePurpose,
  snap: RequestStatusSnapshot,
  fields: EmailFieldSet = {},
  cfg: DraftSettings = {},
  explicit: { to?: string[] | undefined; cc?: string[] | undefined } = {},
): TemplateDraft {
  const r = renderPurpose(purpose, cfg.templates?.[purpose], snapshotContext(snap, fields));
  const emails = (list: Contact[] | undefined): string[] => (list ?? []).map((c) => c.email);
  const requestorTo = snap.requestorEmail && isValidEmailAddress(snap.requestorEmail) ? [snap.requestorEmail] : [];
  const toDc = purpose === 'request-to-dc';
  return {
    to: explicit.to ?? (toDc ? emails(cfg.authority?.to) : requestorTo),
    cc: explicit.cc ?? (toDc ? emails(cfg.authority?.cc) : []),
    subject: r.subject,
    bodyText: r.body,
    attachmentName: toDc ? (snap.attachmentName ?? null) : null,
    containsPersonalData: r.containsPersonalData,
  };
}
