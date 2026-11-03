import type { IsoDateTime, Ulid } from '@shared/domain/types';
import type { Db } from '../open';
import { sha256Hex } from './storedFile';
import { bool, newId, nowIso } from './util';

export type TemplateKind = 'investc-request';
export type TemplateSource = 'auto-capture' | 'manual';

export interface TemplateRecord {
  id: Ulid;
  kind: TemplateKind;
  source: TemplateSource;
  originalName: string;
  templateVersion: string | null;
  instructionsVersion: string | null;
  sha256: string;
  bytes: number;
  createdAt: IsoDateTime;
  active: boolean;
  replacedAt: IsoDateTime | null;
}

interface Row {
  id: string;
  kind: string;
  source: string;
  original_name: string;
  template_version: string | null;
  instructions_version: string | null;
  sha256: string;
  bytes: number;
  created_at: string;
  active: number;
  replaced_at: string | null;
}
const COLS =
  'id, kind, source, original_name, template_version, instructions_version, sha256, bytes, created_at, active, replaced_at';
const map = (r: Row): TemplateRecord => ({
  id: r.id,
  kind: r.kind as TemplateKind,
  source: r.source as TemplateSource,
  originalName: r.original_name,
  templateVersion: r.template_version,
  instructionsVersion: r.instructions_version,
  sha256: r.sha256,
  bytes: r.bytes,
  createdAt: r.created_at,
  active: bool(r.active),
  replacedAt: r.replaced_at,
});

/** Export templates (sanitised blank workbooks) kept in the encrypted DB; one active row per kind. */
export class TemplateRepo {
  constructor(private readonly db: Db) {}

  /** Newest first. */
  list(kind: TemplateKind): TemplateRecord[] {
    return (
      this.db
        .prepare(`SELECT ${COLS} FROM template WHERE kind = ? ORDER BY created_at DESC, id DESC`)
        .all(kind) as Row[]
    ).map(map);
  }

  get(id: Ulid): TemplateRecord | null {
    const r = this.db.prepare(`SELECT ${COLS} FROM template WHERE id = ?`).get(id) as Row | undefined;
    return r ? map(r) : null;
  }

  active(kind: TemplateKind): TemplateRecord | null {
    const r = this.db.prepare(`SELECT ${COLS} FROM template WHERE kind = ? AND active = 1`).get(kind) as
      Row | undefined;
    return r ? map(r) : null;
  }

  content(id: Ulid): Uint8Array | null {
    const r = this.db.prepare('SELECT content FROM template WHERE id = ?').get(id) as { content: Buffer } | undefined;
    return r ? new Uint8Array(r.content) : null;
  }

  /** Inserts a template and makes it the active one; the previous active row becomes history. Caller owns the tx. */
  insertActive(input: {
    kind: TemplateKind;
    source: TemplateSource;
    originalName: string;
    templateVersion: string | null;
    instructionsVersion: string | null;
    content: Uint8Array;
    at?: IsoDateTime;
    id?: Ulid;
  }): TemplateRecord {
    const id = input.id ?? newId();
    const at = input.at ?? nowIso();
    this.db
      .prepare('UPDATE template SET active = 0, replaced_at = ? WHERE kind = ? AND active = 1')
      .run(at, input.kind);
    this.db
      .prepare(
        `INSERT INTO template(id, kind, source, original_name, template_version, instructions_version, sha256, bytes, content, created_at, active, replaced_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,1,NULL)`,
      )
      .run(
        id,
        input.kind,
        input.source,
        input.originalName,
        input.templateVersion,
        input.instructionsVersion,
        sha256Hex(input.content),
        input.content.byteLength,
        Buffer.from(input.content.buffer, input.content.byteOffset, input.content.byteLength),
        at,
      );
    return this.get(id) as TemplateRecord;
  }

  /** Makes a stored (history) template the active one; the current active row becomes history. */
  setActive(id: Ulid, at: IsoDateTime = nowIso()): TemplateRecord | null {
    const t = this.get(id);
    if (!t) return null;
    if (t.active) return t;
    this.db.prepare('UPDATE template SET active = 0, replaced_at = ? WHERE kind = ? AND active = 1').run(at, t.kind);
    this.db.prepare('UPDATE template SET active = 1, replaced_at = NULL WHERE id = ?').run(id);
    return this.get(id);
  }

  delete(id: Ulid): boolean {
    return this.db.prepare('DELETE FROM template WHERE id = ?').run(id).changes > 0;
  }
}
