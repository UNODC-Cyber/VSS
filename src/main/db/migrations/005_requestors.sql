-- 005_requestors (lane B): persistent, de-duplicated requestors (staff who send requests; not vetted persons).
-- Dedupe key: folded e-mail when present, else folded name + organisation. The folded columns are rewritten by the
-- app (same folding as search) the first time the requestor service runs, so SQL lower() here only has to be stable.
CREATE TABLE requestor(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_folded TEXT NOT NULL,
  email TEXT,
  email_folded TEXT UNIQUE,
  organisation TEXT,
  phone TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX requestor_name ON requestor(name_folded);
ALTER TABLE request ADD COLUMN requestor_id TEXT REFERENCES requestor(id);
CREATE INDEX request_requestor ON request(requestor_id);

-- Backfill: one requestor per distinct e-mail, else per distinct name + organisation, from existing requests.
-- The record id is the id of the group's latest request (already a ULID, unique); its fields are that request's.
CREATE TEMP TABLE rq_map AS
WITH r AS (
  SELECT id, received_at,
         trim(coalesce(requestor_name, '')) AS n,
         nullif(trim(coalesce(requestor_email, '')), '') AS e,
         nullif(trim(coalesce(requestor_org, '')), '') AS o
  FROM request
),
k AS (
  SELECT *,
         CASE WHEN e IS NOT NULL THEN 'e:' || lower(e) ELSE 'n:' || lower(n) || '|' || lower(coalesce(o, '')) END AS gk
  FROM r
  WHERE n <> '' OR e IS NOT NULL
)
SELECT id AS request_id, gk, received_at, n, e, o,
       row_number() OVER (PARTITION BY gk ORDER BY id DESC) AS rn,
       min(received_at) OVER (PARTITION BY gk) AS first_at,
       max(received_at) OVER (PARTITION BY gk) AS last_at
FROM k;

INSERT INTO requestor(id, name, name_folded, email, email_folded, organisation, phone, notes, created_at, updated_at, last_used_at)
SELECT request_id, n, lower(n), e, lower(e), o, NULL, '',
       coalesce(first_at, '1970-01-01T00:00:00Z'), coalesce(last_at, '1970-01-01T00:00:00Z'), last_at
FROM rq_map WHERE rn = 1;

UPDATE request SET requestor_id = (
  SELECT w.request_id FROM rq_map w
  WHERE w.rn = 1 AND w.gk = (SELECT m.gk FROM rq_map m WHERE m.request_id = request.id)
)
WHERE id IN (SELECT request_id FROM rq_map);

DROP TABLE rq_map;
