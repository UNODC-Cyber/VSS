# VSS Alpha 1 plan (0.2.0-alpha.1)

Work after the 0.1 security hardening, planned 2026-11-04 as parallel lanes in separate git worktrees. Public repo:
every example, fixture and test string in this plan and in the work it describes is synthetic. The owner's real DC
response file stays in the owner's private store and is never copied, quoted or paraphrased row-by-row into the repo.

Conventions used below: `A0` is the contract-first lane that merges before all others; migration numbers are fixed
per lane so lanes never clash (`005` B, `006` D, `007` C; `008`+ free); "lane end" means `npm run typecheck`,
`npm run lint`, `npm run format:check`, `npm test` and, for any lane that touches UI or IPC,
`npx vitest run --config vitest.e2e.config.ts` all green on the lane branch rebased onto `main`.

## 1. Lanes at a glance

| Lane | WP | Requirement | Model tier | Depends on | Worktree branch |
|---|---|---|---|---|---|
| A | A0 Contract-first + file splits | all | Opus (small, high leverage) | - | `alpha/a-contract` |
| B | Requestor entity + type-ahead | R1, R2 (forms) | Sonnet | A | `alpha/b-requestors` |
| C | Structure-based response parser + mixed-script names | R6 | Opus | A | `alpha/c-response-parser` |
| D | Request lifecycle (Finished / Closed) + dashboard screen links | R7, R14 | Sonnet (Opus review at merge) | A | `alpha/d-lifecycle` |
| E | Email templates + vetting-authority contacts | R3, R4, R2 (compose) | Sonnet | A | `alpha/e-email-settings` |
| F | Wizard navigation (Back / Cancel) + friendly wrong-file state | R5, R6 (UI part) | Haiku | A | `alpha/f-wizard-nav` |
| G1 | UI infrastructure: table engine, copy icon, local fonts/icons, density | R8 | Sonnet | A | `alpha/g1-ui-infra` |
| G2 | Screen-by-screen UI pass | R8 | Sonnet | G1, B, D, E, F, K | `alpha/g2-ui-pass` |
| H | Screenshot harness, demo seeder, reviewer rubric, fix loop | R8 | Sonnet (reviewers Sonnet + Opus; fixes Haiku/Sonnet) | G2, C | `alpha/h-ui-audit` |
| I | Alpha release prep (unsigned pre-release, banner, feedback, docs) | R9 | Sonnet (Opus review of release.yml + updater gating) | everything | `alpha/i-release` |
| J | Native crash / dialog investigation + crash guard | R10 | Opus | A (no contract need; may start at once) | `alpha/j-crash` |
| K | Review queue: person picker, list context, manual validate, edit in place | R11, R12 | Opus (service: validate/edit/provenance), Sonnet (UI) | A | `alpha/k-review` |
| L | Settings danger zone: Delete database (wipe UI) | R15 | Sonnet (Opus review) | A | `alpha/l-wipe-ui` |
| M | Demo dataset (already running, separate lane): synthetic twins of the owner's 4 example workbooks (2 requests, 2 DC responses, deliberately not 1:1) | R8 input | - | - | owns `fixtures/demo/**`, `tools/fixtures/demo-*` |

R13 (People table columns) is the first concrete case of the R8 table system and lands inside G1. Lane M is planned
around, not planned here: C never touches `fixtures/demo/**`, and H's seeder consumes it instead of inventing data.

Merge order: **A0** -> (J, F, B, C, D, E, K, L, G1 in any order; rebase before each merge) -> **G2** -> **H** (up to three
fix rounds) -> **I**. Nothing is published in this plan; I ends with a tagged draft that the owner inspects.

Worktrees: `git worktree add ..\vss-wt-<lane> -b alpha/<lane> main` after A0 is merged. One lane per worktree; a
lane never edits a file owned by another lane (ownership map in section 3). If a lane needs a change in a shared file
it opens a one-line PR against `main` labelled `contract` and rebases.

## 2. Lane A0: contract-first and file splits (Opus)

Goal: every schema, channel, type, error code, i18n namespace, migration slot and mock hook the other lanes need
exists on `main` before they branch, so no two lanes edit `contract.ts`, `schemas.ts`, `channels.ts`, `compose.ts`,
`domain-wiring.ts`, `mockApi.ts`, `en.ts`, `SettingsScreen.tsx` or `RequestDialogs.tsx` at the same time.

Owns: `src/shared/ipc/contract.ts`, `schemas.ts`, `channels.ts`, `src/shared/domain/types.ts`,
`src/main/db/migrations/index.ts` (slots only), `src/main/app/compose.ts`, `src/main/app/domain-wiring.ts` (table
rows only), `src/main/ipc/registry.ts`, `src/preload/index.ts`, `src/renderer/src/mock/mockApi.ts` (hook only),
`src/renderer/src/locales/en.ts` (spread of per-lane files), and the pure file moves listed below.

Contract additions (all additive; existing payloads unchanged):

- Domain (`types.ts`): `Requestor` gains optional `id?: Ulid`, `phone?: string | null`, `notes?: string`;
  new `RequestorRecord { id, name, email, organisation, phone, notes, createdAt, updatedAt, requestCount, lastUsedAt }`.
  `RequestStatus` gains `'finished'`; `VettingRequest`/`RequestSummary` gain `finishedAt`, `closedAt`, `closeNote`
  (string, kept on the row, never in audit text), `reopenCount`. `ResponseRow` gains
  `dispClass: 'approved' | 'non-approved' | 'unknown'` and `sectionSource: 'label' | 'implicit'`.
  `ReviewKind` gains `'disposition-unclear'`; `ReviewResolution` gains `{ action: 'set-disposition'; disposition }`.
  `MatchEvidence` gains `'NAME_SCRIPT_CONFLICT'` and `'NAME_SCRIPT_IGNORED'`. `Settings` gains `emailTemplates`
  (per purpose `{ subject, body }` or null = default), `vettingAuthority { to: Contact[]; cc: Contact[] }` with
  `Contact { name: string; email: string }`, `uiDensity: 'comfortable' | 'compact'`, `tableColumns: Record<string, string[]>`
  (hidden column ids per table id). `DEFAULT_SETTINGS` extended; `tests/unit/ipc-contract.test.ts` "default settings
  satisfy the settings schema" keeps passing.
- Response issue codes (`src/main/formats/dc/types.ts`, owned by C after A0 adds the names): `LOOKS_LIKE_REQUEST`,
  `RESULTS_SHEET_NOT_FOUND`, `META_LABEL_MISSING`, `HEADER_COLUMN_MISSING`, `HEADER_COLUMN_EXTRA`,
  `SECTION_IMPLICIT`, `SECTION_EMPTY`, `DISP_UNRECOGNISED`, `DISP_SECTION_CONFLICT`, `NAME_MIXED_SCRIPT`.
  `ResponsePreview` gains `fileKindGuess: 'dc-response' | 'investc-request' | 'unknown'` and `batchId: string | null`;
  `ResponseCommitRequest` gains `batchIdOverride?: string`.
- IPC (`contract.ts` + `channels.ts` + `schemas.ts` + registry/preload are generated from METHODS):
  `requestors.{search, get, upsert, merge, list}`; `requests.{close, reopen}` (`{ id, note }` / `{ id, reason }`);
  `persons.suggest({ forSubject: { kind: 'review-item' | 'request-item' | 'response-row'; id }, text?, limit? })`
  -> `PersonSuggestion[] { person: PersonSummary; tier: MatchTier | null; evidence: MatchEvidence[]; why: 'candidate' | 'recent' | 'search' }`;
  `review.list` returns `Page<ReviewItemSummary>` (= `ReviewItem` plus `subjectName: string`, `subjectDob: IsoDate | null`,
  `unitName: string | null`, `context: { requestId, eventName } | { responseId, batchId } | null`, `bestTier`); 
  `review.manualValidate({ id, target: { kind: 'person'; personId } | { kind: 'request-item'; itemId } | { kind: 'new-person' }, reason })`
  -> `ReviewCounts`; `review.editSubject({ id, subject: { kind: 'response-row'; rowId; patch: { nameRaw?, dob?, pob?, unitName?, certDate?, expires?, dispClass? } } | { kind: 'person'; personId; patch: PersonPatch['patch'] }, reason })`
  -> `ReviewItemDetail`; `ReviewSubject` gains `edited: boolean` and `original?: Partial<ReviewSubject>`;
  `email.{renderTemplate({ template, requestId, overrides? }), previewTemplate({ template, subject, body })}`
  (preview renders against a synthetic sample, no vault data); `app.{info(), openFeedback()}` -> `AppInfo { version, channel: 'dev' | 'alpha' | 'release', platform, schemaVersion }`;
  new event `'app:crash-recovered'` (payload `{ code: string }`, no message).
