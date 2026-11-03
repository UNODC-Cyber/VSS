/**
 * Email support (WP-18): draft text, RFC 5322 `.eml` writer, `mailto:` builder. No network, no SMTP: the app never
 * sends mail. The `.eml` carries `X-Unsent: 1` so Outlook opens it as an editable draft.
 *
 * The request -> status data comes from an injected `RequestStatusSource` (lane H supplies it).
 */
import { randomBytes } from 'node:crypto';
import type { EmailDraft, EmailDraftRequest, EmailMailtoResult, EmailTemplateId } from '@shared/ipc/contract';

export class EmailError extends Error {
  override readonly name = 'EmailError';
  constructor(
    readonly code: 'BAD_REQUEST' | 'NOT_SUPPORTED',
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Data source (injected)
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
}
export interface RequestStatusSnapshot {
  eventName: string;
  /** ISO date the status is as of. */
  asOf: string;
  attachmentName?: string | null;
  rows: RequestStatusRow[];
}
export interface RequestStatusSource {
  snapshot(requestId: string): Promise<RequestStatusSnapshot | null>;
}
/** Reads a stored export so it can be attached to an .eml. */
export interface ExportFileSource {
  read(exportId: string): Promise<{ name: string; bytes: Uint8Array } | null>;
}

/** Which optional columns the body table includes. Default: none (Name, Unit, Status, Valid until only). */
export interface EmailFieldSet {
  dob?: boolean;
  ids?: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// Draft text
// ---------------------------------------------------------------------------------------------------------------

const EN_DASH = '\u2013';

export function buildSubject(eventName: string, asOf: string, template: EmailTemplateId = 'clearance-notice'): string {
  const what: Record<EmailTemplateId, string> = {
    'clearance-notice': 'vetting status',
    'reminder-outstanding': 'vetting status reminder',
    'request-to-dc': 'vetting request',
    'request-acknowledgement': 'vetting request received',
  };
  return `${oneLine(eventName)} ${EN_DASH} ${what[template]} ${EN_DASH} ${asOf}`;
}

const oneLine = (s: string): string => s.replace(/[\r\n\t]+/g, ' ').trim();
const cell = (s: string | null | undefined): string => oneLine(s ?? '') || '-';
const width = (s: string): number => [...s].length;
const pad = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - width(s)));

/** Plain-text table with ` | ` separators and a rule under the header. */
export function buildTable(rows: RequestStatusRow[], fields: EmailFieldSet = {}): string {
  const head = ['Name', 'Unit', 'Status', 'Valid until'];
  if (fields.dob) head.push('Date of birth');
  if (fields.ids) head.push('ID number');
  const body = rows.map((r) => {
    const line = [cell(r.name), cell(r.unit), cell(r.status), cell(r.validUntil)];
    if (fields.dob) line.push(cell(r.dob));
    if (fields.ids) line.push(cell(r.idNumber));
    return line;
  });
  const widths = head.map((h, i) => Math.max(width(h), ...body.map((l) => width(l[i] ?? ''))));
  const fmt = (l: string[]): string =>
    l
      .map((c, i) => pad(c, widths[i] ?? 0))
      .join(' | ')
      .trimEnd();
  return [fmt(head), widths.map((w) => '-'.repeat(w)).join('-+-'), ...body.map(fmt)].join('\n');
}

export function buildDraft(
  req: Pick<EmailDraftRequest, 'template' | 'to' | 'cc'>,
  snap: RequestStatusSnapshot,
  fields: EmailFieldSet = {},
): EmailDraft {
  const showTable = req.template === 'clearance-notice' || req.template === 'reminder-outstanding';
  const event = oneLine(snap.eventName);
  const intro: Record<EmailTemplateId, string> = {
    'clearance-notice': `Please find below the vetting status for ${event} as of ${snap.asOf}.`,
    'reminder-outstanding': `This is a reminder that vetting for ${event} is still outstanding. Current status as of ${snap.asOf}:`,
    'request-to-dc': `Please find attached the vetting request for ${event}.`,
    'request-acknowledgement': `We acknowledge receipt of the vetting request for ${event}.`,
  };
  const lines = ['Dear colleagues,', '', intro[req.template]];
  if (showTable && snap.rows.length > 0) lines.push('', buildTable(snap.rows, fields));
  lines.push('', 'Kind regards');
  return {
    to: req.to ?? [],
    cc: req.cc ?? [],
    subject: buildSubject(snap.eventName, snap.asOf, req.template),
    bodyText: lines.join('\n'),
    attachmentName: req.template === 'request-to-dc' ? (snap.attachmentName ?? null) : null,
    containsPersonalData: showTable && snap.rows.length > 0,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Encoders
// ---------------------------------------------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const ADDRESS = /^[^\s<>()[\]",;:\\@]+@[^\s<>()[\]",;:\\@]+$/;

export function assertAddress(a: string): string {
  if (CONTROL.test(a) || !ADDRESS.test(a) || a.length > 320)
    throw new EmailError('BAD_REQUEST', 'Invalid email address');
  return a;
}

/** RFC 2047 encoded-words (UTF-8, B encoding), each <= 75 chars, folded with CRLF SP. ASCII text is returned as is. */
export function encodeHeaderText(text: string): string {
  const flat = text.replace(/[\r\n]+/g, ' ');
  if (/^[\x20-\x7e]*$/.test(flat)) return flat;
  const words: string[] = [];
  let chunk: string[] = [];
  let bytes = 0;
  const flush = (): void => {
    if (chunk.length) words.push(`=?UTF-8?B?${Buffer.from(chunk.join(''), 'utf8').toString('base64')}?=`);
    chunk = [];
    bytes = 0;
  };
  for (const ch of flat) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > 45) flush(); // 45 bytes -> 60 base64 chars + 12 overhead = 72 <= 75
    chunk.push(ch);
    bytes += n;
  }
  flush();
  return words.join('\r\n ');
}

