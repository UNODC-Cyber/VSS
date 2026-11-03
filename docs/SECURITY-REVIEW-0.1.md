# VSS v0.1 — Independent security review (WP-23)

Reviewed: `main` at `ea97ce9` (2026-11-03). Method: source review with an attacker's eye, then throwaway attack scripts
run outside the repository (Vitest against the real modules, synthetic fixtures only). The repository's own suite
passes (56 files, 662 tests). Nothing in `src/`, `tests/` or config was changed by this review.

## 1. Executive summary

The cryptographic core is in good shape. Vault slot wrapping, header MAC, strict header parsing, KDF bounds, the backup
envelope, and the hybrid Ed25519 + ML-DSA-65 update verification all held up against every forged input tried
(section 4). The encrypted DB, its WAL and `VACUUM INTO` copies leak no plaintext. The OOXML reader is not vulnerable
to entity expansion or lying zip headers.

The real weaknesses are in what happens **around** the crypto:

1. **Purge does not erase.** After `persons.purge`, the person's name is still in the stored original workbook, in the
   request FTS blob (a search for the purged surname still returns the request), and in FTS5 index segments
   (**High**, verified).
2. **The main process trusts renderer-supplied paths.** Every `destPath` / `srcPath` / `destDirectory` is accepted
   as-is. A compromised renderer can write files with chosen content anywhere the user can write: a `.cmd` in the
   Startup folder via `email.writeEml` was shown. It can also restore or open a vault outside the data directory, and
   the next unlock then silently creates an empty DB (**Medium**, verified).
3. **Changing the password does not rotate the DEK.** Any old copy of `vault.json` (OneDrive version history, old
   backups) plus the old password still opens the current and future database (**Medium**, verified).
4. **`filter-original` export keeps unknown package parts byte-for-byte.** A pivot cache, drawing or custom part that
   holds excluded people's data goes out in the export (**Medium**, verified with an added part; the plain fixture
   export is clean).
5. **Cross-request auto-link** needs only full name + DOB + POB country. Placeholder DOBs (for example 1 January) get
   no special treatment, so namesakes can be linked automatically (**Medium**, by construction).

The v0.1 entry point does not wire the domain services (requests, responses, persons, units, review, stats); see 2.1.
Findings in those areas will become live once lane H is plugged in, and they should be fixed before that happens.

## 2. Threat-model deltas

What the plan assumes compared with what the code does:

| # | Plan assumption | Observed |
|---|---|---|
| 2.1 | Main process serves all domain IPC | `src/main/index.ts:61` calls `composeApp` without `laneH`, so `requests.*`, `responses.*`, `persons.*`, `units.*`, `review.*` and `stats.*` all answer `NOT_SUPPORTED` in the built app. Domain findings are pre-integration. |
| 2.2 | "The renderer never gets a path it did not pick" (`src/main/services/files.ts:2`) | Paths are not bound to dialogs. The zod `path` type is just `string(1..4096)` (`src/shared/ipc/schemas.ts:20`). Renderer compromise therefore means arbitrary file read/write, not just data access. |
| 2.3 | Lockout protects the password | The counter lives outside the MAC (`src/main/crypto/vault.ts:17`). It only slows UI guessing inside one process. Offline guessing is limited by Argon2id alone, so the **password policy is the real control** (min 12 chars, enforced only in `schemas.ts:416`). |
| 2.4 | Purge removes personal data | Purge only rewrites structured columns; see F-01. Backups made before the purge also keep the data (inherent). |
| 2.5 | Password change revokes the old password | It does not (F-03). `rotateDek` exists (`vault.ts:509`) but nothing calls it. |
| 2.6 | Vault data stays in the data dir | `vault.restore`/`vault.open` accept any directory, and the DB path is fixed (F-04). |
| 2.7 | Same-user local attacker | Out of scope for confidentiality while unlocked, as for any desktop app. While locked, the remaining protection is the DEK-erasure model and Argon2id. Rollback of the whole `vault.json` + `vss.db` pair cannot be detected (no monotonic counter). |

## 3. Findings

Severity: Critical / High / Medium / Low / Info. Effort: S (< 1 day), M (1–3 days), L (> 3 days).

