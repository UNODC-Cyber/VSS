import { simpleParser } from 'mailparser';
import { describe, expect, it, vi } from 'vitest';
import type { EmailDraft } from '@shared/ipc/contract';
import {
  buildDraft,
  buildEml,
  buildMailto,
  buildSubject,
  buildTable,
  encodeHeaderText,
  encodeQuotedPrintable,
  MAILTO_MAX_CHARS,
  openMailto,
} from '../../../src/main/services/email';
import type { RequestStatusSnapshot } from '../../../src/main/services/email';

// All names, units and addresses below are synthetic.
const snap: RequestStatusSnapshot = {
  eventName: 'Regional Workshop',
  asOf: '2026-11-03',
  attachmentName: 'request-batch-1.xlsx',
  rows: [
    {
      name: 'Ada TESTPERSON',
      unit: 'Unit Alpha',
      status: 'Approved',
      validUntil: '2027-05-01',
      dob: '1980-01-02',
      idNumber: 'X1234567',
    },
    {
      name: 'Bao Ngoc EXAMPLE',
      unit: 'Unit Beta',
      status: 'Pending',
      validUntil: null,
      dob: '1975-12-31',
      idNumber: 'Y7654321',
    },
    {
      name: 'Thaksin \u0E17\u0E14\u0E2A\u0E2D\u0E1A',
      unit: 'Unit \u00C9t\u00E9',
      status: 'Non-approved',
      validUntil: null,
    },
  ],
};

describe('draft text', () => {
  it('builds the subject as <Event> \u2013 vetting status \u2013 <date>', () => {
    expect(buildSubject('Regional Workshop', '2026-11-03')).toBe(
      'Regional Workshop \u2013 vetting status \u2013 2026-11-03',
    );
  });

  it('body table has Name, Unit, Status, Valid until and no DOB / IDs by default', () => {
    const d = buildDraft({ template: 'clearance-notice' }, snap);
    expect(d.subject).toBe('Regional Workshop \u2013 vetting status \u2013 2026-11-03');
    expect(d.bodyText).toContain('Name');
    expect(d.bodyText).toContain('Valid until');
    expect(d.bodyText).toContain('Ada TESTPERSON');
    expect(d.bodyText).not.toContain('1980-01-02');
    expect(d.bodyText).not.toContain('X1234567');
    expect(d.containsPersonalData).toBe(true);
  });

  it('DOB / ID columns appear only when the field set opts in', () => {
    const t = buildTable(snap.rows, { dob: true, ids: true });
    expect(t).toContain('Date of birth');
    expect(t).toContain('1980-01-02');
    expect(t).toContain('X1234567');
    expect(buildTable(snap.rows, { dob: true })).not.toContain('X1234567');
  });

  it('request-to-dc has no names in the body and names the attachment', () => {
    const d = buildDraft({ template: 'request-to-dc', to: ['dc@example.org'] }, snap);
    expect(d.containsPersonalData).toBe(false);
    expect(d.bodyText).not.toContain('Ada');
    expect(d.attachmentName).toBe('request-batch-1.xlsx');
    expect(d.to).toEqual(['dc@example.org']);
  });

  it('strips CR/LF from the event name in the subject', () => {
    expect(buildSubject('A\r\nBcc: x@example.org', '2026-11-03')).not.toMatch(/[\r\n]/);
  });
});

describe('encoders', () => {
  it('RFC 2047 words stay <= 75 chars and round-trip', () => {
    const subject = 'Atelier r\u00E9gional \u2013 \u0E17\u0E14\u0E2A\u0E2D\u0E1A '.repeat(6);
    const enc = encodeHeaderText(subject);
    for (const word of enc.split('\r\n ')) expect(word.length).toBeLessThanOrEqual(75);
    expect(enc).toMatch(/^=\?UTF-8\?B\?/);
    expect(/^[\x20-\x7e\r\n]*$/.test(enc)).toBe(true);
  });

  it('quoted-printable lines are <= 76 columns and encode trailing spaces and =', () => {
    const qp = encodeQuotedPrintable(`${'caf\u00E9 = x '.repeat(30)}\nend \n`);
    for (const line of qp.split('\r\n')) expect(line.length).toBeLessThanOrEqual(76);
    expect(qp).toContain('=3D');
    expect(qp).toMatch(/end=20(\r\n|$)/);
  });
});

