# VSS — Vetting Support System: Implementation Plan

Offline, per-user (no admin) Electron desktop app for country offices to track vetting requests and DC responses.
**PUBLIC REPO RULES: no real personal data, no internal organisation info, no credentials, ever. Synthetic fixtures only.**
Shared contracts: `src/shared/domain/types.ts` (domain), `src/main/db/migrations/001_init.sql` (schema), `docs/FILE-FORMATS.md` (rules). Change contracts only via the contracts owner.
Next: Alpha 1 (0.2.0-alpha.1) lanes, file ownership and contract slots are planned in `docs/PLAN-ALPHA.md`.

## Decisions (maintainer, 2026-11-03)
- App name **Vetting Support System (VSS)**, repo `UNODC-Cyber/vss`, public, Apache-2.0.
- Unsigned pilot builds (SmartScreen "Run anyway"); apply to SignPath Foundation (free OSS signing) later. Updates are verified by our own hybrid post-quantum signed manifest, independent of TLS and Authenticode.
- Hardware key: **FIDO2 is DEFERRED (post-MVP)**. MVP uses a single password only (Argon2id). The vault header keeps a versioned `slots` array so a FIDO2 PRF slot can be added later; WP-06 spike is parked. YubiKey OTP challenge-response is dropped.
- Email-only "all clear": default expiry = clearance date + **30 days** (`emailClearanceDefaultDays`), stored with `expiryAssumed=true`, overridable per clearance.
- Auto-update ON by default, user-toggleable; every other network feature OFF by default. LAN peer mode experimental, OFF.

## Stack
Electron (pin exact) + TypeScript strict + React 19 + Vite via `electron-vite` + Mantine + TanStack Table + Zustand + i18next. DB: `better-sqlite3-multiple-ciphers` (cipher chacha20, page-level AEAD, FTS5 trigram). KDF: `hash-wasm` Argon2id (m=256 MiB,t=3,p=1, auto-tuned to >=0.7 s, floor 64 MiB). Symmetric: `node:crypto` AES-256-GCM + HKDF-SHA-512; `@noble/ciphers` XChaCha20-Poly1305 for backups. PQ: `@noble/post-quantum` ML-DSA-65 (update manifests, hybrid with Ed25519) and X-Wing hybrid (X25519+ML-KEM-768, peer mode). xlsx: **no exceljs/SheetJS** — `fflate` + `fast-xml-parser` + own OOXML patcher (template patching keeps hidden Reference Data sheet, x14 validations, styles). Packaging: `electron-builder` NSIS `perMachine:false, oneClick:true, allowElevation:false` + portable. Updates: `electron-updater` (GitHub provider, public repo) + manifest signature check. Tests: Vitest, fast-check, Playwright `_electron`.
Process model: main owns vault/DB/files/crypto/updates; preload exposes typed `window.vss` only; renderer is `sandbox:true, contextIsolation:true`, CSP `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'`, custom `vss://app` scheme. A single `NetGate` module is the only importer of network APIs.

