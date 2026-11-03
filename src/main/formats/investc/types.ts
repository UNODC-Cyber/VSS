import type { ObservedPerson, ObservedUnit, ValidationIssue } from '../../../shared/domain/types.ts';
import type { ReferenceData } from './reference.ts';

/** A ValidationIssue that also records the rule (R-01..R-15) that raised it. Assignable to ValidationIssue. */
export interface RuleIssue extends ValidationIssue {
  rule: string;
}

export interface RequestLayout {
  /** First unit row (always 4 in the template). */
  firstUnitRow: number;
  separatorRow: number | null;
  individualsRow: number | null;
  individualsHeaderRow: number | null;
  firstPersonRow: number | null;
  /** Last row that held an individual. */
  lastPersonRow: number | null;
}

export interface ParsedInvestc {
  /** Version from `Template Instructions!C2` (e.g. 1.11.0); null when the cell does not match. */
  templateVersion: string | null;
  /** Version from `Template Instructions!A2` (e.g. 2.6.0); null when the cell does not match. */
  instructionsVersion: string | null;
  units: ObservedUnit[];
  people: ObservedPerson[];
  /** Structural issues (R-01..R-05). Value rules (R-06..R-15) come from validateRequest. */
  issues: RuleIssue[];
  /** Lists and limits actually in force for this file (own Reference Data when present, else bundled). */
  reference: ReferenceData;
  layout: RequestLayout;
}

/** What validateRequest needs to know about a person row to look it up in the database. */
export interface PersonLookupQuery {
  rowRef: string;
  /** Particle-free sorted token key of the row's name fields. */
  coreKey: string;
  /** Parsed DOB (MM/DD reading), null when absent or invalid. */
  dobIso: string | null;
  passport: string;
  nationalId: string;
}

/** The database's view of a person, as returned by the lookup. */
export interface KnownPerson {
  coreKey: string;
  dobIso: string | null;
  passports: string[];
  nationalIds: string[];
  nonApproved: boolean;
}

/** Injected database expectations for R-15. Implemented by the DB lane; tests use stubs. */
export interface RequestLookups {
  /** Has this unit (trimmed, whitespace-collapsed name) been seen in earlier requests? */
  isKnownUnit(normalizedName: string): boolean;
  /** The existing person this row most plausibly refers to, or null. */
  findKnownPerson(q: PersonLookupQuery): KnownPerson | null;
}
