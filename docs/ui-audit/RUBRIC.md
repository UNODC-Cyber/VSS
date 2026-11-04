# UI audit rubric

Used by the reviewer agents (Sonnet first, then Opus independently) and by the owner when reading the output of the
screenshot harness (`npm run ui-audit`, see `tests/ui-audit/audit.test.ts`). Everything the harness shows is synthetic.

## Inputs

- `%TEMP%\vss-ui-audit\<timestamp>\<viewport>\<theme>__<screen>.png` (plus `--scrolled.png` when the screen scrolls),
  `<theme>__<screen>.axe.json` and `index.json` (per screen: status, axe violation ids, page-level horizontal scroll,
  table cells whose text spills out of the cell, error text for screens the harness could not reach).
- Profiles: 1024x720, 1280x720, 1366x768, 1920x1080 and 1280x720 at device scale factor 1.5; light and dark.
- Screens: lock / unlock, every navigation entry, request / person / unit / review detail, both import wizards at each
  step, every dialog, empty states (empty vault), error states (wrong file, wrong password), lock warning.
- No screenshot is committed. Findings are.

## Criteria

1. **Readability.** Body text >= 13 px at the profile's scale; line length of running text <= about 90 characters;
   headings clearly ranked; nothing set in grey on grey.
2. **Overlap and clipping.** No text over text, no control cut by the window or a card, no horizontal page scroll
   (`pageScroll` > 0 in `index.json` is a finding), no table cell spilling (`spill` non-empty is a finding).
3. **Truncation.** Truncated text ends in an ellipsis and carries the full value in a tooltip / `title`; dates,
   statuses and identifiers never wrap or truncate.
4. **Contrast.** axe `color-contrast` violations and anything visibly weak (disabled-looking enabled buttons, pale
   badges, placeholder-only labels) in both themes. Colour is never the only signal (badges keep their text).
5. **Keyboard access.** Visible focus ring on every control, logical tab order, dialogs focus their first control and
   return focus, icon buttons have an accessible name (axe `button-name`, `aria-*` rules are findings).
6. **Empty and error states.** Every empty list says what is missing and offers the next action; every error says what
   happened in plain words and what to do; no raw codes.
7. **Consistency.** Spacing scale, one primary button per view, destructive actions styled alike, badge colours mean the
   same everywhere, the same field is labelled the same on every screen.
8. **Density at 150 %.** The 1280x720 @ 1.5 profile is effectively 853x480 logical pixels: primary actions stay
   reachable, tables scroll inside their container, dialogs fit or scroll.

## Severity

| Severity | Meaning                                                      | Example                                          |
| -------- | ------------------------------------------------------------ | ------------------------------------------------ |
| P1       | Blocks use: the user cannot read, reach or finish something. | Primary button off-screen; text over text.       |
| P2       | Confusing or error-prone, but a way through exists.          | Truncated name with no tooltip; unlabeled icon.  |
| P3       | Polish: spacing, alignment, wording, minor contrast.         | Uneven card padding; badge colour inconsistency. |

Exit rule of the fix loop: zero P1 and zero P2 on the 1280x720 and 1366x768 profiles; remaining P3 go to the README
known limitations.

## Findings file

`docs/ui-audit/<date>-round<N>-findings.md`, one table:

| id | screen | viewport | severity | evidence file | proposed fix |
| -- | ------ | -------- | -------- | ------------- | ------------ |

`id` is `R<N>-<nnn>`; `evidence file` is the PNG / axe JSON file name from the output folder (not committed);
`proposed fix` names the file or component. The second reviewer works from the screenshots, not from the first
reviewer's table; triage dedupes afterwards.