## Security essentials
- Vault: `vault.json` (public header, HMAC'd) + `vss.db`. Random 32-byte DEK; key slots (password | fido2-prf | password+prf) wrap the DEK with AES-256-GCM under HKDF'd KEK. Password change = rewrap. Settings live inside the encrypted DB; changing them needs password/PRF re-entry.
- Auto-lock (default 10 min idle, suspend, lock-screen, manual): close DB, zero key buffers, drop caches, navigate renderer to lock route, clear clipboard if we wrote it.
- Clipboard: copy via main, exclude-from-history format, auto-clear after N s.
- No telemetry, crashReporter off, spellcheck off, permission requests denied, navigation blocked, logs never contain PII (field allowlist). Fuses: RunAsNode off, NodeOptions env off, inspect args off, asar integrity on, OnlyLoadAppFromAsar on.
- Update: check <=1/24 h after unlock if enabled; user clicks download; verify Ed25519 AND ML-DSA-65 signatures over release manifest + SHA-512 of installer; only then offer install. Private keys offline, never in CI secrets.

## Identity integrity ("never guess, flag first")
Normalise names (NFKC, casefold, strip diacritics, Thai tone-mark strip, particles `bin binti a/l a/p s/o d/o van von de ...` removed from core tokens, honorifics/ranks removed, curated variants e.g. mohd/muhammad). Candidates from identifier equality, core-key equality, DOB (and day/month-swapped) + shared token, trigram on surname, and within-batch comparison.
Tiers: **T1** auto (full name equal AND DOB equal AND no sex/ID/father conflict AND the DOB is not a placeholder; cross-request additionally a strong anchor, see below; veto if >=2 T1 candidates) · **T2** review, pre-selected (DOB swapped; DOB conflict + same unit; one extra/missing particle/initial token; ID+DOB equal but name differs) · **T3** review (surname+DOB, Jaro-Winkler>=0.92 + DOB/year, phonetic+DOB, ID alone) · **T4** info (name equal, DOB missing). Anything else: no candidate. Never auto-create a person from a response row.

**Cross-request anchors and conflict evidence (security review F-06, 2026-11-03).** Birth country alone is not an anchor: inside one country programme nearly everyone shares it, so namesakes would be linked. A cross-request T1 needs either `ID_EQUAL` (same passport / national-ID number) or `UNIT_EQUAL` **plus** `POB_PLACE_EQUAL`. `POB_PLACE_EQUAL` = same birth country and, for at least one of POB city / POB state that both sides know, the same value (folded like names, spaces dropped). `POB_PLACE_CONFLICT` (a city or a state known on both sides and different) blocks a cross-request T1. Placeholder dates (`DOB_PLACEHOLDER`: 1 January, which is also how a year-only date is usually encoded; 1 July; 31 December; any year up to 1900) are imprecise and never support a T1 in any mode; the pair falls to T2 review. `FATHER_CONFLICT` (both sides know a father's name and no spelling shares a token) is conflict evidence and blocks T1. `ID_CONFLICT` (same identifier type, different number, e.g. two passport numbers) caps a candidate at T3. Rank / title is not identity evidence (it changes with promotions). Manual request entries can carry POB city/state, passport, national ID and father's name for this reason. Not done: demoting a date that many persons share (needs a DB statistic) and an auto-link rate in the audit. Merge/split with `merge_log` snapshots, "not the same person" negative pairs, hash-chained audit.

## File-format notes (details in docs/FILE-FORMATS.md)
Request = INVESTc workbook (sheets `Template Instructions`, `Data`, hidden `Reference Data`); blocks located by marker text (`UNITS`, `LEAVE A ROW BLANK`, `INDIVIDUALS`), never fixed rows. DOB is an Excel serial (or text). Response = single sheet `Final_Results` with four sections; every value is text; NAME is `SURNAME, Given...` re-ordered by DC; POB is `City - State - COUNTRY` with blanks; no ID numbers. Match on token sets + DOB + unit + POB country and flag anything inexact.

## Work packages (lanes parallel after WP-00..02)
| WP | Scope | Tier |
|---|---|---|
| 00 | Scaffold: electron-vite, TS strict, lint, vitest, builder config, fuses, CSP, scheme | Sonnet |
| 01 | Contracts: domain types (done), zod schemas, IPC contract `src/shared/ipc/contract.ts`, rule registry | Sonnet |
| 02 | Synthetic fixture generator + purity gate + blank template builder | Sonnet |
| 03 | Vault: Argon2id, key slots, DEK wrap, header MAC, zeroisation, backup envelope | Opus |
| 04 | DB: encrypted open, pragmas, migrations, repos, FTS blob builders | Opus + Haiku |
| 05 | Auto-lock controller | Sonnet |
| 06 | FIDO2 PRF spike (needs hardware) | Opus |
| 07 | OOXML core (zip, shared strings, cells, serial dates, patcher) | Sonnet |
| 08 | Request parser + validator (R rules) | Sonnet |
| 09 | Request exporter (X rules, filter-original + regenerate) | Opus |
| 10 | Response parser (S rules) | Sonnet |
| 11 | Name normalisation + comparison | Opus |
| 12 | Matcher (tiers, veto, within-batch) | Opus |
| 13 | Review + merge/split services | Sonnet |
| 14-15 | Request flow, response flow (UI + handlers) | Sonnet + Haiku |
| 16 | Manual request log + dashboard (outstanding, aging, mean/median) | Haiku |
| 17 | Search + clipboard | Haiku + Sonnet |
| 18 | Email (.eml writer, mailto, copy) | Sonnet |
| 19 | Settings + lock UI + FIDO2 enrolment | Sonnet |
| 20 | Audit chain + backup/restore | Sonnet |
| 21-22 | CI/release; updater + PQ verification + sign tool | Sonnet / Opus |
| 23 | Hardening + security review | Opus |
| 24 | E2E | Haiku |
| 25 | Docs | Haiku |
| 26 | LAN peer (experimental, after MVP) | Opus |

Acceptance: round-trip `parse(export(parse(f)))` equals `parse(f)`; untouched OOXML parts byte-identical; matcher never returns `auto` when conflict evidence exists or >=2 T1; no network socket with updates off; DB file shows no plaintext of fixture strings.

## Open items
Verify list: native module prebuild for chosen Electron; raw-key pragma names; whether Electron `node:crypto` lacks ML-DSA (expected: noble is used regardless); WebAuthn PRF on the office Windows build; clipboard exclusion format; New Outlook `X-Unsent` handling; real non-approved `DISP` literal; whether managed laptops block unsigned per-user installs (test early).
