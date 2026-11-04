import type { DispClass, ResponseSection } from './types';

/**
 * Disposition implied by a DC response section. Rows parsed before lane C's DISP classifier (and rows stored before
 * migration 007) take their `dispClass` from here; lane C replaces it with `classifyDisp` for new imports.
 */
export function dispClassOfSection(section: ResponseSection): DispClass {
  return section === 'approved-unit' || section === 'approved-individual' ? 'approved' : 'non-approved';
}