| ID | Sev | Location | Description | Proof / repro | Recommended fix | Effort |
|---|---|---|---|---|---|---|
| F-01 | **High** | `src/main/services/people.ts:371-412`; `src/main/db/search.ts:193-198`; `src/main/db/migrations/001_init.sql:18,47-50` | **Purge is incomplete.** `purgePerson` blanks person, alias, identifier, request_item and response_row columns. It leaves: (a) `stored_file.content`, i.e. the original request workbook, exported workbooks and response files, all with full name/DOB/passport; (b) the `request_search` / `response_search` blobs, which are not reindexed, so the purged name is still searchable and returns the request; (c) deleted trigram terms in FTS5 `*_data` segments, because FTS5 `secure-delete` is off; (d) the alias holding the merged person's name, added to the survivor on merge (`people.ts:189`). | Script: import fixture `req-001-basic`, purge one person, then scan. `searchAll(name)` gives `request:1`. `request_search_content` contains the name. The stored `r.xlsx` contains the name. On an isolated FTS5 table a deleted row's trigrams are still in `_data`; after `INSERT INTO t(t,rank) VALUES('secure-delete',1)` they are gone. | Inside the purge transaction: reindex every request/response that referenced the person; enable `secure-delete=1` on all four FTS tables (migration 003) and run `optimize` after purge; for stored files, either delete/replace them (re-export a scrubbed workbook) or mark them unrecoverable and refuse `files.saveStored`. Document that earlier backups keep the data and offer "purge also rotates backups". Add a test that greps every table, FTS shadow table and stored blob for the purged strings. | M |
| F-02 | Medium | `src/main/app/compose.ts:353,362-364,402-413,451-452`; `src/main/services/files.ts:76-83`; `src/shared/ipc/schemas.ts:20` | **Renderer-chosen paths are trusted.** `email.writeEml`, `audit.export` (also `mkdir -p`), `files.saveStored`, `vault.backup`, `vault.restore`, `vault.open` and import `path`s accept any path. With renderer code execution (XSS, malicious dependency in the renderer bundle) this turns into code execution. | Script: `email.writeEml({destPath: <dir>\Startup\run.cmd, draft.bodyText: "& echo pwned > x"})` wrote the file with the payload. `audit.export` created nested new directories. | Return an opaque, single-use token from `files.pickSave`/`pickOpen` (main keeps token → path, bound to `kind` and extension). Handlers accept only tokens. At minimum, allowlist extensions per channel and refuse paths outside the dialog result. | M |
| F-03 | Medium | `src/main/crypto/vault.ts:458-477` | **Password change only rewraps the DEK.** An attacker who ever copied `vault.json` (OneDrive history, an old backup bundle, a shared folder) keeps decrypting the live `vss.db` with the old password. The same holds after a suspected compromise. | Script: create vault, copy `vault.json`, change password, restore the old header; the old password unlocks (same DEK). | Offer, and default to, "change password and re-encrypt" using `rotateDek` + `Db.rekey`. Recover `vault.json.next` at startup. State plainly in the UI that a plain change does not revoke old copies. | M |
| F-04 | Medium | `src/main/services/vault-service.ts:221-229,302-330`; `src/main/db/open.ts:118-121`; `src/main/db/controller.ts:46` | **Restore/open outside the data dir silently creates an empty DB.** `VaultService.#dir` follows the renderer-supplied directory, but the DB controller always opens `dataDir/vss.db` with `fileMustExist:false`. Unlock "succeeds" on a brand-new empty DB. The scheduled backups that follow then rotate out (prune) the good backups. | Script: create, back up, wipe, then `vault.restore({destDirectory: <other>})` and unlock gives `state: unlocked`, with a new empty `vss.db` in `dataDir`. | Bind restore/open to `paths.dataDir` in `compose.ts` (as `BackupService.restore` already does). Open with `mustExist: true` except on `vault.create`. Check that `vault.json` and `vss.db` sit in the same directory, and that the DB carries a `vaultId` in `meta` matching the header. | S |
| F-05 | Medium | `src/main/formats/investc/export.ts:521-540` (X-03 design) | **`filter-original` carries unknown parts verbatim.** Only the Data sheet, sharedStrings, core.xml and workbook.xml are rewritten. Pivot caches (`xl/pivotCache/*Records*.xml`), drawings with text, external-link caches, `customXml`, threaded-comment persons and the like are copied, and can hold excluded people's names. No info issue is raised. | Script: fixture + added `xl/pivotCache/pivotCacheRecords1.xml` holding the excluded person's surname; the export still contains it. Baseline fixture export: no excluded field found in any part (shared-string scrub works). | Allowlist the parts filter-original may keep (template parts by name/content type). Fall back to `regenerate`, with an info issue, when anything else is present. Add a "no excluded value in any part" property test over the exporter. | S |
| F-06 | Medium | `src/main/matching/tiers.ts:28-33`; `src/main/matching/dob.ts:35-44` | **Cross-request T1 is weak against namesakes.** Auto-link needs full-name equal + DOB equal + one anchor, and `POB_COUNTRY_EQUAL` counts as an anchor. That anchor is almost always true within one country programme. Placeholder DOBs (`YYYY-01-01`, `1900-01-01`, day = month ambiguous entries) are treated as exact. Father/mother name, rank and passport-number differences are not conflict evidence. | By construction. The existing test "a later request naming a known person auto-links" shows the behaviour with name + DOB + country only. | Do not count POB country as an anchor on its own (require ID or unit). Mark sentinel DOBs (Jan 1, 1900-01-01, any date seen on more than N persons) as low precision so they cannot reach T1. Add `FATHER_CONFLICT` / `ID_CONFLICT` from passport numbers. Track the auto-link rate in the audit. | M |
| F-07 | Low | `src/main/crypto/vault.ts:296-322`; `src/main/crypto/lockout.ts:36-41` | **Lockout fields are unauthenticated.** (a) Editing `vault.json` and restarting resets the counter. (b) `lastFailureAt` set far in the future locks the user out indefinitely, even with the right password; a clock that was wrong when a failure happened does the same. | Script: counter 3 goes to 0 after edit + restart. `lastFailureAt: 9999-12-31` makes the correct password return `RATE_LIMITED` until year 9999. | Clamp `lastAt` to `min(lastAt, now)` and the delay to `MAX_DELAY_MS` from now. Treat the counter as a UX throttle and say so in docs. Optionally MAC the counter under a key derived from a per-install secret in Windows DPAPI. | S |
| F-08 | Low | `src/main/crypto/envelope.ts:102`; `src/main/crypto/kdf.ts:36-43`; `src/main/crypto/vault.ts:411-417` | **KDF cost DoS from crafted files.** Bounds allow m = 1 GiB, t = 16 for a backup header and for each of 8 vault slots. The derivation runs before any authentication and blocks the vault queue. | Script: a backup header patched to m = 1 GiB, t = 16 took 38.6 s and allocated 1 GiB before `BACKUP_INVALID`. | Cap the stored-file maximum lower (for example m ≤ 512 MiB, t ≤ 8, m·t below a budget). Run restore KDF in a worker with a cancel option. Try slots most recent first and stop on the first pass. | S |
| F-09 | Low | `src/main/formats/ooxml/zip.ts:16-31`; import paths in `requests.ts` / `responses.ts` | **Memory DoS on import.** No input file size cap. Honest zips may expand to 512 MiB total (128 MiB per part) in main-process memory, then go through regex parsing. | Script: a 480 KiB xlsx expanding to 4 × 120 MiB was accepted (about 6 s, roughly 0.5 GiB). Lying size headers are safe: fflate truncates to the declared size. | Cap input at about 20 MiB and decompressed at about 64 MiB (sheets) / 256 MiB total. Reject a part whose inflated length differs from its declared size. | S |
| F-10 | Low | `src/main/index.ts:19-29` | **Chromium remote debugging not refused.** Fuses block `--inspect`/`NODE_OPTIONS`/RunAsNode, but `--remote-debugging-port` / `--remote-debugging-pipe` are Chromium switches. A same-user process could start VSS with them and drive the unlocked renderer (and `window.vss`) over CDP. | VERIFY on a packaged build. No `hasSwitch` check exists in the code. | When `app.isPackaged`, exit if `app.commandLine.hasSwitch('remote-debugging-port'/'remote-debugging-pipe'/'inspect*')`. | S |
| F-11 | Low | `.github/workflows/ci.yml:15-16,62-69`; `.github/workflows/release.yml:56-67` | **CI hygiene.** `ci.yml` uses tag-pinned actions (`@v4`), while `release.yml` pins SHAs. `checkout` in CI persists credentials (read-only token). The release job (contents: write) runs `npx @cyclonedx/cyclonedx-npm` with unlocked transitive dependencies. `verify:fuses` is never run in the release job. osv-scanner is advisory only. | Read. | Pin all actions by SHA, set `persist-credentials: false`, move the SBOM to a separate job without write permission (or lock it in `devDependencies`), add `npm run verify:fuses dist/win-unpacked/...` before upload, and make osv blocking after triage. | S |
| F-12 | Low | `src/main/update/verify.ts:195-203` | **No freshness in the signed manifest.** An attacker controlling the feed (GitHub account or release compromise without the offline keys) can offer an older signed release that is still newer than the installed one, or withhold updates (freeze). | Script: `checkManifestVersion(1.1.0, current 1.0.0)` is accepted even if 1.3.0 exists. | Add `expires` (or `notAfter`) and an optional `minimumVersion` to the signed manifest. Treat yanked versions via a signed revocation list. | M |
| F-13 | Low | `src/main/services/responses.ts:396` | **Response replay dedupe is exact-bytes only.** A re-saved copy of the same DC file imports again and duplicates vetting records for already-answered items. | Read (sha256 of file bytes). | Also dedupe on (batchId, resultsAsOf, row set hash) and warn when an item already has a response row. | S |
| F-14 | Low | `src/main/services/vetting-common.ts:150-175` | **Previews survive lock.** `PreviewStore` keeps file bytes and parsed PII in main memory for up to 30 min, and is not cleared on lock (gc only on `put`). Same for the `SqlCandidateSource` caches. Pre-integration (2.1). | Read. | Give lane H an `onLock` hook that clears preview stores and caches. | S |
| F-15 | Info | `src/main/net/NetGate.ts:75` | Allowlist checks hostname only. Any port on an allowlisted host is allowed (`https://github.com:8443` passes). | Script. | Also require `url.port === ''`. | S |
| F-16 | Info | `src/main/update/service.ts:324-333` | Re-hash then `quitAndInstall` leaves a small TOCTOU window for a same-user attacker on the updater cache. | Read. | Accept, or copy the verified installer to a fresh private temp file and launch that copy. | S |
| F-17 | Info | `src/main/services/vault-service.ts:344-346`; `src/main/db/migrate.ts:60` | `wipe` leaves `migration-backups/*.db`, earlier `.vssbak` files and the Chromium session dir. They are encrypted under the DEK, which is gone once `vault.json` is deleted, unless an old copy exists (F-03). | Read. | List them in the wipe dialog and delete the migration backups too. | S |
| F-18 | Info | `src/main/services/audit.ts:129-140` | Unkeyed hash chain. Anyone holding the DEK can rewrite the chain and `audit.head`. Fine for accidental damage; not evidence against the key holder. | Read. | Document. Optionally HMAC with a DEK-derived key and anchor the head in each backup. | S |
| F-19 | Info | `package.json:41` | `fast-xml-parser` is a runtime dependency but is never imported (the OOXML code is regex-based). Unneeded supply-chain surface. | `grep XMLParser src` finds no hits. | Remove it. | S |
| F-20 | Info | `node_modules/electron/index.js` | Importing `electron` under Node (tests) downloads the binary on first use, bypassing `ignore-scripts=true`. Seen during this review. | Observed "Downloading Electron binary..." when a test imported `NetGate`. | Document it in the setup notes, or set `ELECTRON_SKIP_BINARY_DOWNLOAD=1` in test runs that do not need the binary. | S |
| F-21 | Info | `tools/release/gen-keys.ts:45` | Seed files are plaintext JSON; `mode: 0o600` has no effect on Windows. | Read. | Encrypt seeds at rest (passphrase, Argon2id + XChaCha), or keep them only on an encrypted offline volume (runbook). | S |
| F-22 | Info | git history | Some commit messages carry tool co-author trailers. No secrets, internal paths or real data were found in tracked files (`git grep` for org domains, user paths, key headers and token patterns); authors use a GitHub noreply address. | `git log`. | Maintainer policy decision only. | S |

