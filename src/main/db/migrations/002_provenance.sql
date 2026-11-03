-- VSS schema v2. Additive only; v1 semantics unchanged.
-- 1. Provenance: which request created a person / unit, so "undo import" can remove exactly what an import created
--    (never a person or unit that existed before, even when it is now only referenced by that request).
-- 2. Lossless round-trip of domain fields that v1 has no column for: RequestItem.nameKey, and ResponseRow's
--    name.script, nameKey and full RawDate values (v1 keeps only the parsed projections dob/cert_date/expires).
ALTER TABLE person ADD COLUMN created_by_request_id TEXT;
ALTER TABLE unit ADD COLUMN created_by_request_id TEXT;
CREATE INDEX person_created_by ON person(created_by_request_id);
CREATE INDEX unit_created_by ON unit(created_by_request_id);
ALTER TABLE request_item ADD COLUMN name_key_json TEXT;
ALTER TABLE response_row ADD COLUMN detail_json TEXT;
CREATE INDEX response_row_resp ON response_row(response_id);
CREATE INDEX response_row_item ON response_row(request_item_id);
CREATE INDEX vetting_request ON vetting_record(request_id);
CREATE INDEX person_alias_person ON person_alias(person_id);
CREATE INDEX person_alias_core ON person_alias(core_key);
CREATE INDEX identifier_person ON identifier(person_id);
CREATE INDEX request_status ON request(status, received_at);
