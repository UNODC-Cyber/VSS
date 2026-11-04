# Known limitations (0.2.0-alpha.1)

This is an **alpha** build for testing with **synthetic or test data only**. Read this page before you install it.
It lists what does not work, what is deliberately switched off and which risks are accepted. Nothing here is hidden
elsewhere: if you find something that is not listed, please report it (README, "Alpha testing").

## The build itself

- **Unsigned.** The installer and the portable exe carry no Authenticode signature. No organisational code-signing
  certificate is available to this project yet, so Windows SmartScreen shows "Windows protected your PC" and your browser
  may warn about the download. Follow the first-run steps in the README and verify the SHA-256 checksum first. The build
  will stay unsigned until an organisational code-signing certificate is available.
- **Automatic updates do not work, by design.** Alpha builds contain a stand-in that never touches the network: no update
  check, no download, no install, and the "check for updates" setting is hidden. The release signing keys embedded in the
  app (`src/main/update/keys.ts`) are still **placeholders** whose private halves were destroyed, so even a stable build
  could not accept an update until the key ceremony in `docs/RELEASE-RUNBOOK.md` has been done. Install each new alpha by
  hand. The alpha release carries no `latest.yml` and no blockmap, so no installed app can ever offer it as an update.

## Features that are off or not there

- **FIDO2 / hardware key: deferred.** The vault is protected by a password only (Argon2id). The vault header already has a
  versioned slot list so a hardware-key slot can be added later; nothing of it is implemented or shown.
- **LAN peer mode: off.** It is experimental, not implemented in this build, and every `peer.*` call answers "not
  supported". The "Peer mode active" indicator can never turn on.
- **No telemetry and no crash reporting.** If the app crashes you must report it yourself (see "Crash investigation").
- **English only.**
- **Windows only** (Windows 10 or 11, x64). No macOS or Linux builds.

## Verification gaps

- **The packaged in-app journey is manual.** Since security fix F-10 a packaged build exits at once when started with a
  remote-debugging or inspector switch, so the automated end-to-end tests cannot drive the installed app. They drive the
  built (unpackaged) app and a mock-backed copy of the interface instead. Before each release the maintainer walks through
  the packaged app by hand: create a vault, import a synthetic request, export it, import a synthetic response, close the
  request, lock and unlock. The packaged-build automation only checks the fuses, the debug-switch refusal and start-up.
- **F-10 on a signed build** has not been re-verified (there is no signed build).
- **F-03:** atomicity of the database re-key under a power cut in WAL mode is not verified (VSS does not rely on it).
- **F-11:** the first CI run with the blocking dependency scan may report findings that need triage.

## Crash investigation (open)

Two failures were reported on the 0.1.0 build:

1. A start-up error box, `TypeError: Error processing argument at index 1, conversion failure`, from setting the profile
   path. It was **not reproduced**. This build validates the path first (string, absolute, no NUL) and shows a friendly
   message instead of the raw error. If you still see it, report the exact text after "conversion failure from" and how
   you started the app.
2. A Windows native crash (`explorerframe.dll_unloaded`, access violation) shortly after the file dialog closed. It was
   **not reproduced** either, in about 170 dialog cycles on a development machine. The most likely cause is a Windows
   shell race inside the common file dialog, outside VSS's control. This build removes the conditions that made it likelier
   (a second dialog opening right after the first returned, the idle lock firing while a dialog was open) and adds a
   crash guard that locks the vault and shows a short message. The dialog crash can still happen. If it does, the vault
   is safe on disk and unlocks normally; please report it with the Windows event text and, if you can, the steps. Details:
   `docs/INVESTIGATION-dialog-crash.md`.

## Accepted residual risks

These come from the security review (`docs/SECURITY.md` has the full list and the tests that cover the fixed findings).

- **Purge and copies outside VSS.** Backups made before a purge, exported workbooks and `.eml` files written to disk and
  copies in cloud folders or e-mail still hold the purged data.
- **Lockout counter (F-07).** It is a UX throttle only. Offline guessing against a copied vault file is limited by Argon2id
  and the 12-character password minimum. Use a long passphrase.
- **Old vault copies (F-03).** After a password change, an old backup still opens with the password it was made under.
- **Update freeze and vault rollback (F-12).** A feed that withholds every newer release is not detected, and rolling back
  the whole vault file pair to an older copy cannot be detected without a trusted counter.
- **Installer swap (F-16).** Between the final hash check and the hand-over to the installer, same-user malware could swap
  the file. Same-user malware while the vault is unlocked is out of scope.
- **Audit chain (F-18).** The hash chain is unkeyed; whoever holds the vault key can rewrite it. It detects accidents and
  naive edits, not tampering by the key holder.
- **Electron binary download (F-20)** and **plaintext release-signing seeds (F-21)** affect developers and the maintainer,
  not testers.
- **Process memory.** Passwords handled in JavaScript cannot be wiped from memory, and Windows crash dumps (if your IT
  enables them) can capture it. The vault protects data at rest, not a compromised, unlocked computer.

## Interface items still open (P3, polish)

An automated screenshot audit (`npm run ui-audit`, rubric in `docs/ui-audit/RUBRIC.md`) has been run and one fix round
applied (table fit on small windows, dark-theme contrast, badge colours in the person picker). The audit's detailed
findings are working notes and are **not committed**, and the last round has not been re-audited end to end, so treat the
list below as the kinds of polish issues to expect rather than a complete inventory. None is known to block use.

- Spacing and alignment between cards, and badge colours between tables, may still differ slightly from screen to screen.
- On narrow windows tables drop low-priority columns automatically and scroll sideways for the rest; the scroll cue is
  subtle.
- Wording is functional rather than final; some help texts are long.
- Dark theme and 150 % display scaling have had less checking than light theme at 100 %.

Tell us what you notice (Help > Send feedback).
