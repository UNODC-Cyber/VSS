-- VSS schema v1. Whole-DB encrypted (SQLite3MultipleCiphers, chacha20). FTS blobs are rebuilt by the service layer, no triggers.
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE person(id TEXT PRIMARY KEY, created_at TEXT, updated_at TEXT, surname TEXT, given_json TEXT, raw_name TEXT, script TEXT,
  dob TEXT, dob_precision TEXT, sex TEXT, pob_city TEXT, pob_state TEXT, pob_country TEXT, nationality TEXT,
  state TEXT NOT NULL DEFAULT 'active', merged_into TEXT REFERENCES person(id), notes TEXT NOT NULL DEFAULT '',
  core_key TEXT, full_key TEXT);
CREATE INDEX person_dob ON person(dob);
CREATE INDEX person_core ON person(core_key);
CREATE INDEX person_full ON person(full_key);
CREATE TABLE person_alias(id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES person(id), surname TEXT, given_json TEXT, raw TEXT, script TEXT,
  core_key TEXT, source_kind TEXT, source_id TEXT, seen_at TEXT);
CREATE TABLE identifier(id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES person(id), type TEXT, value TEXT, value_folded TEXT, issuing_country TEXT,
  source_kind TEXT, source_id TEXT);
CREATE INDEX identifier_val ON identifier(type, value_folded);
CREATE TABLE unit(id TEXT PRIMARY KEY, name TEXT NOT NULL, name_folded TEXT, type TEXT, country TEXT, unit_id_no TEXT, alias TEXT, location TEXT,
  description TEXT, english_description TEXT, branch_name TEXT, branch_description TEXT, parent_org TEXT, subordinate_org TEXT, org_level TEXT);
CREATE TABLE unit_alias(unit_id TEXT REFERENCES unit(id), name_folded TEXT, PRIMARY KEY(unit_id, name_folded));
CREATE TABLE stored_file(id TEXT PRIMARY KEY, original_name TEXT, sha256 TEXT, bytes INTEGER, stored_at TEXT, content BLOB NOT NULL);
CREATE TABLE request(id TEXT PRIMARY KEY, kind TEXT, received_at TEXT, requestor_name TEXT, requestor_email TEXT, requestor_org TEXT,
  event_name TEXT, event_start TEXT, event_end TEXT, event_location TEXT, source_file_id TEXT REFERENCES stored_file(id), template_version TEXT,
  units_json TEXT, status TEXT, sent_to_dc_at TEXT, responded_at TEXT, response_kind TEXT, batch_id TEXT, notes TEXT DEFAULT '');
CREATE TABLE request_item(id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES request(id), row_ref TEXT, observed_json TEXT NOT NULL,
  core_key TEXT, person_id TEXT REFERENCES person(id), link_state TEXT, unit_id TEXT REFERENCES unit(id),
  issues_json TEXT, prior_json TEXT, export_decision TEXT, export_reason TEXT);
CREATE INDEX request_item_req ON request_item(request_id);
CREATE INDEX request_item_person ON request_item(person_id);
CREATE TABLE export(id TEXT PRIMARY KEY, request_id TEXT REFERENCES request(id), created_at TEXT, mode TEXT, file_id TEXT REFERENCES stored_file(id),
  policy_json TEXT, included_item_ids_json TEXT, sha256 TEXT);
CREATE TABLE response(id TEXT PRIMARY KEY, batch_id TEXT, post TEXT, results_as_of TEXT, assistance_line TEXT, source_file_id TEXT, imported_at TEXT,
  request_id TEXT REFERENCES request(id));
CREATE TABLE response_row(id TEXT PRIMARY KEY, response_id TEXT NOT NULL REFERENCES response(id), row_ref TEXT, section TEXT, disp TEXT, name_raw TEXT,
  surname TEXT, given_json TEXT, core_key TEXT, dob TEXT, dob_raw TEXT, pob_city TEXT, pob_state TEXT, pob_country TEXT, unit_type TEXT, unit_name TEXT,
  cert_date TEXT, expires TEXT, match_json TEXT, request_item_id TEXT REFERENCES request_item(id), person_id TEXT REFERENCES person(id));
CREATE TABLE vetting_record(id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES person(id), unit_id TEXT, request_id TEXT, response_row_id TEXT,
  disposition TEXT, cert_date TEXT, expires_at TEXT, expiry_assumed INTEGER NOT NULL DEFAULT 0, source TEXT, recorded_at TEXT, recorded_by TEXT, note TEXT DEFAULT '');
CREATE INDEX vetting_person ON vetting_record(person_id, recorded_at);
CREATE INDEX vetting_expiry ON vetting_record(expires_at);
CREATE TABLE unit_vetting_record(id TEXT PRIMARY KEY, unit_id TEXT, request_id TEXT, response_row_id TEXT, commander_person_id TEXT,
  disposition TEXT, cert_date TEXT, expires_at TEXT, recorded_at TEXT);
CREATE TABLE review_item(id TEXT PRIMARY KEY, kind TEXT, created_at TEXT, subject_ids_json TEXT, candidates_json TEXT, state TEXT, resolution TEXT, resolved_at TEXT);
CREATE TABLE negative_pair(a TEXT NOT NULL, b TEXT NOT NULL, at TEXT, PRIMARY KEY(a, b));
CREATE TABLE merge_log(id TEXT PRIMARY KEY, at TEXT, actor TEXT, survivor_id TEXT, merged_id TEXT, reason TEXT, snapshot_json TEXT);
CREATE TABLE setting(key TEXT PRIMARY KEY, value_json TEXT, updated_at TEXT);
CREATE TABLE audit(seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, actor TEXT, type TEXT, subject_type TEXT, subject_id TEXT, details_json TEXT, prev_hash TEXT, hash TEXT);
CREATE TRIGGER audit_append_only BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;
CREATE VIRTUAL TABLE person_search USING fts5(person_id UNINDEXED, blob, tokenize='trigram');
CREATE VIRTUAL TABLE unit_search USING fts5(unit_id UNINDEXED, blob, tokenize='trigram');
CREATE VIRTUAL TABLE request_search USING fts5(request_id UNINDEXED, blob, tokenize='trigram');
CREATE VIRTUAL TABLE response_search USING fts5(response_id UNINDEXED, blob, tokenize='trigram');
