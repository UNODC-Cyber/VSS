# Changelog

All notable changes are documented here. The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0-alpha.1] - not yet released

Unsigned alpha pre-release for testing with synthetic data. Automatic updates are disabled in this build.
See [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md).

### Added

- Release channels: a build-time channel (`dev`, `alpha`, `release`); prerelease versions build only as `alpha`.
  `npm run dist:alpha`, `tools/verify-channel.mjs`.
- Alpha banner, Help menu with About (version, schema, channel, licence note) and **Send feedback** (opens a fixed
  GitHub issue-form URL carrying only version, OS version and architecture); issue template with a required
  no-personal-data checkbox.
- Requestor entity with type-ahead; request lifecycle (Finished is derived, Closed is gated, Reopen with a reason) and
  dashboard screen links; configurable e-mail templates and vetting-authority contacts; wizard Back/Cancel and a friendly
  wrong-file state; structure-based parser for DC response workbooks with mixed-script names; review queue with person
  picker, manual validation and edit in place; Settings danger zone (Delete database); window size and position memory.
- UI: table layout engine, icon copy buttons, local fonts and icons, density setting, dark-theme contrast fixes.
- Demo seeder (`VSS_DEMO_SEED`, development and alpha builds only, never over an existing vault) and the screenshot audit
  harness (`npm run ui-audit`).

### Changed

- Identity decisions need an explicit compare step; safer defaults in the import wizards and the "Responded by email"
  flow; clearer wording and empty states.
- The release workflow for prerelease tags builds with channel `alpha`, publishes `SHA256SUMS` and `SHA512SUMS`, never
  uploads `latest.yml` or blockmaps, and creates a draft prerelease.
- Release runbook: new section "Alpha pre-releases"; the code-signing programme checklist was removed (unsigned until an
  organisational code-signing certificate is available).

### Fixed

- Start-up and file-dialog robustness (crash guard, one native dialog at a time, idle lock held while a dialog is open,
  validated profile path). The native dialog crash seen on 0.1.0 was not reproduced and may still occur.

### Changed

- The app no longer bundles any INVESTc template. Regenerate-mode exports use a template kept in the encrypted vault:
  captured automatically (sanitised, rows removed) from the first valid request import, or imported in
  Settings > Templates (history kept). Without one, such exports fail with an actionable message.
- Test fixtures are written from scratch by `tools/fixtures/investc-workbook.ts`; the third-party blank workbook and
  everything derived from it were removed.

### Security

- F-05: filter-original exports keep only a whitelist of package parts (custom XML, comments, document properties,
  defined names and other carriers of other people's data are dropped; unknown parts force regeneration from the
  vault template). Schema v3 adds the `template` table (additive migration).

## [0.1.0] - 2026-11-03

### Added

- Project scaffold: Electron, TypeScript (strict), React, Vite (electron-vite), Mantine, Vitest, Playwright smoke test.
- Hardened shell: sandboxed renderer, context isolation, `vss://app` scheme with strict CSP, permission and navigation denial,
  `NetGate` as the single network entry point, Electron fuses configured in the build.
- Typed IPC contract (`VssApi`), zod schemas for every payload, channel allowlist, status derivation and rule registry.
- Packaging: per-user NSIS installer and portable build.
