import { describe, expect, it } from 'vitest';
import { ALL_CHANNELS, METHODS, parseChannel } from '@shared/ipc/channels';
import { ERROR_CODES, EVENT_NAMES } from '@shared/ipc/contract';
import { eventSchemas, ipcSchemas, schemasForChannel, vssErrorSchema } from '@shared/ipc/schemas';
import { DEFAULT_SETTINGS } from '@shared/domain/types';
import { settingsSchema } from '@shared/ipc/schemas';

describe('ipc contract', () => {
  it('every channel has request and response schemas', () => {
    expect(ALL_CHANNELS.length).toBeGreaterThan(60);
    for (const ch of ALL_CHANNELS) {
      const s = schemasForChannel(ch);
      expect(s, ch).not.toBeNull();
    }
  });
  it('schema table and METHODS agree exactly', () => {
    for (const [ns, methods] of Object.entries(METHODS)) {
      const table = (ipcSchemas as Record<string, Record<string, unknown>>)[ns]!;
      expect(Object.keys(table).sort()).toEqual([...methods].sort());
    }
  });
  it('channel names follow vss:<ns>.<method>', () => {
    for (const ch of ALL_CHANNELS) expect(ch).toMatch(/^vss:[a-z]+\.[A-Za-z0-9]+$/);
    expect(parseChannel('vss:vault.unlock')).toEqual(['vault', 'unlock']);
    expect(parseChannel('vss:vault.nope')).toBeNull();
    expect(parseChannel('vss:evil.exec')).toBeNull();
  });
  it('no-argument methods accept only undefined', () => {
    const s = schemasForChannel('vss:vault.status')!;
    expect(s.req.safeParse(undefined).success).toBe(true);
    expect(s.req.safeParse({}).success).toBe(false);
  });
  it('request objects are strict and bounded', () => {
    const s = schemasForChannel('vss:persons.list')!;
    expect(s.req.safeParse({ offset: 0, limit: 50 }).success).toBe(true);
    expect(s.req.safeParse({ offset: 0, limit: 50, extra: 1 }).success).toBe(false);
    expect(s.req.safeParse({ offset: 0, limit: 100000 }).success).toBe(false);
    expect(s.req.safeParse({ offset: -1, limit: 10 }).success).toBe(false);
  });
  it('requires well-formed ids', () => {
    const s = schemasForChannel('vss:requests.get')!;
    expect(s.req.safeParse({ id: '01HZZZZZZZZZZZZZZZZZZZZZZZ' }).success).toBe(true);
    expect(s.req.safeParse({ id: '../../etc/passwd' }).success).toBe(false);
  });
  it('wipe needs the literal confirmation', () => {
    const s = schemasForChannel('vss:vault.wipe')!;
    expect(s.req.safeParse({ password: 'x', confirm: 'WIPE' }).success).toBe(true);
    expect(s.req.safeParse({ password: 'x', confirm: 'wipe' }).success).toBe(false);
  });
  it('save-dialog suggested names cannot contain path separators', () => {
    const s = schemasForChannel('vss:files.pickSave')!;
    expect(s.req.safeParse({ kind: 'any', suggestedName: 'a.xlsx' }).success).toBe(true);
    expect(s.req.safeParse({ kind: 'any', suggestedName: '..\\a.xlsx' }).success).toBe(false);
  });
  it('default settings satisfy the settings schema', () => {
    expect(settingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true);
  });
  it('every event has a payload schema and error codes are unique', () => {
    expect(Object.keys(eventSchemas).sort()).toEqual([...EVENT_NAMES].sort());
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    expect(vssErrorSchema.safeParse({ code: 'VAULT_LOCKED', message: 'locked' }).success).toBe(true);
    expect(vssErrorSchema.safeParse({ code: 'MADE_UP', message: 'x' }).success).toBe(false);
  });
  it('review resolutions are a closed union', () => {
    const s = schemasForChannel('vss:review.resolve')!;
    const id = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
    expect(s.req.safeParse({ id, resolution: { action: 'dismiss' } }).success).toBe(true);
    expect(s.req.safeParse({ id, resolution: { action: 'delete-everything' } }).success).toBe(false);
  });

  it('lane J reconciliation: vault create has no directory, new codes exist, new payloads validate', () => {
    const id = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
    const create = schemasForChannel('vss:vault.create')!;
    expect(create.req.safeParse({ password: 'x'.repeat(12), displayName: 'a' }).success).toBe(true);
    expect(create.req.safeParse({ directory: 'C:/x', password: 'x'.repeat(12), displayName: 'a' }).success).toBe(false);
    expect(ERROR_CODES).toContain('SCHEMA_NEWER_THAN_APP');
    expect(ERROR_CODES).toContain('VAULT_TAMPERED');
    const commit = schemasForChannel('vss:responses.importCommit')!;
    expect(commit.req.safeParse({ previewId: 'p', requestId: id, decisions: { [id]: 'skip' } }).success).toBe(true);
    expect(commit.req.safeParse({ previewId: 'p', requestId: id, decisions: { [id]: 'maybe' } }).success).toBe(false);
    expect(commit.req.safeParse({ previewId: 'p', requestId: id, decisions: { 'not-an-id': 'new' } }).success).toBe(
      false,
    );
    const ex = schemasForChannel('vss:requests.export')!;
    expect(
      ex.req.safeParse({ requestId: id, mode: 'regenerate', destPath: 'C:/a.xlsx', overrideReason: 'ok' }).success,
    ).toBe(true);
    const draft = schemasForChannel('vss:email.draft')!;
    expect(draft.req.safeParse({ template: 'clearance-notice', requestId: id, fields: { dob: true } }).success).toBe(
      true,
    );
    expect(draft.req.safeParse({ template: 'clearance-notice', requestId: id, fields: { nin: true } }).success).toBe(
      false,
    );
    const pick = schemasForChannel('vss:files.pickOpen')!;
    expect(pick.req.safeParse({ kind: 'directory' }).success).toBe(true);
    const cfg = schemasForChannel('vss:backup.configure')!;
    const config = { dir: 'D:/backups', keep: 3, onLock: true, everyHours: null };
    expect(cfg.req.safeParse({ config, reauth: { password: 'p' } }).success).toBe(true);
    // the passphrase is generated by VSS, never supplied by the renderer
    expect(
      cfg.req.safeParse({ config: { ...config, passphrase: 'x'.repeat(20) }, reauth: { password: 'p' } }).success,
    ).toBe(false);
    expect(cfg.req.safeParse({ config, reauth: {} }).success).toBe(false);
    expect(schemasForChannel('vss:stats.exportExpiryCsv')!.req.safeParse({ destPath: 'C:/a.csv' }).success).toBe(false);
    expect(
      schemasForChannel('vss:persons.split')!.req.safeParse({ personId: id, itemIds: [], reason: 'r' }).success,
    ).toBe(false);
  });
});