- `VaultWipeRequest` gains `alsoDeleteScheduledBackups?: boolean` (default false); `compose.ts` wipe handler calls a
  `wipeExtras(req)` hook (lane L implements it in `services/wipe.ts`) and writes the PII-free log line
  `vault.wiped { kind: 'wipe', ok }` (no audit is possible after a wipe).
- Error codes: `WRONG_FILE_KIND`, `LIFECYCLE_CONFLICT`, `REASON_REQUIRED`.
- Migration slots reserved in `migrations/index.ts` as comments: `005_requestors` (B), `006_request_lifecycle` (D),
  `007_response_disposition` (C), `008_review_edits` (K). A0 verifies (not verified today) that `SettingRepo.getAll()` fills defaults for
  keys absent from the table so E and G1 need no migration; if it does not, A0 fixes `repos/setting.ts`.
- Pure moves (no behaviour change; `git mv` so blame survives): `screens/RequestsScreens.tsx` ->
  `screens/RequestsScreen.tsx`, `screens/ImportRequestScreen.tsx`, `screens/ManualRequestScreen.tsx`;
  `components/RequestDialogs.tsx` -> `components/dialogs/{ExportDialog,MarkSentDialog,EmailClearanceDialog,EmailRequestorDialog,LinkItemDialog,EditRequestDialog}.tsx`
  with `RequestDialogs.tsx` left as a barrel; `PersonPicker` out of `components/common.tsx` into
  `components/PersonPicker.tsx`; `screens/ReviewScreens.tsx` -> `screens/review/ReviewListScreen.tsx` +
  `ReviewDetailScreen.tsx` (both K); `screens/PeopleScreens.tsx` -> `screens/people/PeopleScreen.tsx` (G1 for R13) +
  `PersonDetailScreen.tsx` (G2); `SettingsScreen.tsx` keeps only layout and imports cards from
  `components/settings/*.tsx` (existing General/ExportPolicy/Peer/Save blocks become `GeneralCard.tsx` etc.);
  `locales/en.ts` becomes `{ ...en, ...requestors, ...lifecycle, ...emailTemplates, ...authority, ...wizard, ...ui, ...picker, ...alpha, ...crash }`
  with one `locales/en/<ns>.ts` per lane (empty objects created by A0); `mock/mockApi.ts` gets a single hook
  `applyMockExtensions(api, db, emit)` that merges `mock/ext/<lane>.ts` modules (A0 ships stubs returning
  `NOT_SUPPORTED` for every new method so `tests/e2e/mock-journey.test.ts` stays green).
- `compose.ts`: `app.*` handlers (info, openFeedback with a fixed allowlisted URL, see lane I) and the
  `'app:crash-recovered'` emitter; `domain-wiring.ts` table rows for `requestors`, `requests.close/reopen`,
  `persons.suggest`, `email.renderTemplate/previewTemplate` (services arrive with their lanes; until then the
  registry default answers `NOT_SUPPORTED`).

Tests: `ipc-contract.test.ts` extended (new channels have schemas, strict objects, bounded strings, `Contact.email`
validated by the same address rule as `email.ts`), `tests/unit/renderer/*.test.tsx` still pass after the moves,
`mock-journey` green, `rules.test.ts` untouched (rule text changes belong to C).
Acceptance: `main` builds, all suites green, no lane needs to touch an A0-owned file. Merge first.

## 3. Ownership map for shared files

| File / area | Owner after A0 | Others |
|---|---|---|
| `contract.ts`, `schemas.ts`, `channels.ts`, `types.ts`, `registry.ts`, `preload` | A0 | read-only; one-line `contract` PRs |
| `compose.ts`, `domain-wiring.ts` | A0 (rows), J (crash guard wiring only, separate functions) | - |
| `migrations/00N_*.sql` | the lane that owns the number | - |
| `services/requests.ts` | D (lifecycle, close/reopen) | B adds `services/requestors.ts` (new file) and one call in `importCommit`/`createManual` through an injected `requestors.touch()` hook A0 adds |
| `services/responses.ts` | C | D's auto-finish runs from a hook `onRequestAnswered(requestId)` A0 adds; D implements it in `services/lifecycle.ts` |
| `services/email.ts` | E | - |
| `services/people.ts` | K (adds `suggest`) | - |
| `services/review.ts`, `db/repos/reviewItem.ts`, `db/repos/response.ts` (row patch only), `migrations/008_review_edits.sql` | K | C's `responses.ts` reads `disp_class` only |
| `screens/people/PeopleScreen.tsx` | G1 (R13) | G2 for the detail screen |
| `formats/dc/**`, `shared/names/**`, `matching/**` | C | K reads only |
| `app/electron-ports.ts`, `main/index.ts`, `bootstrap/**`, `app/logger.ts` | J | I adds channel constant via `app/channel.ts` (new) |
| `components/DataTable.tsx`, `common.tsx`, `theme.ts`, `styles.css`, `main.tsx`, `components/ui/**` | G1 | G2 migrates screens |
| `components/PersonPicker.tsx`, `screens/review/**`, `components/review/**`, `dialogs/LinkItemDialog.tsx` | K | - |
| `screens/ImportRequestScreen.tsx`, `ManualRequestScreen.tsx`, `components/RequestorField.tsx` | B | - |
| `screens/RequestsScreen.tsx`, `RequestDetailScreen.tsx`, `DashboardScreen.tsx` | D | G2 later |
| `screens/ResponsesScreens.tsx` (+ new `components/Wizard.tsx`) | F | C only emits codes; F renders them |
| `components/settings/EmailTemplatesCard.tsx`, `VettingAuthorityCard.tsx`, `dialogs/EmailRequestorDialog.tsx` | E | - |
| `components/settings/AppearanceCard.tsx` (density, columns reset) | G1 | - |
| `components/AlphaBanner.tsx`, `components/settings/AboutCard.tsx`, `.github/**`, `README.md`, `CHANGELOG.md` | I | - |
| `locales/en/<ns>.ts` | one per lane | nobody else |
| `mock/ext/<lane>.ts` | one per lane | nobody else |
| `tools/fixtures/**` (except `demo-*`), `fixtures/requests|responses/**` | C | H adds `tools/demo/**` only |
| `fixtures/demo/**`, `tools/fixtures/demo-*` | M (separate lane) | H reads; purity gate must cover it (M) |
| `components/ScreenLink.tsx`, `lib/router.ts` (anchor support), `SettingsScreen.tsx` anchor handler | D (R14) | - |
| `components/settings/DangerZoneCard.tsx`, `dialogs/WipeDialog.tsx`, `services/wipe.ts` | L (R15) | - |
| `docs/FILE-FORMATS.md` S-rules | C | I edits README/CHANGELOG only |

## 4. Lane B: Requestor entity and type-ahead (Sonnet)

Goal (R1, R2 form side): requestors become persistent, de-duplicated records; the import and manual forms offer a
type-ahead over name and e-mail that fills name, e-mail, organisation and phone; editing the fields on a request
updates the global record (with a "update saved requestor / only this request" choice when the record is used by
other requests).

Owns: `src/main/db/migrations/005_requestors.sql`, `src/main/db/repos/requestor.ts`, `src/main/services/requestors.ts`,
`src/renderer/src/components/RequestorField.tsx`, `screens/ImportRequestScreen.tsx`, `screens/ManualRequestScreen.tsx`,
`locales/en/requestors.ts`, `mock/ext/requestors.ts`, tests `tests/unit/db/requestors.test.ts`,
`tests/unit/services/requestors.test.ts`, `tests/unit/renderer/requestor-field.test.tsx`.

