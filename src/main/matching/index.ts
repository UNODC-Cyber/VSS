export {
  compareAttributes,
  compareIdentifiers,
  compareNames,
  compareFather,
  comparePlace,
  compareRecords,
  DEFAULT_JW_THRESHOLD,
  scoreOf,
} from './compare';
export type { CompareNamesOptions, NameComparison, RecordComparison } from './compare';
export { compareDob, dobFromRaw, dobLookupDates, isPlaceholderDob, swapDayMonth } from './dob';
export { assignTier, CONFLICT_EVIDENCE, T1_BLOCKERS, tierRank } from './tiers';
export { InMemoryCandidateSource, NegativePairSet } from './source';
export {
  foldFather,
  foldPlace,
  nameVariant,
  observedIdentifiers,
  observedName,
  parseSex,
  subjectFromObserved,
  subjectFromRequestItem,
  subjectFromResponseRow,
  targetFromPerson,
  targetFromRequestItem,
} from './records';
export {
  decide,
  enforceOneToOne,
  generateCandidates,
  matchObservation,
  matchObservations,
  matchResponseRows,
  preselectedCandidate,
  rankTargets,
} from './matcher';
export type * from './types';
