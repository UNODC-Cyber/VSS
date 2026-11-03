# Fixtures

**All data in this directory is synthetic.** No real person, unit, place of birth, document number or workbook content is
used anywhere in this repository. This is a public repository: keep it that way.

## What is here

| Path                        | What it is                                                                                                                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requests/req-00N-*.xlsx`   | Synthetic request workbooks written from scratch by `tools/fixtures/investc-workbook.ts` (our own styles, short instruction text, validation ids and reference lists; only the format identifiers the parser matches are fixed). |
| `responses/resp-00N-*.xlsx` | Synthetic DC "Final Results" workbooks (single `Final_Results` sheet, text cells, four sections).                                                                                                                                |
| `*.expected.json`           | Golden results derived from the fixture specs (not from the parsers).                                                                                                                                                            |
| `purity-allowlist.json`     | The structural strings of the generated blank workbook (the only text allowed in a fixture besides generated values).                                                                                                            |

## How the data is made

`tools/fixtures/generate.ts` creates every fixture from seeded pseudo-random grammars (`tools/fixtures/grammar.ts`):
names are random syllable strings per culture (Malay with `bin`/`binti`, Tamil-Malaysian `a/l` `a/p`, Thai in Latin and
Thai script, Lao, Khmer, Vietnamese, Western), dates of birth make every person an adult aged 21 to 59 on 2026-11-03,
units are called like `Example Provincial Police Division 7`, passports run `ZZ000001`, `ZZ000002`, ... and national IDs
`ZN000001`, ... Any resemblance to a real person is coincidence. The generator is deterministic: the same seed labels
give byte-identical files.

```
node tools/fixtures/generate.ts            # (re)write fixtures/requests and fixtures/responses
node tools/fixtures/generate.ts --check    # fail if committed files differ from the generator output
node tools/fixtures/purity-check.ts        # fail if a workbook holds a string that is not allowlisted or generated
```

The purity gate also runs as a Vitest test (`tests/unit/formats/fixtures-purity.test.ts`), so `npm test` and CI enforce it.
No counterpart or agency workbook, and nothing derived from one, is kept in this repository: there is no template
folder, and `tests/security/no-third-party-template.test.ts` fails if one comes back (unknown parts in any committed
workbook, a file named like the removed template, or a distinctive phrase of its instruction sheet, checked by hash).
The app itself ships no template either: users keep one in their vault (Settings > Templates).

## Fixture catalogue

Requests: `req-001-basic` (2 units, 6 people) · `req-002-malay-particles` · `req-003-thai-script` · `req-004-errors` (one
violation per rule R-06..R-14, with the rule-to-row map in its expected file) · `req-005-shifted-layout` (4 unit rows
including blanks) · `req-006-large` (50 units, 1200 people) · `req-007-text-dates` (text DOBs) · `req-008-unknown-version`.

Responses: `resp-001-all-approved` · `resp-002-reformatted` (surname moved, particle added, day/month swapped, blank POB
parts, trailing spaces, `UNKNOWN,` commander, short unit expiry) · `resp-003-nonapproved` · `resp-004-thai` ·
`resp-005-unknown-section` (must fail loudly).

## VERIFY

- `resp-003-nonapproved` uses the literal `NotApproved` in the `DISP` column of non-approved rows. That literal is a
  **placeholder**: the real non-approved value has not been seen. Approved rows use `Approve`, which is the verbatim
  value in real DC files. Replace the placeholder once a real non-approved response confirms the text.
- Certificate and expiry cells of non-approved rows (blank expiry here) are an assumption.