## 4. Verified safe (attacks that failed)

**Vault (`src/main/crypto`)**
- Label edit, KDF downgrade, or KDF swap in a slot gives `BAD_CREDENTIALS`, because the AAD binds the slot header.
- A `createdAt` edit or a flipped MAC gives `VAULT_TAMPERED`, but only after a correct unwrap, so it is not a password oracle.
- Out-of-bounds KDF, extra keys, `__proto__` injection and duplicate slots give `VAULT_CORRUPT`. Prototype pollution: none.
- Canonical-only base64 is enforced.
- Passwords are normalised to NFC: an NFD-typed password unlocks; an NFKC-compatible variant does not. Intended; document it.
- Concurrent unlocks are serialised per directory.

**Backup envelope:** bit flip, truncation, a length-field edit and a wrong passphrase all give `BACKUP_INVALID`. The header is in the AAD, and the final-chunk flag plus index stop reordering.

**Database:** the main file, the WAL and the `VACUUM INTO` copy contain no plaintext canary; the copy opens only with the DEK. Search SQL is parametrised, FTS terms are quoted and LIKE escapes are applied, so there is no injection.

**Update path:**
- Signatures from mixed slots (Ed25519 from `current`, ML-DSA from `next`) are rejected.
- Missing Ed25519 or ML-DSA signature: rejected.
- An ML-DSA signature with the rotation context presented as a manifest signature: rejected.
- A manifest signature replayed as a rotation statement: rejected.
- Non-canonical bytes with valid signatures: rejected.
- A key id that does not match its key material: rejected.
- Downgrade, same version and build-metadata-only bumps: rejected.
- Both algorithms are always evaluated. electron-updater traffic is confined to the guarded `electron-updater` partition.

