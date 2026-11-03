-- VSS schema v3. Additive only.
-- Export templates kept inside the encrypted vault (VSS ships none). A row is a SANITISED blank INVESTc workbook:
-- captured automatically from the first valid request import, or imported by the user in Settings > Templates.
-- At most one row per kind is active; replaced rows stay as history (active = 0, replaced_at set).
CREATE TABLE template(id TEXT PRIMARY KEY, kind TEXT NOT NULL, source TEXT NOT NULL, original_name TEXT NOT NULL DEFAULT '',
  template_version TEXT, instructions_version TEXT, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, content BLOB NOT NULL,
  created_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0, replaced_at TEXT);
CREATE UNIQUE INDEX template_one_active ON template(kind) WHERE active = 1;
CREATE INDEX template_kind_created ON template(kind, created_at);
