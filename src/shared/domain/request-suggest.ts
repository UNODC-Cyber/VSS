/**
 * When may the response importer pre-select a request for a response file (UI review O-03)? Only when the ranking is
 * confident AND at least one person row of the response actually matches someone on that request (T1/T2). A weak
 * guess (e.g. a score of 0.06 with no matched row) is listed, never pre-selected: the user must choose explicitly.
 *
 * Score parts (main/services/responses.ts rankRequests): batch ID 0.5, event name up to 0.25, place 0.05, date up to
 * 0.15, units up to 0.15, matched person rows up to 0.4. 0.5 needs a batch ID match or several agreeing signals.
 */
export const SUGGEST_MIN_SCORE = 0.5;
export const SUGGEST_MIN_MATCHED_ROWS = 1;

export interface RankedRequest {
  score: number;
  /** Person rows of the response with a T1/T2 candidate on this request. */
  matchedRows: number;
}

export function isConfidentSuggestion(c: RankedRequest | undefined): boolean {
  return !!c && c.score >= SUGGEST_MIN_SCORE && c.matchedRows >= SUGGEST_MIN_MATCHED_ROWS;
}
