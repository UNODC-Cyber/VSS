-- VSS schema 007 (lane C, docs/PLAN-ALPHA.md section 5): DC response rows keep how their DISP was classified and
-- whether their section came from a label or was implicit (the first section label absent).
--   disp_class      'approved' | 'non-approved' | 'unknown' (unknown = unrecognised DISP or DISP contradicting its
--                   section; such a row becomes a disposition-unclear review item and has no vetting record until a
--                   person sets the disposition)
--   section_source  'label' | 'implicit'
-- Backfill: rows imported before 007 took their disposition from the section label (0.1 rule S-06).
ALTER TABLE response_row ADD COLUMN disp_class TEXT NOT NULL DEFAULT 'unknown'
  CHECK (disp_class IN ('approved', 'non-approved', 'unknown'));
ALTER TABLE response_row ADD COLUMN section_source TEXT NOT NULL DEFAULT 'label'
  CHECK (section_source IN ('label', 'implicit'));
UPDATE response_row SET disp_class = CASE
  WHEN section IN ('approved-unit', 'approved-individual') THEN 'approved'
  WHEN section IN ('nonapproved-unit', 'nonapproved-individual') THEN 'non-approved'
  ELSE 'unknown' END;
