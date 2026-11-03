# Security notes (v0.1 hardening)

How VSS handles the findings of the independent v0.1 security review (WP-23), what is left as accepted residual risk,
and what still has to be verified by hand. The reporting policy is in the root [SECURITY.md](../SECURITY.md).

## Fixed findings (regression tests under `tests/security/`)

| ID | Change | Test |
|---|---|---|
| F-01 | Purge also re-indexes the requests / responses that held the person, purges persons merged into it, drops merge aliases on survivors, deletes "not the same person" pairs, clears vetting-record notes and merge-log reasons naming the person, and scrubs every stored workbook that held the data (bytes and file name dropped, sha256 kept for re-import detection). FTS5 `secure-delete` is on for all search tables (migration 003); purge optimises the indexes and checkpoints the WAL. | `purge-complete.test.ts` |
| F-02 | `files.pickOpen` / `files.pickSave` return opaque tokens bound to path, file kind and mode; every file handler resolves them in main and refuses raw paths. Save / folder tokens are single-use, open tokens read-only until lock or 30 min, extension must match the kind, no directories are created. | `path-tokens.test.ts` |
| F-03 | A password change rotates the DEK and re-keys the database (`PRAGMA rekey`), crash-safe: `vault.json.rotation` + `vault.json.next` are fsynced first; the next unlock completes or rolls back with the old or the new password. | `password-rotation.test.ts` |
| F-04 | The vault is bound to the app data folder; the DB opens only if it exists (except on create) and carries the header's vault id (`meta vault.id`); an empty, missing or foreign DB is refused. | `vault-binding.test.ts` |
| F-06 | Birth country is no longer a cross-request anchor (needs ID equality, or unit equality plus POB city/state agreement); placeholder DOBs never auto-link; father's-name and POB place conflicts block T1. Rules: `docs/PLAN.md`, Identity integrity. | `matcher-namesakes.test.ts`, matcher property tests |
| F-07 | Stored lockout timestamps are clamped to now (and written back), so the wait never exceeds 15 min. | `lockout-clamp.test.ts` |
| F-08 | Argon2id parameters read from files: m <= 512 MiB, t <= 8, m x t <= 2 GiB-passes; all slots of a header together <= twice that. Refused before any derivation. | `resource-caps.test.ts` |
| F-09 | `.xlsx` input <= 20 MiB (checked before reading), one inflated part <= 64 MiB, package <= 256 MiB, inflated size must equal the declared size; backups > 4 GiB refused before any derivation. | `resource-caps.test.ts` |
| F-10 | Packaged builds exit at once when started with remote-debugging / inspector / js-flags switches (parsed command line and argv). | `debug-guard.test.ts`, `tests/e2e/packaged.test.ts` |
| F-11 | All workflow actions pinned by commit SHA, no persisted checkout credentials, blocking osv-scanner with `.github/osv-scanner.toml`, fuse check in the release job, SBOM in a separate read-only job. | `ci-hygiene.test.ts` |
| F-12 | Signed manifests carry `notBefore` / `notAfter` (at most 180 days); the app refuses a manifest outside the window. Re-signing: `docs/RELEASE-RUNBOOK.md`. | `manifest-freshness.test.ts` |
| F-13 | A re-saved copy of an imported DC response is recognised by a content fingerprint (batch, date, folded rows) and the preview warns; rows whose item already has a DC answer are flagged. | `response-resave.test.ts` |
| F-14 | Import previews and the domain service caches are dropped on every lock. | `previews-on-lock.test.ts` |
| F-15 | NetGate refuses non-default ports on allowlisted hosts. | `netgate-port.test.ts` |
| F-17 | Wipe also deletes the encrypted pre-migration copies. | `wipe-leftovers.test.ts` |
| F-19 | `fast-xml-parser` is only used by the CI OOXML validator; moved to devDependencies (not shipped). | (package.json) |

Also closed with this work (lane J gaps, `backup-generations.test.ts`): two backups within one second get distinct file
names; regenerating the recovery passphrase keeps up to 20 earlier passphrases inside the encrypted DB and writes
`vss-backup-keyring.vsskeys` next to the backups (earlier passphrases sealed under the current one), so the newest
passphrase restores every backup in that folder. Without the keyring file an old backup needs its own passphrase.

F-05 (`filter-original` export keeping unknown package parts) is handled in the exporter work package, not here.

## Accepted residual risks

- **Purge and copies outside VSS.** Backups made before a purge, exported workbooks and `.eml` files written to disk,
  and copies on OneDrive or e-mail still hold the purged data. Purging also scrubs the stored original workbook of
  every affected request, so `filter-original` export falls back to `regenerate` for those requests.
- **Lockout counter (F-07).** It lives outside the header MAC and is a UX throttle only. Offline guessing against a
  copied `vault.json` is limited by Argon2id and the password policy (minimum 12 characters); a long passphrase is
  essential, especially when auto-tune picked the 64 MiB floor on a slow laptop.
- **Old vault copies (F-03).** After a password change an old `vault.json` no longer opens the live database, but an old
  backup (header + database of that time) still opens with the password it was made under.
- **Update freeze (F-12).** A feed that withholds every newer release is not detected; the validity window only stops
  replaying an old signed release indefinitely. Rollback of the whole vault pair (`vault.json` + `vss.db`) cannot be
  detected without a trusted counter.
- **F-16, installer TOCTOU.** Between the re-hash of the verified installer and `quitAndInstall`, a same-user process
  could swap the file in the updater cache. Same-user malware is out of scope while unlocked.
- **F-18, audit chain.** The hash chain is unkeyed: whoever holds the DEK can rewrite the chain and its head. It
  detects accidental damage and naive edits, not tampering by the key holder.
- **F-20, Electron binary in tests.** Importing `electron` under plain Node downloads the Electron binary on first use,
  bypassing `ignore-scripts=true`. Run `npm run setup` once after `npm ci` (it does the same download explicitly);
  unit tests that need `electron` mock it.
- **F-21, release signing seeds.** `tools/release/gen-keys.ts` writes the seed files as plaintext JSON (`mode 0o600`
  has no effect on Windows). Keep them only on an encrypted offline volume (BitLocker To Go or equivalent), as the
  release runbook prescribes.
- **F-22, commit trailers.** Some historical commit messages carry tool co-author trailers. Maintainer policy; no
  secrets or internal paths were found in tracked files.
- **Same-user malware while unlocked, process memory.** JS strings (passwords from IPC, the key pragma string) cannot
  be wiped; Windows crash dumps (if enabled by IT) can capture process memory. The vault protects data at rest.

## VERIFY (manual)

- F-10 on a signed release build: start the installed exe with `--remote-debugging-port=9222` and with
  `--remote-debugging-pipe`; it must exit at once and nothing must answer on the port. Verified 2026-11-03 on a local
  unsigned `electron-builder --dir` build (`tests/e2e/packaged.test.ts`, 5/5); repeat on the signed installer. Chromium
  may open the DevTools endpoint before the main script runs, so a very short window may remain; check that no
  connection can be made in practice.
- Packaged in-app journey: since F-10 the packaged build can no longer be driven over CDP. Smoke-test by hand on each
  release: create a vault, import a synthetic request, export it, check the dashboard (native module from
  `app.asar.unpacked`, exporter template from the asar).
- F-03: atomicity of `PRAGMA rekey` under a power cut in WAL mode (VSS does not rely on it, see `docs/NOTES-sqlite.md`).
- F-11: the first CI run with the blocking osv-scanner; triage anything it reports beyond the allowlist.
