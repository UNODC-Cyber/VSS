/**
 * S-06: section labels and DISP classification. Pure and total: every input string gets an answer, and anything that is
 * not one of the known spellings is 'unknown' (a review item), never a guess.
 */
import type { DispClass, ResponseSection } from '../../../shared/domain/types.ts';

/** What a DISP cell says on its own. 'blank' = empty cell: the row inherits its section's disposition. */
export type DispReading = DispClass | 'blank';

/** Case, width, whitespace and trailing punctuation folded; zero-width characters dropped. */
export function foldLabel(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[\u{200B}-\u{200D}\u{2060}\u{FEFF}\u{00AD}]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[\s:.;,]+$/u, '')
    .trim()
    .toLowerCase();
}

// Whole-value spellings only. A prefix rule (`/^approv/`) would read "Approval pending" as approved, which is
// exactly the silent guess S-06 forbids; anything not listed here is 'unknown' and goes to review.
const APPROVED = /^approved?$/u;
const NON_APPROVED = /^(?:(?:not|non)[\s-]*approved?|disapproved?|denied|deny|rejected?)$/u;

/** S-06: classify a DISP cell. Total: never throws, every string maps to one reading. */
export function classifyDisp(raw: string): DispReading {
  const t = foldLabel(raw);
  if (t === '') return 'blank';
  if (APPROVED.test(t)) return 'approved';
  if (NON_APPROVED.test(t)) return 'non-approved';
  return 'unknown';
}

export type SectionKind = 'unit' | 'individual';

export interface SectionLabel {
  kind: SectionKind;
  approval: 'approved' | 'non-approved';
}

const LABEL_UNIT = /^(non|not)?\s*-?\s*approved?\b.*(unit|commander)/u;
const LABEL_INDIVIDUAL = /^(non|not)?\s*-?\s*approved?\b.*individual/u;

/**
 * A known section label ("Approved Unit/Commander:", "Non-Approved Individuals" ...), or null. Matching is on the folded
 * text: case, spacing, hyphen between "Non" and "Approved" and the trailing colon do not matter.
 */
export function parseSectionLabel(raw: string): SectionLabel | null {
  const t = foldLabel(raw);
  const unit = LABEL_UNIT.exec(t);
  const ind = unit ? null : LABEL_INDIVIDUAL.exec(t);
  const m = unit ?? ind;
  if (!m) return null;
  return { kind: unit ? 'unit' : 'individual', approval: m[1] ? 'non-approved' : 'approved' };
}

/** Kind hinted by an unknown label ("Pending Review Individuals"), or null when it says neither. */
export function kindHint(raw: string): SectionKind | null {
  const t = foldLabel(raw);
  if (/\b(unit|units|commander|commanders)\b/u.test(t)) return 'unit';
  if (/\b(individual|individuals|person|persons|people)\b/u.test(t)) return 'individual';
  return null;
}

export function sectionOf(kind: SectionKind, approval: DispClass): ResponseSection {
  // 'unknown' is stored under the non-approved section: anything still reading `section` never sees an approval
  // that the DC did not state. The row's dispClass is what counts.
  const a = approval === 'approved' ? 'approved' : 'nonapproved';
  return `${a}-${kind}`;
}

export interface RowDisposition {
  dispClass: DispClass;
  /** Why the class is 'unknown', if it is. */
  problem: 'unrecognised' | 'conflict' | null;
}

/**
 * Combine a row's DISP with its section (S-06):
 * - labelled section: blank DISP inherits; same class keeps; a different known class is a conflict ('unknown');
 * - implicit first section (no label): a known DISP wins; blank inherits the implicit "approved";
 * - unknown section: only a known DISP counts; blank is unrecognised.
 */
export function resolveDisposition(
  reading: DispReading,
  section: { source: 'label' | 'implicit' | 'unknown'; approval: 'approved' | 'non-approved' | null },
): RowDisposition {
  if (reading === 'unknown') return { dispClass: 'unknown', problem: 'unrecognised' };
  if (section.source === 'unknown' || section.approval === null) {
    return reading === 'blank'
      ? { dispClass: 'unknown', problem: 'unrecognised' }
      : { dispClass: reading, problem: null };
  }
  if (reading === 'blank') return { dispClass: section.approval, problem: null };
  if (section.source === 'implicit') return { dispClass: reading, problem: null };
  return reading === section.approval
    ? { dispClass: reading, problem: null }
    : { dispClass: 'unknown', problem: 'conflict' };
}