Migration 005: table `requestor(id, name, name_folded, email, email_folded UNIQUE NULLS DISTINCT, organisation, phone,
notes, created_at, updated_at, last_used_at)`, column `request.requestor_id REFERENCES requestor(id)`, FTS-free
(trigram not needed: `LIKE` on folded columns is enough at this scale), backfill: one requestor per distinct
`(email_folded)` else `(name_folded, organisation)` from existing requests, `request.requestor_id` set.
Dedupe rule: same folded e-mail = same requestor; no e-mail: same folded name + organisation. `upsert` merges into
the existing record and returns it; `merge(survivorId, mergedId)` repoints requests; purge of a person never touches
requestors (they are staff, not vetted persons) but `vault.wipe` removes everything as today.

UI: `RequestorField` = Mantine `Autocomplete`/`Combobox` with 200 ms debounce over `requestors.search({ text, limit: 8 })`,
options show name, e-mail, organisation; picking fills all fields and sets `requestor.id`; typing a new name clears
the id; the e-mail field auto-fills on selection (R2). Keyboard: arrows, Enter, Escape; `aria-autocomplete="list"`.
`importCommit` / `createManual` / `requests.update` receive `Requestor` with optional `id`; the service calls
`requestors.upsert` and stores the id; when the record has other requests and the fields changed, the renderer asks
"Update the saved requestor (affects N requests) / Only this request" before saving.

Tests: repo CRUD + unique e-mail, backfill from a v4 database fixture (`tests/unit/db/migrate.test.ts` gets a case),
dedupe rules (property test: upsert is idempotent), service audit events `requestor.create|update|merge` carry only
ids and counts, renderer type-ahead (jsdom: options appear, selection fills e-mail, new name clears id), mock parity,
e2e journey step "second import proposes the first requestor".
Acceptance: two imports with the same requestor e-mail yield one `requestor` row; editing the organisation on the
second request updates the first's display after the user chooses "Update saved requestor"; no PII in audit/log.

## 5. Lane C: structure-based response parser and mixed-script names (Opus)

Goal (R6): `parseFinalResults` no longer depends on the sheet name or fixed cells; it locates the results sheet by
its header row, reads metadata by label, tolerates missing/extra/reordered columns, implicit first section, empty
sections, `Approve`/`Approved` and other DISP spellings (classified, never guessed), mixed Latin + Thai names; and
tells the user plainly when they picked a request workbook.

Owns: `src/main/formats/dc/**` (new `locate.ts`, `disposition.ts`), `src/shared/names/{normalize,personName,key}.ts`,
`src/main/formats/script.ts`, `src/main/matching/{compare,tiers}.ts` (script evidence only), `src/main/services/responses.ts`,
`src/main/db/migrations/007_response_disposition.sql`, `tools/fixtures/{response-builder,generate}.ts`,
`fixtures/responses/**`, `docs/FILE-FORMATS.md` (response section), `src/shared/formats/rules.ts` (S rules),
`tests/unit/formats/dc*.test.ts`, `tests/property/names.property.test.ts`, `tests/security/matcher-namesakes.test.ts`
(additions), `tests/golden/formats.golden.test.ts` (new goldens).