**NetGate:** uppercase host is accepted; trailing dot, suffix tricks, `@`/`#` tricks, userinfo, http, IP literals, other subdomains and `wss` are all rejected.

**OOXML input:**
- DOCTYPE/entity ("billion laughs") is not expanded, because only the five predefined entities are decoded.
- Pathological unclosed `<row>`/`<c>` input parses in under 30 ms.
- Zip entries with lying size fields cannot inflate past the declared size.
- No zip-slip: archive names are never used as file-system paths.

**Electron shell:**
- Sandbox and contextIsolation are on; CSP is `default-src 'none'` with a script/style nonce.
- Navigation, `window.open`, webviews and permissions are denied.
- The IPC sender origin is checked, and every channel goes through zod `strictObject` request schemas.
- The mock API is excluded from production builds by `import.meta.env.DEV`.
- DevTools are disabled when packaged, the crash reporter is never started, and logs use an allowlist with no file sink.
- `openExternal` accepts only `mailto:`, and email headers are protected against CRLF injection.

**Export:** with the plain fixture, the `filter-original` export contains no field of the excluded person; shared-string scrubbing works.

**Matching / services:**
- Response commit enforces one-to-one per section.
- A decision that names an item outside the request is rejected.
- Previews are single-use and expire after 30 minutes.
- An identical response file is refused.
- No person is created from a response row without an explicit `new` decision.

