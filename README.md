# Vetting Support System (VSS)

VSS is an offline, encrypted desktop tracker for vetting requests and the responses to them. It runs per user on Windows
with no administrator rights, keeps everything in a single encrypted vault on the local disk, and never needs a network
connection (an optional, user-toggleable update check is the only network feature and can be turned off).

Status: early development (scaffold and contracts). All fixtures and examples in this repository are synthetic.

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
npm run dist       # NSIS installer (per user) and portable exe in dist/
```

Install scripts are disabled (`ignore-scripts=true`). The only script that must run is the Electron binary download,
which `npm run setup` performs. See `docs/PLAN.md` for the architecture and `docs/FILE-FORMATS.md` for the file rules.

## Security

See [SECURITY.md](SECURITY.md). Do not commit real personal data; use the synthetic generator in `fixtures/`.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
