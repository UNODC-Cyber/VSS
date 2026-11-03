# VSS file-format rules (machine-checkable; ids are used in tests)

## Request workbook (INVESTc "Version 2.6.0" / "INVESTc Template Version 1.11.0")
Sheets: `Template Instructions`, `Data`, `Reference Data` (hidden). Reference Data: A Unit Type {Military, Other, Police, Prison}; B Gender {M,F}; C True/False; D ID Type; E Country (POB/nationality list, ~203); G UnitCountry (~200). Limits: Unit Name 512, Unit ID 32, Surname 128, Name1-4 64 each, Passport/National ID 32, Title/Rank 256, parents 128, POB city 128, state 256.
Data layout (locate by markers): `A1=UNITS`; row 3 = 13 unit headers (`* Unit Name, Unit ID #, * Unit Type, Unit Alias, Unit Location, Unit Description, Unit English Description, Branch Name, Branch Description, Parent Organization, Subordinate Organization, Organization/Federal Level, * Unit Country`); unit rows from row 4; separator row with `LEAVE A ROW BLANK`; `INDIVIDUALS`; sub-header row; 19 individual headers (`* Unit Name, * IsHeadOfUnit, * Surname, Name 1..4, Passport, National ID Card, Title/Rank, Father's Name, Mother's Name, * DOB (MM/DD/YYYY), City/Village, State/Province, * Country, Nationality, * Country, * Sex (M/F)`); individual rows. IsHeadOfUnit is a boolean cell; DOB an Excel serial with date style (numFmt `mm/dd/yyyy`) but text may occur. Merges: `A1:M1, A2:M2, B{sep}:C{sep}, A{ind}:S{ind}, A{sub}:B{sub}, C{sub}:G{sub}, H{sub}:I{sub}, J{sub}:L{sub}, M{sub}:Q{sub}`.

Parse/validate rules
- R-01 zip with `[Content_Types].xml` + `xl/workbook.xml`; sheet names/order exact; third hidden (warn if not).
- R-02 `Template Instructions!A2` ~ `^Version (\d+\.\d+\.\d+)$`, `C2` ~ `^INVESTc Template Version (\d+\.\d+\.\d+)$`; unknown => TEMPLATE_VERSION_UNKNOWN warning, continue.
- R-03 `Data!A1=='UNITS'` and unit header row exact (trim, case-sensitive) else HEADER_MISMATCH error.
- R-04 unit rows = from row 4 to the first row containing `LEAVE A ROW BLANK`; rows with empty unit name ignored; MARKER_MISSING if no separator/`INDIVIDUALS`.
- R-05 individuals header = first row after `INDIVIDUALS` whose A is `* Unit Name` with the 19 headers; rows until two consecutive empty rows.
- R-06 required: unit name/type/country; individual unitName, isHeadOfUnit, surname, dob, pobCountry, searchCountry, sex.
- R-07 type in list; sex M/F (case-insensitive accepted with warning); countries in list E (POB, nationality) / G (search, unit country), case-insensitive with warning; else COUNTRY_NOT_IN_LIST error.
- R-08 DOB: numeric => serial (1900 system); text => try MM/DD/YYYY then DD/MM/YYYY; both valid and different => DOB_AMBIGUOUS_DM warning; age < 18 at import => DOB_UNDER_18 error; future => DOB_FUTURE error.
- R-09 individual unit must equal a declared unit (trim + collapse whitespace) else UNIT_NOT_DECLARED error; declared but unused => UNIT_UNUSED warning; duplicate unit names => UNIT_DUPLICATE error.
- R-10 heads of unit per unit: 0 => HEAD_OF_UNIT_NONE warning; >1 => HEAD_OF_UNIT_MULTIPLE error.
- R-11 passport/national ID present and nationality empty => ID_WITHOUT_NATIONALITY error.
- R-12 character limits => CHAR_LIMIT error.
- R-13 equal core name key + DOB in two rows => DUPLICATE_ROW error on the later row.
- R-14 name field starting with honorific/rank => NAME_HAS_HONORIFIC warning.
- R-15 DB expectation checks: unseen unit => UNEXPECTED_UNIT info; known person name/DOB/ID differs => PERSON_KNOWN_*_MISMATCH warning; person non-approved => PERSON_NON_APPROVED warning (excluded by default policy).