## 5. Residual risks the maintainer must accept

- **Same-user malware** while unlocked can read everything (screen, memory, CDP if F-10 is not fixed). The vault protects data at rest only.
- **Offline brute force** of a copied `vault.json` is limited only by Argon2id. The 64 MiB / t = 1 floor allowed by auto-tune is weak on slow laptops, so a long passphrase is essential.
- **JS strings** (passwords from IPC, the `dbKeyHex()` pragma string) cannot be wiped and stay in the V8 heap until GC. SQLite3MC's in-memory key handling at close is not checked (VERIFY).
- **Windows crash dumps** (WER LocalDumps, if enabled by IT) can capture process memory with PII. The app cannot prevent this.
- **Clipboard history/cloud exclusion** depends on an Electron format syntax still marked VERIFY (`src/main/app/electron-ports.ts:13-18`). Auto-clear works regardless.
- **Backups and exports** are copies outside VSS's control: purge, wipe and password change do not reach them. `.eml` files and exports are plaintext by design.
- **Rollback** of the whole vault pair, and **freeze** of updates (F-12), cannot be detected without a trusted time or counter source.
- **Unsigned pilot builds:** SmartScreen "Run anyway" trains users to bypass warnings, and the first install has no integrity anchor beyond the GitHub download.

## 6. Prioritised fix list

1. **F-01** Make purge complete: reindex affected request/response blobs, FTS5 `secure-delete` + `optimize`, handle stored workbooks and exports, merged-alias cleanup, and an "every table + blob" test.
2. **F-04** Bind `vault.restore` / `vault.open` to `paths.dataDir`; open the DB with `mustExist` except on create; check the vaultId in `meta`.
3. **F-02** Replace raw renderer paths with dialog-issued opaque tokens (or at least per-channel extension allowlists).
4. **F-05** Allowlist the parts filter-original may keep; regenerate otherwise; add a no-leak property test.
5. **F-03** Rotate the DEK on password change (`rotateDek` + `rekey`) with startup recovery of `vault.json.next`.
6. **F-06** Remove POB country as a sole T1 anchor; demote sentinel DOBs; add more conflict evidence.
7. **F-10** Refuse remote-debugging switches in packaged builds.
8. **F-08 / F-09** Lower the KDF caps for files read from disk; add input and decompression size caps.
9. **F-07** Clamp `lastFailureAt` to now; document the counter as a throttle.
10. **F-11** Pin CI actions by SHA, run `verify:fuses` in the release job, isolate the SBOM step, make osv blocking.

Then F-12 (manifest expiry), F-13, F-14 (before lane H is wired), F-15, F-17 and F-19.
