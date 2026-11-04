-- VSS schema slot 008 (lane K, docs/PLAN-ALPHA.md section 14): review edits and manual validation. Additive only.
-- 1. response_row.original_json: the row's stored columns exactly as imported from the DC file, written on the first
--    correction only, so the DC original is always kept and a revert restores it byte for byte.
-- 2. response_row_edit: one row per correction or revert (who, when, why, field diff). Personal data: purge clears it.
-- 3. person_edit: the same provenance for person record corrections (persons.update and review.editSubject).
-- 4. review_item.resolution_note: the free-text reason of a manual validation (never copied into the audit text).
ALTER TABLE response_row ADD COLUMN original_json TEXT;
CREATE TABLE response_row_edit(id TEXT PRIMARY KEY, row_id TEXT NOT NULL REFERENCES response_row(id), at TEXT NOT NULL,
  actor TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', diff_json TEXT NOT NULL);
CREATE INDEX response_row_edit_row ON response_row_edit(row_id, at);
CREATE TABLE person_edit(id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES person(id), at TEXT NOT NULL,
  actor TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', diff_json TEXT NOT NULL);
CREATE INDEX person_edit_person ON person_edit(person_id, at);
ALTER TABLE review_item ADD COLUMN resolution_note TEXT;
