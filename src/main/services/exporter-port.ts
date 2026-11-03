/**
 * Port onto the INVESTc exporter (lane G, WP-09). The requests service depends on this interface only; the real
 * implementation is wired at integration, tests inject a fake.
 */
import type { ObservedPerson, ObservedUnit, ValidationIssue } from '@shared/domain/types';

export type ExporterMode = 'filter-original' | 'regenerate';

export interface ExporterInput {
  mode: ExporterMode;
  /** Original request workbook (required for 'filter-original'). */
  source?: Uint8Array;
  /** The vault's active export template (regenerate, and the filter-original fallback). VSS bundles none. */
  template?: Uint8Array;
  units: ObservedUnit[];
  people: ObservedPerson[];
  now?: Date;
}
export interface ExporterOutput {
  bytes: Uint8Array;
  issues: ValidationIssue[];
  stats: { units: number; people: number };
  /** Mode actually used; omitted means the requested mode. */
  modeUsed?: ExporterMode;
}

export interface ExporterPort {
  /** Throws an error named 'TemplateMissingError' (user-facing message) when regenerate needs a template and none is given. */
  exportInvestc(input: ExporterInput): ExporterOutput;
  suggestExportFilename(eventName: string, date: Date): string;
}
