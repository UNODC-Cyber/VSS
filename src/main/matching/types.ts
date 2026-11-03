/** Matcher-internal types (lane-owned; the shared contract types live in src/shared/domain/types.ts). */
import type {
  DobPrecision,
  Identifier,
  IsoDate,
  IsoDateTime,
  MatchCandidate,
  NameKey,
  Sex,
  Ulid,
} from '../../shared/domain/types';

export interface DobInfo {
  date: IsoDate | null;
  precision: DobPrecision;
  /** A typical placeholder date (isPlaceholderDob): never enough for an automatic link (F-06). */
  placeholder?: boolean;
}

export interface NameVariant {
  key: NameKey;
  /** Core tokens of the surname field; null when the surname is not known. */
  surname: string[] | null;
}

export type IdentifierRef = Pick<Identifier, 'type' | 'valueFolded' | 'issuingCountry'>;

/** Common shape of both sides of a comparison. */
export interface MatchRecord {
  id: Ulid;
  /** Canonical name first, then aliases. */
  names: NameVariant[];
  dob: DobInfo;
  sex: Sex | null;
  /** Folded country (foldCountry), '' when unknown. */
  pobCountry: string;
  /** Folded place of birth below country level (foldPlace), '' or absent when unknown. */
  pobCity?: string;
  pobState?: string;
  /** Folded father's name tokens, one entry per known spelling (absent / empty when unknown). */
  fatherNames?: string[][];
  unitIds: Ulid[];
  /** Folded unit names (foldUnitName). */
  unitNames: string[];
  identifiers: IdentifierRef[];
}

/** The record being matched (request item observation, response row). */
export interface MatchSubject extends MatchRecord {
  /** Person already linked to this subject (for negative-pair lookup), if any. */
  personId?: Ulid | null;
}

export interface MatchTarget extends MatchRecord {
  kind: MatchCandidate['targetKind'];
  /** Only active persons are matchable; merged/purged targets are ignored. */
  state?: 'active' | 'merged' | 'purged';
}

/**
 * Blocking lookups. The DB lane supplies a SQL-backed implementation; InMemoryCandidateSource is the reference.
 * Every method returns targets whose data is complete enough for compareRecords (canonical name + aliases, dob, ...).
 */
export interface CandidateSource {
  byIdentifier(valuesFolded: readonly string[]): readonly MatchTarget[];
  /** Exact core key (coreKeyOf) of the canonical name or any alias. */
  byCoreKey(coreKey: string): readonly MatchTarget[];
  /** Exact DOB (any precision except unknown/year-only stored with that date). */
  byDob(dates: readonly IsoDate[]): readonly MatchTarget[];
  /** Any surname core token equal to one of the given tokens (DB lane may widen this with trigram similarity). */
  bySurname(tokens: readonly string[]): readonly MatchTarget[];
}

/** Symmetric "not the same person" pairs. */
export interface NegativePairs {
  has(a: Ulid, b: Ulid): boolean;
}

export type MatchMode = 'cross-request' | 'within-request';

export interface MatchContext {
  source?: CandidateSource;
  negativePairs?: NegativePairs;
  /** Default 'cross-request' for matchObservation(s); matchResponseRows always uses 'within-request'. */
  mode?: MatchMode;
  /** Jaro-Winkler threshold for NAME_JW_HIGH. Default 0.92. */
  jwThreshold?: number;
  /** Actor string written to RowMatch.decidedBy on automatic decisions. Default 'matcher'. */
  actor?: string;
  now?: () => IsoDateTime;
}