Parser design:
1. Open the package; list every sheet including hidden ones. If the sheet set is `{Template Instructions, Data,
   Reference Data}` or any sheet has `A1 == 'UNITS'`, stop with `LOOKS_LIKE_REQUEST` (error, `fileKindGuess:
   'investc-request'`, message "This looks like a vetting request workbook, not a DC response. Use Requests > Import
   request for it.").
2. For each sheet, scan rows 1..200 for a header row: >= 5 of the 8 known headers (trim, collapse spaces,
   case-insensitive; `DISP` also matches `DISPOSITION`), in any order, in any columns. The first sheet with a header
   row is the results sheet; hidden/extra sheets are reported as info. None found: `RESULTS_SHEET_NOT_FOUND` (error).
3. Metadata: in rows 1..(first header row - 1), any column, match `^Final Results as of\s*(date)`, `^Post:`,
   `^Batch ID:`, `^Assistance:` (label prefix, case-insensitive). Missing Batch ID / date = warning (`META_LABEL_MISSING`)
   and the wizard asks for the batch id (`batchIdOverride`); missing Post/Assistance = info.
4. Column map from the header row (`HEADER_COLUMN_MISSING` error only for NAME; warning for DISP/DOB/UNIT NAME;
   `HEADER_COLUMN_EXTRA` info). Every later header row re-derives the map (DC may reorder per section).
5. Sections: a row whose first non-empty cell matches a label pattern
   (`/^(non|not)?\s*-?\s*approved?\b.*(unit|commander)/`, `/^(non|not)?\s*-?\s*approved?\b.*individual/`) opens a
   section; a header row with no open section opens an implicit `approved-unit` section (`SECTION_IMPLICIT` info,
   `sectionSource: 'implicit'`, variant a); a label followed by a header and no rows is `SECTION_EMPTY` info
   (variant d); data rows run until the next label/header row or two consecutive empty rows; an unknown label is
   `UNKNOWN_SECTION` **warning** (rows keep DISP classification; a row with both unknown section and unknown DISP
   becomes a `disposition-unclear` review item). Nothing blocks unless no row at all is readable.
6. Disposition (`disposition.ts`): `classifyDisp(raw)`: `/^approv/i` -> approved; `/^(not|non)[\s-]*approv|^disapprov|^den(y|ied)|^reject/i`
   -> non-approved; blank -> inherit section; anything else -> `unknown` + `DISP_UNRECOGNISED` warning and a
   `disposition-unclear` review item (no vetting record until resolved with `set-disposition`). Section vs DISP
   disagreement -> `DISP_SECTION_CONFLICT` warning + review item. Migration 007 adds `response_row.disp_class`,
   `response_row.section_source` (backfill from section).
7. Names (variant c): `splitName` keeps the comma rule; given tokens are split by script; `PersonName.script` is
   `'Mixed'` when both Latin and non-Latin tokens exist; `NameKey` gains `scriptTokens` (non-Latin tokens, NFC,
   tone marks stripped) kept out of `coreTokens`/`fullTokens`. Comparison: Latin core must match on its own for
   any name evidence; non-Latin tokens present on both sides and different -> `NAME_SCRIPT_CONFLICT` (caps at T2);
   present on one side only -> `NAME_SCRIPT_IGNORED` (information). No path may throw on any Unicode input
   (fast-check: arbitrary strings from the Thai, Lao, Khmer, Myanmar blocks plus combining marks and ZWSP).
8. Request-file detection message and all new issue texts are PII-free (they name labels and columns, never values).

Fixtures (synthetic, generated, purity-gated): `resp-006-no-first-label` (a), `resp-007-disp-variants`
(`Approve`, `Approved`, `APPROVED `, `Not Approved`, `Disapprove`, one `Pending` -> review item) (b),
`resp-008-mixed-script-names` (Latin given names followed by Thai-script given names, surname Latin) (c),
`resp-009-empty-sections` (d), `resp-010-renamed-sheet-hidden-extra` (results on sheet `Results`, two extra sheets
one hidden, columns reordered, one extra column, metadata labels in column A), `resp-011-request-workbook` (a
request fixture passed through the response importer -> `LOOKS_LIKE_REQUEST`). Each has an `.expected.json`.
The `resp-003` placeholder note in `fixtures/README.md` is updated: `Not Approved` and `Disapprove` are now the
documented variants, still marked VERIFY until seen in a real file.

Docs: rewrite S-01..S-07 in `docs/FILE-FORMATS.md` (S-01 package + results-sheet location + request-file refusal;
S-02 header/column map; S-03 dates unchanged; S-04 names incl. mixed script; S-05 POB unchanged; S-06 section +
DISP classification + review item; S-07 hidden/extra sheets and columns tolerated) and add S-08 metadata-by-label;
update `rules.ts` to match (`rules.test.ts` enforces).

Tests: unit per rule, goldens for resp-006..011, property tests (parse never throws; classifyDisp total; a
reordered-column workbook parses to the same draft as the canonical one), matcher namesake test "Thai given names
differ, Latin equal, same DOB -> not T1", service test "disposition-unclear row creates no record until resolved",
e2e: import `resp-006` through the wizard. Lane end plus `node tools/fixtures/generate.ts --check` and purity gate.
Acceptance: all 11 response fixtures import; `resp-011` shows the friendly message; zero `auto` links where
`NAME_SCRIPT_CONFLICT` is present; `rules.test.ts` and `fixtures-purity.test.ts` green.

## 6. Lane D: request lifecycle (Sonnet; Opus review)

Goal (R7): a request becomes **Finished** automatically when every item has an outcome; a manager reviews and
marks it **Closed** (gated, audited, reversible with a reason).

State machine (`src/shared/domain/lifecycle.ts`, pure, property-tested):
`received -> validated -> exported -> sent-to-dc -> responded -> finished -> closed`, plus `withdrawn` from any open
state and `reopen: closed -> finished|responded` (recomputed). `finished` is derived, never set by hand:
`isFinished(request) = items.length > 0 && every item: (personId && a vetting record exists for this request) ||
exportDecision in {exclude, manual-exclude} || unit-commander row answered via unit_vetting_record`. Recompute
hook `lifecycle.recompute(requestId)` after response commit, email clearance, manual record, item decision,
row match, review resolve (A0 adds the `onRequestAnswered` hook; D implements it and registers in `MUTATING`).
Leaving `finished` (a new unanswered item appears, e.g. undo) falls back to `responded`.
`requests.close({ id, note })` requires status `finished` (else `LIFECYCLE_CONFLICT`), sets `closed_at`, `close_note`;
`requests.reopen({ id, reason })` requires `closed`, appends the reason to `close_note` history (JSON array on the
row), increments `reopen_count`, recomputes. `isRequestAwaitingResponse` unchanged.

Owns: migration `006_request_lifecycle.sql` (`finished_at`, `closed_at`, `close_notes_json`, `reopen_count`;
backfill: existing `closed` rows keep `closed`; `responded` rows that satisfy `isFinished` become `finished`),
`src/shared/domain/lifecycle.ts`, `src/main/services/lifecycle.ts`, `services/requests.ts`,
`screens/RequestsScreen.tsx` (status filter chips incl. "Needs closing" preset, badges), `RequestDetailScreen.tsx`
("Review and close" panel: summary table of outcomes, note field, Close button; Reopen with reason dialog),
`screens/DashboardScreen.tsx` (counts by status, "Finished, awaiting close" tile), `lib/format.ts` status colours,
`locales/en/lifecycle.ts`, `mock/ext/lifecycle.ts`, tests `tests/property/lifecycle.property.test.ts`,
`tests/unit/services/lifecycle.test.ts`, `tests/unit/renderer/lifecycle.test.tsx`, journey step.

R14, screen links from inline messages: the dashboard backup warning ("No backup has been made yet. Make one under
Settings.") renders "Settings" as a real link (`components/ScreenLink.tsx`: an anchor `href="#/settings?card=backup"`
with the visible text, keyboard focusable, `aria-describedby` none needed) through `react-i18next` `<Trans>` so the
sentence stays one i18n key with a `<link>` tag. `lib/router.ts` exposes the `card` query param; `SettingsScreen.tsx`
reads it on mount and on hashchange, scrolls the matching card (`id="card-backup"`, and `card-templates`,
`card-updates`, `card-password`, `card-email-templates`, `card-authority`, `card-appearance`) into view with
`scrollIntoView({ block: 'start' })` and moves focus to the card heading (`tabIndex=-1`), then clears the param so
a later manual scroll is not undone. Works from any screen (the link is a hash route). Sweep of other inline
messages naming a screen, converted with the same pattern: `export.noTemplateBody` and `templates` card hints ->
`#/settings?card=templates` (file owned by G2: D supplies the key and the component, G2 applies it);
`dashboard.*` tiles that mention Review queue or Requests -> their routes (D); unlock/restore hints that mention
Settings > Backup -> `#/settings?card=backup` (G2). Test: `tests/unit/renderer/screen-link.test.tsx` (dashboard
warning contains a link with the right href; Settings mounted with `?card=backup` calls `scrollIntoView` on the
backup card and focuses its heading; param cleared afterwards) and a journey assertion that clicking the dashboard
link lands on Settings with the Backup heading focused (`document.activeElement`).

Email/log implications: `reminder-outstanding` is offered only for `exported|sent-to-dc|responded`; the status
e-mail on a `finished`/`closed` request says "final"; audit events `request.finish` (auto, actor `system`),
`request.close`, `request.reopen` carry `{ requestId, fromStatus, toStatus, noteLength }` only; `Dashboard` gains
`requestsByStatus: Record<RequestStatus, number>` (A0 adds the field).
Acceptance: importing a response that answers every item flips the request to Finished without user action;
Close is disabled until Finished; Reopen needs a reason >= 3 chars; audit chain verifies; property test proves no
transition outside the table.

## 7. Lane E: e-mail templates and vetting-authority contacts (Sonnet)

Goal (R3, R4, R2 compose side): templates per purpose with placeholders, preview and reset-to-default, stored in
encrypted settings; default To/Cc contacts for the DC/INL vetting mailbox used by the "send request to DC" draft;
the requestor's e-mail pre-fills To for requestor-facing templates.

Template engine (`src/main/services/email-templates.ts`, pure): placeholders `{requestor_name}`, `{requestor_org}`,
`{event}`, `{event_dates}`, `{status_table}`, `{valid_until}` (earliest expiry among approved), `{batch_id}`,
`{as_of}`, `{attachment_name}`, `{office_name}`; unknown placeholder stays literal and the preview flags it;
`{status_table}` only expands in templates that may carry personal data (status, reminder) and sets
`containsPersonalData`. Defaults = today's `buildDraft` texts. Purposes: `status-to-requestor` (= clearance-notice),
`all-clear`, `request-to-dc`, `reminder`, `acknowledgement`. `Settings.emailTemplates[purpose] = { subject, body } | null`
(null = default; reset deletes the override). Preview (`email.previewTemplate`) renders against a fixed synthetic
sample (names like `EXAMPLE, Sample Person`), never vault data. Validation: subject <= 200 chars, body <= 20 000,
no control chars. Contacts: `Settings.vettingAuthority.to/cc` lists of `{ name, email }` (address rule of
`assertAddress`); `request-to-dc` drafts default To/Cc from it; requestor templates default To = requestor e-mail,
Cc empty. Settings save stays password-gated (existing `settings.update`).

Owns: `services/email.ts` (buildDraft delegates to the engine), `services/email-templates.ts`,
`components/settings/EmailTemplatesCard.tsx` (purpose tabs, subject/body editors, placeholder chips that insert at
the caret, live preview pane, Reset to default, dirty indicator), `components/settings/VettingAuthorityCard.tsx`
(editable To/Cc rows, add/remove, validation), `dialogs/EmailRequestorDialog.tsx` (template picker uses purposes,
To pre-filled, "Edit templates" link), `locales/en/emailTemplates.ts`, `locales/en/authority.ts`,
`mock/ext/email.ts`, tests `tests/unit/app/email-templates.test.ts` (rendering, escaping, unknown placeholder,
personal-data flag), `tests/unit/renderer/settings-email.test.tsx`, journey step (set a template, draft shows it).
Acceptance: a changed subject template appears in the next draft; reset restores the default; drafting
`request-to-dc` pre-fills the authority To/Cc; nothing about templates or contacts is written to the audit text
beyond field names; `.eml` output unchanged for default templates (golden).

## 8. Lane F: wizard navigation and friendly wrong-file state (Haiku)

Goal (R5 + the UI half of R6): both import wizards expose explicit steps with Back and Cancel at every step;
cancelling discards the preview (main already drops previews on lock; F calls a new no-op-safe
`responses.discardPreview`/`requests.discardPreview` A0 adds so the parsed file leaves memory at once); the
response wizard shows a dedicated state for `LOOKS_LIKE_REQUEST` / `WRONG_FILE_KIND` with a button to the request
importer instead of a raw rule code.

Owns: `components/Wizard.tsx` (steps header with `aria-current="step"`, Back / Cancel / Next slots, confirm-on-cancel
when choices were made), `screens/ResponsesScreens.tsx` (steps: Pick file -> Match request -> Decide rows ->
Confirm; batch-id prompt when `META_LABEL_MISSING`), `locales/en/wizard.ts`, `mock/ext/wizard.ts` (mock parse of a
request fixture name returns the new code), tests `tests/unit/renderer/wizard.test.tsx`, journey assertions.
The request importer gets the same shell in a follow-up by B (B owns that screen) using F's component; F lands first
where possible, otherwise B adopts it on rebase.
Acceptance: every step has Back and Cancel reachable by keyboard; Cancel returns to the list and a second import
starts clean; picking `resp-011` shows the friendly message and the link.

## 9. Lane G1: UI infrastructure (Sonnet)

Goal (R8 part 1): a table engine that cannot overlap; icon copy buttons; local fonts and icons; a density option.

- `DataTable` v2 (`components/DataTable.tsx`, backwards compatible `col()` plus `col.meta`): per-column `width`,
  `minWidth`, `maxWidth`, `grow`, `truncate` (CSS ellipsis + `title` tooltip via Mantine `Tooltip` on overflow only),
  `sticky: 'first'`, `align`, `hideable` and `defaultHidden`; `table-layout: fixed` inside a horizontal scroll
  container with `role="region" aria-label` and keyboard scrolling; sticky header; column chooser popover (checkbox
  list, persisted per table id in `Settings.tableColumns` through a debounced `settings`-free local write:
  the renderer keeps it in `localStorage`-equivalent is not allowed (cleared on lock), so it goes through
  `settings.update` only when the user presses Save in Settings > Appearance; until then it is session state);
  density classes `comfortable|compact` from `Settings.uiDensity`; empty-state slot with icon and hint.
- `CopyIconButton` replaces `CopyButton`: Mantine `ActionIcon` with a copy icon, `aria-label="Copy <field>"`,
  tooltip, 1.2 s checkmark swap with `aria-live="polite"` "Copied"; also used by the compose dialog "Copy body".
- Fonts and icons bundled locally: `@fontsource-variable/inter` (OFL-1.1) or `@fontsource-variable/source-sans-3`
  (OFL-1.1) as woff2 via CSS `@font-face` in `styles.css` (`font-src 'self'` already allowed by CSP; no CDN);
  `@tabler/icons-react` (MIT) imported per icon so tree-shaking keeps the bundle small; `docs/THIRD-PARTY-NOTICES.md`
  lists font and icon licences with versions; `tests/security/no-net-imports.test.ts` gets a case that the built
  renderer references no `http(s)://` font or icon URL.
- `components/settings/AppearanceCard.tsx`: density, "reset table columns", theme (moved from the top bar toggle,
  which stays).
- `docs/A11Y-CHECKLIST.md`: focus order, visible focus, names on icon buttons, table semantics, contrast >= AA,
  keyboard-only pass per screen, reduced motion, 150 % scaling. Every later UI lane ticks it in its PR.
- **R13, reference implementation: the People table** (`screens/people/PeopleScreen.tsx`). Column config:
  Name `sticky: 'first'`, `minWidth 220`, `grow`, truncate + tooltip; DOB `width 112`, `nowrap`; Nationality
  `width 120`, truncate; Unit `maxWidth 200`, truncate with ellipsis + tooltip carrying the full unit name; Status
  `minWidth 150`, `nowrap`, `StatusBadge` always with its text label (colour is never the only signal; badge
  `variant="light"` keeps AA contrast via the existing tokens); Expires `width 120`, `nowrap`, ISO date never wraps
  (`white-space: nowrap` + fixed width, cell overflow visible is forbidden by the engine); Review `width 96`.
  DataTable gains `nowrap` and `tooltip` column flags for this and applies `overflow: hidden; text-overflow: ellipsis`
  to truncating cells.

Owns: files above, `theme.ts`, `styles.css`, `main.tsx`, `package.json` (two dependencies), `locales/en/ui.ts`,
tests `tests/unit/renderer/datatable.test.tsx` (truncation, hidden columns, sticky class, empty state),
`copy-icon.test.tsx` (name, feedback, clipboard call), `tests/unit/renderer/people-table.test.tsx` (asserts the
People column config: Expires and Status cells carry the nowrap class and widths, Unit cells the truncate class and
a tooltip with the full name, Status cells contain visible text), and `tests/e2e/people-table-layout.test.ts`
(mock backend in Chromium, `?mock=1`, seeded long unit names; at 1280x720 and 1366x768 every Expires and Status
cell's bounding-box height equals one line height, Unit cells never exceed their column width, and a PNG of the
screen is saved to the test's temp output for the PR). Lane end plus `npm run build` bundle check: no network URL
in `out/renderer`.
Acceptance: existing screens render unchanged through the compatible API; a 12-column table at 1024 px scrolls
horizontally with the first column pinned and no overlapping text; on People the Expires date is on one line, the
status reads as text and colour, and long unit names show an ellipsis with the full name on hover and focus.

## 10. Lane G2: screen-by-screen UI pass (Sonnet)

After G1, B, D, E, F and K are merged. Goal: apply the table engine and layout rules to every screen: Requests,
Request detail items, Import preview, People, Person detail (records, requests), Units, Review list, Responses,
Response import rows, Search, Audit, Dashboard tiles/lists, Settings cards, Export preview dialog, Diff grids.
Rules: first column sticky where rows are identified by a name; dates fixed width; status badges `minWidth`;
long names truncate with tooltip; action columns pinned right at >= 1280 px; forms max width 720 px; dialogs
`size="xl"` only when they contain tables; no horizontal page scroll at 1024 px; test the five viewports from R8 by
hand with the dev build before H automates it. Owns every `screens/*.tsx` and `components/dialogs/*.tsx` for layout
changes only (no behaviour). Tests: existing renderer tests stay green; add `tests/unit/renderer/layout.test.tsx`
smoke rendering each screen with the mock at 1024 px (jsdom width stub) asserting no column is both `truncate`-less
and unbounded.

## 11. Lane H: screenshot harness, demo seeder, reviewer rubric, fix loop

Goal (R8 part 2): evidence-based UI review on the real app.

- Demo seeder (`tools/demo/seed.ts`, synthetic only): when `VSS_DEMO_SEED=<password>` is set **and** the build is
  not a release channel (`dev` or `alpha`, see lane I) **and** no vault exists in `VSS_DATA_DIR`, main creates the
  vault and, through the real services, imports **the lane M demo dataset from `fixtures/demo/**`** (its two request
  workbooks and two DC responses, which by design leave some people unmatched in both directions, so review items
  of every kind appear naturally), then adds only what the dataset cannot express as files: one e-mail clearance, one
  manual record, one merge, a template capture (from the first demo request), two requestors, one request taken to
  Finished and one to Closed, a backup config pointing at a temp folder. The seeder reads a small manifest
  `fixtures/demo/manifest.json` (file order and the few post-import actions) that lane M owns; H never adds rows of
  its own. Guarded by `tests/security/demo-seed-guard.test.ts` (never runs when channel is `release`). If lane M is
  not merged when H starts, H develops against `req-001/002` + `resp-001/002` behind the same manifest shape and
  switches the manifest path once M lands.
- Harness (`tests/ui-audit/*.test.ts`, own `vitest.ui.config.ts`, never part of `npm test` or CI): launches
  `out/` through Playwright `_electron` (the packaged exe cannot be driven over CDP since F-10; the harness notes
  this and H also takes a manual packaged pass of three screens), one run per viewport `1024x720`, `1280x720`,
  `1366x768`, `1920x1080`, and `1280x720` with `--force-device-scale-factor=1.5`; light and dark; routes: every
  `NAV` entry, request detail, person detail, unit detail, review detail (each kind), both wizards at each step,
  each dialog (export, mark sent, e-mail clearance, compose, link item, picker, close/reopen), empty states (second
  data dir without seed), error state (`resp-011`), lock warning, unlock. Screenshots and `axe-core` JSON go to
  `%TEMP%\vss-ui-audit\<timestamp>\<viewport>\<screen>.png` with an `index.json`; nothing under the repo;
  `.gitignore` gains `ui-audit/`.
- Reviewer rubric (`docs/ui-audit/RUBRIC.md`): readability (font size >= 13 px, line length), overlap/clipping,
  truncation with tooltip, contrast (axe + visual), keyboard access (focus ring visible, order), empty and error
  states (message + next action), consistency (spacing, badge colours, button hierarchy), density at 150 %;
  severities P1 (blocks use), P2 (confusing), P3 (polish). Two reviewer agents (Sonnet, then Opus independently)
  read the PNGs and `index.json` and write `docs/ui-audit/<date>-round<N>-findings.md` (table: id, screen,
  viewport, severity, evidence file name, proposed fix); no screenshot is committed.
- Fix loop: round N = triage (dedupe both reviewers' findings) -> fix tickets (Haiku for mechanical, Sonnet for
  layout logic) -> rerun harness -> re-review. Max 3 rounds; exit when zero P1, zero P2 on the 1280x720 and 1366x768
  profiles, remaining P3 listed in README known limitations.

Owns: `tools/demo/**`, `tests/ui-audit/**`, `vitest.ui.config.ts`, `docs/ui-audit/**`, `.gitignore` line; fixes
touch the files the ticket names (sequential, after G2, no parallel lanes during rounds).

## 12. Lane I: alpha release preparation (Sonnet; Opus review)

Goal (R9): a `0.2.0-alpha.1` build that testers can install, with updates off, a visible alpha banner, a safe
feedback path and tester docs. Nothing is published by this lane; it ends with a tag and a draft pre-release.

- Channel: `src/main/app/channel.ts` exports `CHANNEL` from the build define `__VSS_CHANNEL__` (`electron.vite.config.ts`
  `define`, default `'dev'`; `npm run dist:alpha` sets `alpha`; `release` otherwise). Prerelease versions
  (`-alpha.N`, `-beta.N`) build only with channel `alpha`; `tests/unit/app/channel.test.ts` asserts the matrix.
- Alpha gating in main: `createRealUpdateService` is replaced by a stub when `CHANNEL === 'alpha'` (phase
  `'disabled'`, message key `updates.alphaDisabled`), `updateCheckEnabled` is ignored (NetGate never enabled; the
  journey offline proof covers it), the Updates card is hidden and Settings shows "Updates are disabled in alpha
  builds". `app.info()` returns the channel; `app.openFeedback()` opens, through the existing external opener,
  exactly `https://github.com/UNODC-Cyber/VSS/issues/new?template=alpha-feedback.yml&labels=alpha&title=[alpha+<version>]+`
  with only version, OS version and architecture appended; nothing from the vault. `.github/ISSUE_TEMPLATE/alpha-feedback.yml`
  has a required checkbox "I have not pasted names, dates of birth or any file content".
- Renderer: `components/AlphaBanner.tsx` (top strip "Alpha build <version>: for testing with synthetic data; no
  automatic updates; send feedback", dismissible per session, `role="status"`), Help entry in the top bar menu:
  About (version, schema, channel, licence notices link) and Send feedback.
- Release workflow: `release.yml` gets `prerelease: ${{ contains(github.ref_name, '-') }}`; the "Refuse placeholder
  update-signing keys" step runs only when **not** prerelease; prerelease builds run `npm run dist:alpha`, assert the
  channel in the bundle (`node tools/verify-channel.mjs out/main/index.js alpha`), produce `SHA256SUMS` **and**
  `SHA512SUMS`, do **not** upload `latest.yml`/`*.blockmap` (so no installed app can ever see the alpha as an
  update), and create the GitHub release as `--draft --prerelease`. `tests/security/ci-hygiene.test.ts` gains
  the three assertions (prerelease skips the key gate only for prerelease tags, no `latest.yml` on prerelease,
  alpha channel asserted). Stable `vX.Y.Z` tags keep today's path untouched; real keys still require the key
  ceremony in `docs/RELEASE-RUNBOOK.md` section 2 before the first non-alpha release.
- Docs: README "Alpha testing" section (install the unsigned build, SmartScreen steps from the runbook, verify
  `SHA256SUMS` with `Get-FileHash -Algorithm SHA256`, use synthetic or test data only, how to send feedback, how
  to wipe), `docs/KNOWN-LIMITATIONS.md` (unsigned, no updates, FIDO2 deferred, peer mode off, packaged in-app
  journey is manual, residual risks from `docs/SECURITY.md`, P3 UI items from lane H), `CHANGELOG.md` `0.2.0-alpha.1`
  section, `docs/PLAN.md` pointer to this file, `docs/RELEASE-RUNBOOK.md` section 3a "Alpha pre-releases".
- Checklist (executed by the owner, not CI): version bump in `package.json` to `0.2.0-alpha.1`; all lanes merged;
  `npm test`, e2e, ui-audit exit criteria met; `npm run dist:alpha` locally, `tests/e2e/packaged.test.ts` green
  against `dist/win-unpacked`; manual packaged journey (create vault, import request, export, import response,
  close request, lock/unlock); tag `v0.2.0-alpha.1` (signed) and push; inspect the draft pre-release assets and
  sums; **stop** (publishing is a separate owner decision).

Owns: `channel.ts`, `tools/verify-channel.mjs`, `AlphaBanner.tsx`, `components/settings/AboutCard.tsx`,
`.github/**`, `README.md`, `CHANGELOG.md`, `docs/KNOWN-LIMITATIONS.md`, `docs/RELEASE-RUNBOOK.md`, `docs/PLAN.md`
pointer, `locales/en/alpha.ts`, `mock/ext/app.ts`, `package.json` version and `dist:alpha` script.

## 13. Lane J: native crash and dialog failure investigation (Opus)

Symptoms (owner, packaged `win-unpacked` exe): native access violation in `explorerframe.dll` (unloaded) after a
file dialog on the request-import summary page; later a main-process error dialog `TypeError: Error processing
argument at index 1, conversion failure` at `out/main/index.js:15639:5`. Source maps are excluded from the package
(`'!**/*.map'`), so that line may not be `app.setPath('userData', ...)` (which always receives a string from
`resolveAppPaths`); the message is Electron's argument-converter error and, with index 1, points at the **options**
object of a `dialog.show*Dialog(window, options)` call or at a destroyed window handed to a dialog/`webContents`
call. Treat the line as unverified until mapped.

Steps:
1. Reproduce: `npm run dist` with a scratch `electron.vite.config.ts` override that keeps source maps
   (`sourcemap: true`, maps **not** shipped), launch `dist/win-unpacked` with `VSS_DATA_DIR` in temp, drive the real
   native Open dialog with `tools/e2e-native/drive-import.ps1` (PowerShell 7, `System.Windows.Automation` to find
   the dialog, `SendKeys` to type a fixture path, 20 iterations, also: double-click the Choose button, cancel the
   dialog, let the auto-lock fire while the dialog is open by setting `autoLockMinutes = 1`, minimise the window
   before the dialog returns). Collect `Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Application Error'}`
   and the mapped stack. Record the outcome matrix in `docs/INVESTIGATION-dialog-crash.md` (no paths, no personal data).
2. Hypotheses to confirm or rule out, in this order: (a) `getWindow()` returns a window that is destroyed or
   mid-navigation (`performLock` calls `ports.navigate('lock')` and `clearStorageData()` while a modal native dialog
   is open); (b) two dialogs opened concurrently (double invocation from a double click; the renderer `act()` does
   not disable the button); (c) options object with `undefined` members (`title`, `defaultPath`) rejected by the
   Electron 45 converter; (d) `properties: ['openDirectory','createDirectory']` combined with filters; (e) the
   window hidden/minimised when the dialog is parented (`explorerframe` teardown race); (f) the `second-instance`
   handler focusing a window while a dialog is modal.
3. Fixes (regardless of which hypothesis holds): `electron-ports.ts` gets a `DialogGate`: one native dialog at a
   time (a second call answers `CANCELLED`), parent only `win && !win.isDestroyed() && win.isVisible()`, options
   built without `undefined` keys, dialog calls wrapped in try/catch mapping to `Result` errors; the lock controller
   gains `holdWhile(promise)` so idle lock waits for an open dialog (max 10 min, then locks after the dialog
   returns); the renderer disables pick buttons while a pick is pending (`useAction` gains `busy`); `navigate()`
   is deferred until no dialog is open.
4. Crash guard (`src/main/bootstrap/crash-guard.ts`, wired in `index.ts`): `process.on('uncaughtException')`,
   `process.on('unhandledRejection')`, `app.on('child-process-gone')`; each logs a PII-free event
   (`{ kind, code, phase }` through the allowlisted logger; the error message is never logged), locks the vault,
   emits `app:crash-recovered`, shows a friendly `dialog.showMessageBox` ("Something went wrong; the vault was locked
   to protect your data. No personal data was written to a log.") with "Continue" and "Quit", and never shows the
   raw Electron error box (`process.on` handlers registered before `app.whenReady`). A second fault within 5 s quits.
5. Tests: `tests/unit/app/dialog-gate.test.ts` (serialisation, destroyed window, undefined stripping, cancel on
   concurrent call), `tests/unit/app/lock-hold.test.ts`, `tests/unit/app/crash-guard.test.ts` (fake emitter: log
   fields allowlisted, lock called, dialog called once, no message text in the log), `tests/e2e/journey.test.ts` step
   "two rapid picks yield one dialog" (Playwright stubs the dialog through `app.evaluate`), `tests/e2e/packaged.test.ts`
   unchanged; the UIA script is documented as a manual VERIFY step (it needs a desktop session).

Owns: `electron-ports.ts`, `main/index.ts`, `bootstrap/crash-guard.ts`, `services/lock.ts` (`holdWhile`),
`services/files.ts` (gate hook), `lib/api.ts` (`busy`), `locales/en/crash.ts`, `tools/e2e-native/**`,
`docs/INVESTIGATION-dialog-crash.md`, tests above.
Acceptance: 20 scripted dialog cycles on the packaged build without an Application Error event; a forced
`uncaughtException` in a dev build shows the friendly dialog, the vault is locked, the log line has no message
text; all dialog paths return `Result` errors instead of throwing.

## 14. Lane K: review queue (Opus for the service, Sonnet for the UI)

Bugs: (R11) in Review the user cannot choose whom to link a record to: per-candidate buttons exist only when the
matcher produced candidates, and "Choose other" opens a `PersonPicker` that shows nothing until a search is typed
and submitted; the `persons.list` text search does not cope well with `SURNAME, Given`, mixed scripts or partial
names. (R12) The Review list shows only kind, time, tier and a subject count, never who the item is about; the
"unmatched response row" / "response row match" detail offers no way to assert manually that a row is a valid DC
answer, nor to correct a DC typo in the row or in the linked person before linking.

Order inside the lane: K-a picker (R11), K-b list context (R12a), K-c manual validate + edit in place (R12b).
No change to automatic linking anywhere: everything here is an explicit, reasoned, audited user action.

Design, R11 picker:
- Main: `persons.suggest({ forSubject, text?, limit = 20 })` in `services/people.ts`: (1) `candidate` rows = the
  matcher's near candidates for the subject (reuse `matching` with relaxed tiers T1..T4 plus surname-trigram
  neighbours, never auto-linking anything), (2) `recent` = persons touched in the last 30 days on the same unit or
  request, (3) `search` = tolerant query: fold with `foldForSearch`, split on commas and whitespace, drop particles,
  AND the remaining tokens in any order against the trigram index, keep non-Latin tokens as their own trigram
  terms; results de-duplicated, merged/purged persons excluded, each with `tier`/`evidence` when known and the
  `why` label. Bounded (`limit <= 50`), no new SQL tables.
- Renderer `components/PersonPicker.tsx` (used by Review, `LinkItemDialog`, and People merge): opens pre-filled with
  the subject's display name and immediately lists suggestions (candidates first, then recent, then search hits),
  live type-ahead with 200 ms debounce, results as a `listbox` with roving focus (arrow keys, Home/End, Enter to
  select, Escape to close) and a visible Select button per row; row shows name, DOB, unit, identifiers (masked under
  redaction), tier badge and the `why` label; selecting opens an inline side-by-side comparison (`DiffGrid` subject vs
  chosen person) with Confirm / Back; an explicit empty state "No matching person found" lists the alternatives
  as buttons: Create new person, Not the same person, Dismiss (each calls the same `resolve` path as the review
  screen; the picker exposes them through props so `LinkItemDialog` can offer "Create new person" too).
- `screens/ReviewScreens.tsx`: candidate buttons stay; "Choose other" becomes "Choose person..." and is always
  shown for link kinds; `unmatched-response-row` and `unanswered-request-item` kinds also get the picker (link to an
  existing person, or create new / dismiss), since today they offer nothing.

Design, R12a list context (`screens/review/ReviewListScreen.tsx`, `services/review.ts` list):
- `review.list` items carry `subjectName` (the first subject's display name: response row `nameRaw` re-ordered as
  `SURNAME, Given`, request item observed name, or person canonical name), `subjectDob`, `unitName`, `context`
  (request event name or response batch id) and `bestTier`, computed in the service from the existing repos (one
  query per page, no schema change). Columns: Subject (sticky, `Sensitive`), DOB (`Sensitive`, nowrap), Unit
  (truncate), Context (link to the request or response), Kind, Best tier, Created. Redaction mode masks Subject and
  DOB exactly as elsewhere. The list is sortable by created time and filterable by kind as today.

Design, R12b manual validate and edit in place (`services/review.ts`, `components/review/*`):
- `review.manualValidate({ id, target, reason })`, allowed for kinds `response-row-match`, `unmatched-response-row`
  and `request-item-link` whose subject is a response row: the reviewer asserts the row is a valid DC answer for the
  chosen person, request item or a brand-new person. The service (one transaction) links the row (`match.decision
  = 'confirmed'`, `decidedBy = actor`), creates the vetting record or unit record from the row's own values
  (`dispClass` -> disposition; `certDate`/`expires` parsed; a row with `dispClass: 'unknown'` is refused with
  `REASON_REQUIRED`-style `BAD_REQUEST` "set the disposition first"), refreshes item policy and lifecycle, resolves
  the item with `resolution = 'manual-validate'` and audits `review.manual-validate` `{ reviewId, rowId, targetKind,
  targetId, disposition, reasonLength }` (the reason text lives on the review item's `resolution_note`, added by
  migration 008, never in the audit text). Reason >= 3 chars is required (`REASON_REQUIRED`). UI: "Manually
  validate" button -> confirmation dialog (target summary, disposition and dates that will be recorded, reason
  field) -> apply; the row's `decidedBy` shows "manually validated by <actor>" in the request detail.
- `review.editSubject({ id, subject, reason })`: (1) response row patch (name, DOB, POB, unit name, cert/expiry
  dates, `dispClass`): the current values move to `response_row.original_json` (first edit only, so the DC original
  is always kept) and `response_row_edit(id, row_id, at, actor, reason, diff_json)` records every edit (migration
  008); name key, search blob and match candidates are recomputed for the row (candidates are shown again, still
  never auto-confirmed); (2) person patch: delegates to `persons.update` with the same reason (existing audit
  `person.update`; `merge_log`-style snapshot already exists for persons via provenance in migration 002, K verifies
  and otherwise adds `person_edit` to 008). Audit `review.edit-subject` `{ reviewId, subjectKind, subjectId,
  fields: 'nameRaw,dob', reasonLength }`. `ReviewSubject.edited/original` lets the diff grid show the DC original
  under the corrected value. Undo: "Revert to DC original" button restores `original_json` through the same method
  (audited); person edits are reverted with the normal person edit path. Both actions sit behind a confirmation
  dialog that repeats the diff. Edits are refused once the row has a confirmed record (`CONFLICT`: unlink first).
- Guards: no edit or validation touches other rows or persons; purge semantics (F-01) extend to `original_json`,
  `response_row_edit.diff_json` and `resolution_note` (K adds a case to `tests/security/purge-complete.test.ts`).

Owns: `services/people.ts` (`suggest`), `services/review.ts`, `db/repos/reviewItem.ts`, `db/repos/response.ts`
(row patch, original, edits), `migrations/008_review_edits.sql`, `components/PersonPicker.tsx`, `screens/review/**`,
`components/review/{ManualValidateDialog,EditRowDialog,EditPersonDialog}.tsx`, `dialogs/LinkItemDialog.tsx`,
`locales/en/picker.ts` (also list/validate/edit strings), `mock/ext/review.ts`, tests
`tests/unit/services/suggest.test.ts` (comma/order/diacritics/Thai tokens, particles, excludes merged, bounded),
`tests/unit/services/review-manual.test.ts` (validate creates exactly one record from row values, refuses unknown
disposition and empty reason, resolves the item, audit fields allowlisted; edit keeps the original, recomputes
candidates without auto-confirm, revert restores byte-equal values, refused after a confirmed record),
`tests/unit/db/migrate.test.ts` case for 008, `tests/unit/renderer/picker.test.tsx` (pre-fill, immediate list,
keyboard selection, empty state actions, compare-then-confirm), `tests/unit/renderer/review-list.test.tsx`
(subject name/DOB/unit/context shown, masked under redaction), `tests/unit/renderer/review-actions.test.tsx`
(validate and edit dialogs require a reason, show the diff, call the IPC), journey steps: (a) import a response whose
row has no candidate, open the item, pick a person through the picker, confirm, the record exists; (b) edit a row's
DOB typo, candidates reappear, manually validate against the request item with a reason, the request reaches
Finished.
Acceptance: every open review item of a link kind can be resolved from the keyboard alone; the list names its
subjects; a no-candidate row can be linked, corrected and validated with a recorded reason and the DC original
retained; `suggest`, edit and validate never create an automatic link; audit chain verifies.

## 15. Lane L: Settings danger zone, Delete database (Sonnet; Opus review)

Goal (R15): expose the existing `vault.wipe({ password, confirm: 'WIPE' })` (service, schema and mock already exist;
no renderer calls it) behind a deliberately slow UI.

- `components/settings/DangerZoneCard.tsx` (last card, red outline, `id="card-danger"`): explanatory text listing
  what is deleted (the vault header and encrypted database, every stored workbook and export kept inside it, the
  pre-migration copies, the Chromium session folder, all settings and templates) and what is **not** (exported
  workbooks, `.eml` files, CSVs and backups written to folders the user chose; the automatic backups in the
  configured backup folder stay unless the box below is ticked), a recommendation to make a backup first with a
  `ScreenLink` to `#/settings?card=backup` (lane D's component; L uses it after D lands, plain anchor before), and
  one button "Delete database...".
- `dialogs/WipeDialog.tsx`: (1) current password (`PasswordInput`, `autoComplete="current-password"`); (2) the exact
  phrase `DELETE DATABASE` typed into a text field (case-sensitive, trimmed, paste allowed: the password is the real
  gate, the phrase is a stop-and-think step; the phrase is shown in the dialog text and is i18n-independent so a
  translated UI still works); (3) optional checkbox "Also delete the automatic backups in the configured folder"
  (shown only when a backup config exists, default off); the Delete button stays disabled until the phrase is exact
  and the password is non-empty, and shows `loading` during Argon2id. Errors: `BAD_CREDENTIALS` -> "Password
  incorrect", `RATE_LIMITED` -> the lockout message with the wait (existing back-off applies; the dialog stays
  open), anything else -> generic error. No second "are you sure" step. Escape/Cancel closes without action.
- After success main answers `state: 'no-vault'`, `App`'s `useVaultRoute` already routes to `#/create`; the dialog
  additionally clears the UI store (`clearData`) and shows a one-time toast "The database was deleted". The
  `vault.wiped` log line (A0) is the only trace; it holds no path, name or count.
- `services/wipe.ts` (`wipeExtras`): when `alsoDeleteScheduledBackups` is set, delete `vss-backup-*.vssbak` and the
  `vss-backup-keyring.vsskeys` in the configured folder **before** the vault is destroyed (the config lives in the
  DB), ignoring missing files; never touches any other file in that folder.

Owns: the three files above, `locales/en/danger.ts`, `mock/ext/danger.ts` (mock wipe returns `no-vault` and resets
the in-memory DB; wrong password -> `BAD_CREDENTIALS`), tests `tests/unit/renderer/danger-zone.test.tsx` (button
disabled until exact phrase, case mismatch keeps it disabled, wrong password shows the error and keeps the dialog,
success routes to the create screen), `tests/unit/app/wipe-extras.test.ts` (deletes only the app's backup files),
`tests/security/wipe-leftovers.test.ts` extension (with and without the checkbox; data dir, session dir and
migration-backup dir hold no `vault.json`, `vss.db`, `-wal`, `-shm` or stored blobs afterwards; a byte scan of the
data folder for a fixture name finds nothing, same approach as the purge test), journey step: wipe through the UI ->
create a new vault -> the old request is gone -> old files absent on disk -> the new vault works.
Acceptance: no way to reach the wipe with fewer than password + exact phrase; back-off counts wrong attempts; a
fresh vault can be created immediately afterwards; no personal data in the log line.

## 16. Cross-cutting requirements for every lane

- i18n: no literal user-visible string; new keys only in the lane's `locales/en/<ns>.ts`; a unit test
  (`tests/unit/renderer/i18n-keys.test.ts`, added by A0) fails on duplicate keys across namespace files.
- Mock parity: every new or changed method is implemented in the lane's `mock/ext/<lane>.ts` so renderer tests and
  `mock-journey` cover the UI without Electron; the production bundle must still contain no mock code
  (existing test).
- Regression: each lane adds at least one e2e journey assertion for its feature and keeps `tests/e2e/journey.test.ts`
  offline proof green; security suites under `tests/security/` are never weakened.
- Code quality: strict TypeScript, ESLint and Prettier clean; no new dependencies except the two in G1 (fonts,
  icons), each pinned exactly and recorded in `docs/THIRD-PARTY-NOTICES.md`; `npm run setup` unchanged.
- Privacy: audit `details` and logger fields stay allowlisted; new audit types are listed in the lane PR; no
  personal data in issue messages, templates previews, feedback URLs, screenshots committed (none are), or docs.
- Docs: each lane updates the doc it owns in the same PR (`FILE-FORMATS.md` by C, `A11Y-CHECKLIST.md` by G1,
  `KNOWN-LIMITATIONS.md` and README by I, `INVESTIGATION-dialog-crash.md` by J); `docs/PLAN.md` gets a one-line
  pointer to this plan (A0).
- PR template line for every lane: "Lane end run: typecheck / lint / format:check / vitest / e2e (if UI or IPC):
  all green on <commit>".

## 17. Open points for the owner (defaults in brackets)

1. Unknown section label: block the import as before, or warn and classify by DISP with review items as planned in
   lane C [warn + review items].
2. Lifecycle: should `finished` also require every item's person to be linked (`personId != null`), or is an
   excluded item enough [excluded items count as resolved].
3. Requestor dedupe without e-mail: name + organisation, or name only [name + organisation].
4. Font: Inter or Source Sans 3 [Inter variable, OFL-1.1].
5. Alpha feedback link: GitHub issue form as planned, or a mailto to a project mailbox [GitHub issue form].
6. Wipe confirmation phrase: fixed `DELETE DATABASE`, or the vault display name (varies per user, harder to
   translate, can be pasted from the audit screen) [fixed phrase, paste allowed].
