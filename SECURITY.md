# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's "Report a vulnerability" feature on this repository
(Security tab, private advisories). Do not open a public issue for a security problem and do not attach real personal data.

A dedicated contact address and response targets will be published here before the first stable release (placeholder).

## Scope

- The VSS desktop application, its installer and update mechanism.
- Cryptographic handling of the vault (key derivation, key slots, database encryption, backups).

## Supported versions

Only the latest release receives security fixes.

## Design notes

- The application makes no network connections except an optional update check, which is verified with an independent
  signed manifest and can be disabled.
- No telemetry and no crash reporting.
- The renderer is sandboxed with a strict Content Security Policy and talks to the main process only through a typed,
  allowlisted IPC bridge.
