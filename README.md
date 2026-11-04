# Vetting Support System (VSS)

VSS is an offline, encrypted desktop tracker for vetting requests and the responses to them. It runs per user on Windows
with no administrator rights, keeps everything in a single encrypted vault on the local disk, and never needs a network
connection (an optional, user-toggleable update check is the only network feature and can be turned off).

Status: **alpha** (0.2.0-alpha.1) for testing with synthetic data only; see "Alpha testing" and [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md). All fixtures and examples in this repository are synthetic.

## Features (planned)

- Import request workbooks, validate them, and keep a history of every person and unit seen.
- Export de-duplicated request workbooks that skip people who are already cleared.
- Import response workbooks and match rows to people conservatively: anything inexact is flagged for review, never guessed.
- Track outstanding requests, expiries and turnaround times; draft emails locally.
- Encrypted vault: Argon2id-derived key slots, whole-database ChaCha20 encryption, auto-lock, clipboard auto-clear.
- No telemetry, no crash reporting.

## Development

Requirements: Node.js 22.12 or newer (24 recommended), npm 10+, Windows 10/11.

```powershell
npm ci
npm run setup      # downloads the Electron binary (install scripts are disabled in .npmrc)
npm run dev        # run the app with hot reload
npm run typecheck
npm run lint
npm test           # unit, property, golden and security tests
npm run build
npm run test:e2e   # Playwright smoke test against the built app
npm run dist       # release-channel NSIS installer (per user) and portable exe in dist/ (stable versions only)
npm run dist:alpha # the same for an alpha pre-release version (channel alpha: updater off, banner on)
```

Install scripts are disabled (`ignore-scripts=true`). The only script that must run is the Electron binary download,
which `npm run setup` performs. See `docs/PLAN.md` for the architecture and `docs/FILE-FORMATS.md` for the file rules.

## Alpha testing

The alpha is an **unsigned** pre-release for people who agreed to test it. **Use synthetic or test data only: never real
names, dates of birth, case files or real responses.** Read [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md) first.

1. **Download** the installer (`vss-0.2.0-alpha.1-x64-setup.exe`) or the portable exe from the project's GitHub
   Releases page only, together with `SHA256SUMS`.
2. **Verify** the file. In PowerShell, in the download folder:
   `Get-FileHash .\vss-0.2.0-alpha.1-x64-setup.exe -Algorithm SHA256` and compare the hash with the line for that file in
   `SHA256SUMS` (a `SHA512SUMS` file is there too). If they differ, do not run it.
3. **Install.** Windows shows "Windows protected your PC" because the build is unsigned: click **More info**, check
   the file name, then **Run anyway**. If the browser blocks the download, choose **Keep** (Edge: "..." > **Keep** >
   **Show more** > **Keep anyway**). The installer needs no administrator rights and installs per user.
4. **Use** it with the synthetic example files from `fixtures/` or your own made-up test data. A yellow strip shows
   "Alpha build ..." at the top of the screen while the alpha is running. There are no automatic updates: install each
   new alpha by hand.
5. **Send feedback** with **Help > Send feedback** (or the link in the yellow strip). It opens a pre-filled GitHub issue
   form in your browser with only the app version, Windows version and processor type. Never paste names, dates of birth
   or file content into it; screenshots must show synthetic data only.
6. **Wipe** when you are done: **Settings > Danger zone > Delete database** removes the vault and its copies (files you
   exported yourself stay, delete them by hand). Then uninstall from Windows Settings > Apps.

## Security

See [SECURITY.md](SECURITY.md). Do not commit real personal data; use the synthetic generator in `fixtures/`.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