/** Quoted-printable (RFC 2045) of UTF-8 text, 76-column lines, CRLF line ends. */
export function encodeQuotedPrintable(text: string): string {
  const out: string[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const bytes = Buffer.from(line, 'utf8');
    let cur = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      const last = i === bytes.length - 1;
      let tok: string;
      if ((b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last)) tok = String.fromCharCode(b);
      else tok = `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
      const limit = last ? 76 : 75;
      if (cur.length + tok.length > limit) {
        out.push(`${cur}=`);
        cur = '';
      }
      cur += tok;
    }
    out.push(cur);
  }
  return out.join('\r\n');
}

export function encodeBase64Lines(bytes: Uint8Array): string {
  const b64 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  return (b64.match(/.{1,76}/g) ?? []).join('\r\n');
}

function foldAddressList(name: string, list: string[]): string {
  const addrs = list.map(assertAddress);
  return `${name}: ${addrs.join(',\r\n ')}`;
}

function rfc5322Date(d: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]}, ${p(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

export interface EmlAttachment {
  name: string;
  bytes: Uint8Array;
}

// eslint-disable-next-line no-control-regex
const safeName = (n: string): string => n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200) || 'attachment';
const asciiName = (n: string): string => n.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');

/** Build the RFC 5322 message. CRLF line endings, 7-bit clean output. */
export function buildEml(draft: EmailDraft, opts: { attachment?: EmlAttachment | null; now?: Date } = {}): string {
  const headers: string[] = [];
  if (draft.to.length) headers.push(foldAddressList('To', draft.to));
  if (draft.cc.length) headers.push(foldAddressList('Cc', draft.cc));
  headers.push(`Subject: ${encodeHeaderText(draft.subject)}`);
  headers.push(`Date: ${rfc5322Date(opts.now ?? new Date())}`);
  headers.push('X-Unsent: 1');
  headers.push('MIME-Version: 1.0');

  const nonAscii = [...Buffer.from(draft.bodyText, 'utf8')].filter((b) => b > 127).length;
  const useB64 = nonAscii > Buffer.byteLength(draft.bodyText, 'utf8') * 0.3;
  const textPart = (): string[] => [
    'Content-Type: text/plain; charset=utf-8',
    `Content-Transfer-Encoding: ${useB64 ? 'base64' : 'quoted-printable'}`,
    '',
    useB64 ? encodeBase64Lines(Buffer.from(draft.bodyText, 'utf8')) : encodeQuotedPrintable(draft.bodyText),
  ];

  const att = opts.attachment ?? null;
  if (!att) {
    return [...headers, ...textPart()].join('\r\n') + '\r\n';
  }
  const boundary = `=_vss_${randomBytes(12).toString('hex')}`;
  const fname = safeName(att.name);
  const ascii = asciiName(fname);
  const star = encodeURIComponent(fname).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const lines = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    'This is a multi-part message in MIME format.',
    `--${boundary}`,
    ...textPart(),
    `--${boundary}`,
    `Content-Type: application/octet-stream; name="${ascii}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${ascii}"; filename*=UTF-8''${star}`,
    '',
    encodeBase64Lines(att.bytes),
    `--${boundary}--`,
  ];
  return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------------------------------------------
// mailto:
// ---------------------------------------------------------------------------------------------------------------

export const MAILTO_MAX_CHARS = 1800;

const enc = (s: string): string => encodeURIComponent(s).replace(/%0A/g, '%0D%0A');

/**
 * `mailto:` URL with subject/body/cc. Over MAILTO_MAX_CHARS the BODY is dropped (recipients + subject only) and
 * `truncated` is true: the UI must then offer the .eml file or copy-to-clipboard instead.
 */
export function buildMailto(draft: EmailDraft): EmailMailtoResult {
  const to = draft.to.map(assertAddress).map(encodeURIComponent).join(',');
  const params = (withBody: boolean): string => {
    const p: string[] = [];
    if (draft.cc.length) p.push(`cc=${draft.cc.map(assertAddress).map(encodeURIComponent).join(',')}`);
    p.push(`subject=${enc(oneLine(draft.subject))}`);
    if (withBody) p.push(`body=${enc(draft.bodyText.replace(/\r\n?/g, '\n'))}`);
    return p.join('&');
  };
  const full = `mailto:${to}?${params(true)}`;
  if (full.length <= MAILTO_MAX_CHARS) return { url: full, truncated: false };
  return { url: `mailto:${to}?${params(false)}`.slice(0, MAILTO_MAX_CHARS), truncated: true };
}

/** Opens a mailto: URL through the injected opener (shell.openExternal). Anything else is refused. */
export async function openMailto(url: string, opener: (url: string) => Promise<void>): Promise<void> {
  // eslint-disable-next-line no-control-regex
  if (!/^mailto:/i.test(url) || url.length > 2048 || /[\s\u0000-\u001f]/.test(url)) {
    throw new EmailError('BAD_REQUEST', 'Only mailto: links can be opened');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EmailError('BAD_REQUEST', 'Only mailto: links can be opened');
  }
  if (parsed.protocol !== 'mailto:') throw new EmailError('BAD_REQUEST', 'Only mailto: links can be opened');
  await opener(url);
}
