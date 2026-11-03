# Changelog

All notable changes are documented here. The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