Export rules
- X-01 output re-parses with zero errors (round-trip).
- X-02 Regenerate mode: the base is the blank template kept IN THE VAULT (VSS ships none: it is captured, sanitised and without rows, from the first valid request import, or imported in Settings > Templates). No template => `TEMPLATE_MISSING` with an actionable message, never a fallback. Every part except `xl/worksheets/sheet2.xml`, `xl/sharedStrings.xml`, `docProps/core.xml`, `docProps/app.xml` byte-identical to that template; creator/lastModifiedBy = `VSS`.
- X-03 Filter-original mode: the source first passes the package whitelist (X-09); then every part except sheet2/sharedStrings/core byte-identical to the whitelisted source.
- X-09 (F-05) Package whitelist, applied to every export base and every template: KEEP `[Content_Types].xml`, `_rels/.rels`, `xl/workbook.xml` (minus `x15ac:absPath`, `xr:revisionPtr`, `fileSharing`, and every defined name that is not a plain `'Reference Data'!` range), its rels, styles, theme, shared strings (strings only used by removed rows blanked), the three known sheets, `docProps/core.xml` (rewritten: creator/lastModifiedBy `VSS`, created/modified only) and `docProps/app.xml` (rewritten: application and sheet titles only). DROP with every reference: custom XML, label metadata (`docMetadata/`), custom properties, thumbnails, calc chain, comment persons, printer settings, drawings and pictures, comments and their VML, hyperlinks. Anything else (pivot caches/tables, embeddings, external links, extra or hidden sheets other than Reference Data, tables, VBA, orphan parts) is UNKNOWN: filter-original then regenerates from the vault template with an info notice (or fails with `TEMPLATE_MISSING`), and template capture refuses the file.
- X-10 Template capture: whitelist (X-09), all unit and individual rows removed (one blank row each kept), shared strings rebuilt from the cells still present, document properties reset; only known template versions.
- X-04 Row map: units `4..4+nU-1`, `sep=4+nU`, `ind=sep+1`, `sub=ind+1`, `hdr=sub+1`, individuals `hdr+1..hdr+nI`; `dimension ref="A1:S{hdr+nI}"`; merges re-anchored; row attributes and header styles copied from template rows.
- X-05 Data validations rewritten for the new row ranges (standard DOB 18+ and unit-name OFFSET list; x14 lists for IsHeadOfUnit, Unit Type, Sex, POB country+Nationality, Search country+Unit country) with counts correct and uids preserved.
- X-06 Strings as shared strings (XML-escaped, NFC, control chars stripped); IsHeadOfUnit `t="b"` 1/0; DOB as serial using the template's DOB style; empty optional cells omitted; countries uppercase from lists; sex M/F.
- X-07 Only items with exportDecision include/manual-include are written; units referenced by included individuals are written, others dropped; order preserved.
- X-08 (CI) OpenXML SDK validator 0 errors; LibreOffice headless convert exits 0.

## DC response workbook (`XXXX-000000NNNN.xlsx`)
Single sheet `Final_Results`. B1 `Final Results as of M/D/YYYY`, B2 `Post: <city>`, B3 `Batch ID: XXXX-0000000000`, B4 `Assistance: <event> - <place> - M/D/YYYY`. Four sections in order, each = label row (`Approved Unit/Commander:`, `Approved Individuals:`, `Non Approved Unit/Commander:`, `Non Approved Individuals:`), header row (`DISP, NAME, DOB, POB, UNIT TYPE, UNIT NAME, CERT DATE, EXPIRES`), data rows, blank row. All values are text strings, dates `M/D/YYYY`. NAME `SURNAME, Given names` (trailing spaces, particles may move, DC may add/drop a particle, commander may be `UNKNOWN,`); POB `City - State - COUNTRY` (parts often blank); individual EXPIRES = cert + 365 days; unit EXPIRES blank or short.
- S-01 sheet `Final_Results`; B1/B2/B3/B4 regexes `^Final Results as of (\d{1,2}/\d{1,2}/\d{4})\s*$`, `^Post:\s*(.*)$`, `^Batch ID:\s*([A-Z]{2,6}-\d{6,12})\s*$`, `^Assistance:\s*(.*)$`.
- S-02 sections by exact label (trim, case-insensitive, colon), then 8-header row; data until a row with empty NAME and DISP.
- S-03 dates text M/D/YYYY or MM/DD/YYYY, serial accepted; else parsed=null + warning.
- S-04 NAME split at first comma; trim; collapse spaces; `UNKNOWN` surname => unknown commander.
- S-05 POB split on ` - ` into [city,state,country] (1-3 parts tolerated, last = country; blanks null).
- S-06 disposition from section; DISP stored raw; an unknown section label blocks the import and shows the raw label (fail loudly).
- S-07 hidden/extra columns ignored; extra sheets warn.
