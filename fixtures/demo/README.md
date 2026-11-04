# Demo dataset

**Everything in this folder is synthetic.** Names are random syllable strings from the seeded grammars in
`tools/fixtures/grammar.ts` (Malay, Tamil-Malaysian, Thai in Latin and Thai script, Western), units, events, venues and
posts are `Example ...` strings, dates of birth are drawn at random, and the batch ids are `DEMO-0000000001` and
`DEMO-0000000002`. No real person, unit, place, event or document number is used, and no mapping from real data exists
anywhere. Any resemblance to a real person is coincidence.

The dataset reproduces the _shape_ of a real exchange of two requests and two DC responses: rows, sections, counts, who
is answered and who is not, and the kinds of change a DC makes to a name, date or place. It is meant for demos, the UI
harness and end-to-end tests.

## Files

| File                                            | What it is                                                                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `demo-request-1_example-regional-workshop.xlsx` | Request 1: one unit (type `Other`, with an alias) plus three blank unit rows, five people, nobody marked head of unit, DOBs in two date styles, stray spaces. |
| `DEMO-0000000001.xlsx`                          | Response 1: all approved; the unit row has an `UNKNOWN,` commander and a blank expiry; all five people answered, individual expiry = cert + 365 days.         |
| `demo-request-2_example-river-city-course.xlsx` | Request 2: two units, four Thai people in Latin script.                                                                                                       |
| `DEMO-0000000002.xlsx`                          | Response 2: answers a _different_ request: a named commander (expiry = cert + 31 days) and one individual of a third unit, names in Latin plus Thai script.   |
| `manifest.json`                                 | Expected outcomes per pair and the invented person behind every row (ids `demo-1-p1` ..., `demo-2-x1` ...), with the kinds of difference per person.          |

Both responses carry the four sections in the usual order (non-approved sections empty), `Approve` in `DISP`, two
hidden empty columns `I:J`, and text cells only.

## Expected outcomes (also in `manifest.json`)

| Pair | Request people | Matched | Auto-linked | Pending review | Unanswered | Unidentified rows | Review items |
| ---- | -------------- | ------- | ----------- | -------------- | ---------- | ----------------- | ------------ |
| 1    | 5              | 5       | 2           | 3              | 0          | 0                 | 3            |
| 2    | 4              | 0       | 0           | 0              | 4          | 2 (1 commander)   | 6            |

Pair 1, per person: `p1` day and month of birth swapped and city/state dropped (pending); `p2` a different month of
birth (pending); `p3` `Bin` moved from the surname to the given names and the surname upper-cased (auto); `p4` the DC
uses the first given name as surname, adds `A/P` and returns another place of birth (pending); `p5` only city/state
dropped (auto). Every row also comes back with unit type `Police` where the request said `Other`.

## Regenerate

```
npm run fixtures:demo          # rewrite this folder (node tools/fixtures/demo-dataset.ts)
npm run fixtures:demo:check    # fail if the committed files differ from the generator output
```

The generator is deterministic (fixed seed `vss-demo/2026-11-04`); the workbooks are written by the repository's own
writers (`tools/fixtures/investc-workbook.ts`, `tools/fixtures/response-builder.ts`). `tests/security/demo-dataset.test.ts`
checks determinism, re-parsing, the manifest counts through the real import services and, when
`VSS_DEMO_PRIVATE_DIR` points at a local folder of private example workbooks (never in CI), that no name token, date of
birth, ID, unit, event or place string of those files appears here (hash comparison only, nothing stored).

## Demo walk-through

1. Import `demo-request-1_example-regional-workshop.xlsx` (Requests > Import). Enter the event and requestor from
   `manifest.json` > `requests[0]` and `requestor`. Five people, one unit, one "no head of unit" warning.
2. Export the request for the DC and mark it sent.
3. Import `DEMO-0000000001.xlsx` against request 1: 2 rows link automatically, 3 wait for review, nobody is unanswered.
   Resolve the three reviews (each is the right person: the differences are the DC's rendering).
4. Import `demo-request-2_example-river-city-course.xlsx`, export, mark sent.
5. Import `DEMO-0000000002.xlsx` against request 2: nothing matches, the four request people stay unanswered and the two
   response rows are unidentified (6 review items).
6. Open the dashboard and the review queue: the counts match the table above (9 open review items in total).

## Known differences from the modelled files

These do not change what the parsers read; the current parsers read the modelled layouts without any issue, so there are
no parser gaps to report for this dataset.

- The request instruction sheet carries our own short text, not the original form's text (deliberately, see
  `tests/security/no-third-party-template.test.ts`); the reference lists are our own.
- The responses carry no logo images and no theme part (the purity gate forbids drawings and media), and the label cells
  use our own styles.
- Request 1 omits a stray styled empty cell below the last individual row.