describe('.eml writer (parsed back with mailparser)', () => {
  const draft: EmailDraft = {
    to: ['one@example.org', 'two@example.org'],
    cc: ['cc@example.org'],
    subject: 'Atelier r\u00E9gional \u2013 vetting status \u2013 2026-11-03',
    bodyText:
      'Dear colleagues,\n\nStatus: caf\u00E9 \u2013 \u0E17\u0E14\u0E2A\u0E2D\u0E1A\n\n' +
      'long line '.repeat(30) +
      '\n\nKind regards',
    attachmentName: null,
    containsPersonalData: false,
  };

  it('has RFC 5322 headers, X-Unsent and a UTF-8 round-tripping subject and body', async () => {
    const eml = buildEml(draft, { now: new Date('2026-11-03T10:00:00Z') });
    expect(eml).toContain('\r\nX-Unsent: 1\r\n');
    expect(eml).toContain('MIME-Version: 1.0\r\n');
    expect(eml).toContain('Date: Tue, 03 Nov 2026 10:00:00 +0000\r\n');
    expect([...eml].every((c) => c.charCodeAt(0) < 128)).toBe(true);
    expect(eml.includes('\n') && !/[^\r]\n/.test(eml)).toBe(true);
    const p = await simpleParser(eml);
    expect(p.subject).toBe(draft.subject);
    expect(p.text?.replace(/\r\n/g, '\n').trim()).toBe(draft.bodyText.trim());
    expect(p.to && !Array.isArray(p.to) ? p.to.value.map((a) => a.address) : []).toEqual([
      'one@example.org',
      'two@example.org',
    ]);
    expect(p.cc && !Array.isArray(p.cc) ? p.cc.value.map((a) => a.address) : []).toEqual(['cc@example.org']);
    expect(p.headers.get('x-unsent')).toBe('1');
  });

  it('uses base64 for mostly non-ASCII bodies', async () => {
    const thai = {
      ...draft,
      bodyText: '\u0E17\u0E14\u0E2A\u0E2D\u0E1A\u0E17\u0E14\u0E2A\u0E2D\u0E1A\u0E17\u0E14\u0E2A\u0E2D\u0E1A',
    };
    const eml = buildEml(thai);
    expect(eml).toContain('Content-Transfer-Encoding: base64');
    expect((await simpleParser(eml)).text?.trim()).toBe(thai.bodyText);
  });

  it('attaches a file as multipart/mixed with the exact bytes', async () => {
    const bytes = new Uint8Array(5000).map((_, i) => (i * 7) % 256);
    const eml = buildEml(draft, { attachment: { name: 'r\u00E9quest 1.xlsx', bytes } });
    const p = await simpleParser(eml);
    expect(p.attachments).toHaveLength(1);
    expect(Buffer.compare(p.attachments[0]!.content, Buffer.from(bytes))).toBe(0);
    expect(p.attachments[0]!.filename).toBe('r\u00E9quest 1.xlsx');
    expect(p.text?.trim()).toBe(draft.bodyText.trim());
  });

  it('rejects header-injection in addresses', () => {
    expect(() => buildEml({ ...draft, to: ['a@example.org\r\nBcc: evil@example.org'] })).toThrow();
    expect(() => buildEml({ ...draft, cc: ['not an address'] })).toThrow();
  });

  it('never opens a socket (no network modules imported by the email service)', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync('src/main/services/email.ts', 'utf8'));
    expect(src).not.toMatch(/from 'node:(net|http|https|tls|dgram|dns)'/);
  });
});

describe('mailto', () => {
  const base: EmailDraft = {
    to: ['one@example.org'],
    cc: [],
    subject: 'Event \u2013 vetting status \u2013 2026-11-03',
    bodyText: 'Line one\nLine two & more',
    attachmentName: null,
    containsPersonalData: false,
  };

  it('builds a percent-encoded URL with CRLF line breaks', () => {
    const r = buildMailto(base);
    expect(r.truncated).toBe(false);
    expect(r.url.startsWith('mailto:one%40example.org?')).toBe(true);
    expect(r.url).toContain('body=Line%20one%0D%0ALine%20two%20%26%20more');
    const u = new URL(r.url);
    expect(u.searchParams.get('subject')).toBe(base.subject);
  });

  it('drops the body above 1,800 chars and flags truncated', () => {
    const r = buildMailto({ ...base, bodyText: 'x'.repeat(5000) });
    expect(r.truncated).toBe(true);
    expect(r.url.length).toBeLessThanOrEqual(MAILTO_MAX_CHARS);
    expect(r.url).not.toContain('body=');
  });

  it('openMailto only opens mailto: URLs', async () => {
    const opener = vi.fn(async () => undefined);
    await openMailto('mailto:a%40example.org?subject=x', opener);
    expect(opener).toHaveBeenCalledTimes(1);
    for (const bad of [
      'https://example.org',
      'file:///C:/Windows/System32/calc.exe',
      'javascript:alert(1)',
      'mailto:a@example.org\r\nBcc:x',
      'MAILTO :x',
      '',
    ]) {
      await expect(openMailto(bad, opener)).rejects.toThrow();
    }
    expect(opener).toHaveBeenCalledTimes(1);
  });
});
