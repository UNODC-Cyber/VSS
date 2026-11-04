-- VSS schema 006 (lane D, docs/PLAN-ALPHA.md section 6): request lifecycle Finished / Closed.
-- finished_at / closed_at: when the request became Finished / was Closed. close_notes_json: history of the manager's
-- close notes and reopen reasons (JSON array of {at, kind, text}); never copied to the audit log. reopen_count: how
-- often a Closed request was reopened.
ALTER TABLE request ADD COLUMN finished_at TEXT;
ALTER TABLE request ADD COLUMN closed_at TEXT;
ALTER TABLE request ADD COLUMN close_notes_json TEXT;
ALTER TABLE request ADD COLUMN reopen_count INTEGER NOT NULL DEFAULT 0;

-- Existing Closed rows stay Closed (closed_at is unknown: use the response, else the receipt, time).
UPDATE request SET closed_at = coalesce(responded_at, received_at) WHERE status = 'closed';

-- Responded requests whose items all have an outcome (excluded, or a vetting record of this request) become Finished.
UPDATE request SET status = 'finished', finished_at = coalesce(responded_at, received_at)
WHERE status = 'responded'
  AND EXISTS (SELECT 1 FROM request_item ri WHERE ri.request_id = request.id)
  AND NOT EXISTS (
    SELECT 1 FROM request_item ri
    WHERE ri.request_id = request.id
      AND coalesce(ri.export_decision, 'include') NOT IN ('exclude', 'manual-exclude')
      AND NOT (
        ri.person_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM vetting_record v WHERE v.request_id = request.id AND v.person_id = ri.person_id)
      )
  );
