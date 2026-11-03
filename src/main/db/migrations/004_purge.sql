-- VSS schema v4 (security review F-01): purge must physically erase.
-- 1. stored_file.purged_at: a stored workbook that held a purged person's data is scrubbed (content emptied, name
--    replaced) but its row and sha256 stay, so a re-import of the same file is still recognised.
-- 2. FTS5 secure-delete on all four search tables: a DELETE removes the entry from the index segments instead of
--    appending a tombstone, so deleted trigrams do not survive in the *_data shadow tables. 'optimize' merges the
--    existing segments once so tombstones written by v1/v2 are dropped too.
ALTER TABLE stored_file ADD COLUMN purged_at TEXT;
INSERT INTO person_search(person_search, rank) VALUES('secure-delete', 1);
INSERT INTO unit_search(unit_search, rank) VALUES('secure-delete', 1);
INSERT INTO request_search(request_search, rank) VALUES('secure-delete', 1);
INSERT INTO response_search(response_search, rank) VALUES('secure-delete', 1);
INSERT INTO person_search(person_search) VALUES('optimize');
INSERT INTO unit_search(unit_search) VALUES('optimize');
INSERT INTO request_search(request_search) VALUES('optimize');
INSERT INTO response_search(response_search) VALUES('optimize');
