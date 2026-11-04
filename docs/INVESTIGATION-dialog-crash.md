# Investigation: native crash after the file dialog, and the main-process TypeError (lane J, R10)

Date: 2026-11-04. Build under test: 0.1.0 (Electron 45.2.1), packaged with `electron-builder --win --dir`, source maps
generated locally (`electron-vite build --sourcemap`) and excluded from the package (`'!**/*.map'`). No paths, names
or personal data are recorded here; every file used was a synthetic fixture.

## Symptoms reported

1. Windows event 1000 / WER `BEX64`: faulting module `explorerframe.dll_unloaded`, exception `c0000005`, fault offset
   `0x434ce`, P9 (exception parameter) `8`, right after the request-import file dialog; the app closed while the
   import summary page was showing.
2. A main-process error box: `TypeError: Error processing argument at index 1, conversion failure` at
   `out/main/index.js:15639:5`.

## Findings

### The TypeError (2)

- The owner's packaged `app.asar` was extracted read-only: line 15639 of `out/main/index.js` is
  `app.setPath("userData", paths.sessionDir);` (column 5 = `setPath`). The local source-mapped build of the same
  commit maps it to `src/main/index.ts` line 43, the same call. So this was a **startup** failure (the process stops
  before any window exists), not a dialog call; it is a separate event from (1).
- Probe of Electron 45.2.1 `app.setPath(name, value)`:

  | value | result |
  |---|---|
  | absolute string (also long, UNC `\\?\`, reserved chars, missing drive, parent is a file) | accepted |
  | relative string | `Path must be absolute` |
  | `undefined` | `conversion failure from undefined` |
  | string containing NUL | `conversion failure from <text up to the NUL>` |
  | number, `{}`, `new String(...)`, `URL` | `conversion failure from ` (nothing after "from") |

  The reported text ends right after "conversion failure", which matches a non-string value (or a string starting
  with NUL). `resolveAppPaths` always returns a string from `path.join`, so no code path in 0.1.0 produces such a
  value from a normal environment; **not reproduced**. VERIFY with the owner: the exact text after "from", how the
  app was started (shortcut, installer "run after finish", portable exe, a script setting `VSS_DATA_DIR`).
- Mitigation shipped: `bootstrap/profile-path.ts` validates the value first (string, absolute, no NUL); a failure is
  logged as `app.fault {kind, code: PROFILE_PATH_INVALID, phase: paths}` and shows a friendly error box instead of
  Electron's raw one. Any other startup exception goes the same way through the crash guard.

### The native crash (1)

- `BEX64` with parameter 8 is a DEP **execute** fault: a thread jumped into code of `explorerframe.dll` after the
  DLL had been unloaded. explorerframe hosts the Explorer browser inside the common file dialog. Chromium runs each
  Windows file dialog on its own short-lived COM thread; when a dialog ends, COM may unload the shell DLLs while a
  shell worker or a queued callback of the dialog still points into them. That is a Windows shell / shell-extension
  race inside the process, not JavaScript; the app cannot catch it.
- Reproduction with the real dialog (`tools/e2e-native/drive-import.ps1`, UI Automation + Win32 messages, packaged
  build, about 170 dialog cycles in batches): accept, cancel, browse (navigate folders inside the dialog), a
  cloud-synced folder shown in the dialog, double click, bursts of four clicks, owner window minimised while the
  dialog was open, idle auto-lock (1 min) firing while the dialog was open.

  | scenario | cycles | Application Error events | observation |
  |---|---|---|---|
  | accept / cancel / browse / cloud folder | ~90 | 0 | - |
  | double click on "Choose file" | ~20 | 0 | **a second dialog opened right after the first returned, over the import summary page** |
  | burst of 4 clicks | ~50 | 0 | **up to 4 dialogs in a row**; with fast answers some stayed queued |
  | minimise while open | ~10 | 0 | dialog hidden with its owner; stays open invisibly |
  | idle lock during dialog | 2 | 0 | **vault locked and the renderer was reloaded while the modal dialog was open** |

  The crash itself was **not reproduced** on this machine (the shell DLL set, folder contents and shell extensions
  differ from the owner's session). The plan's hypotheses: (a) confirmed (lock/navigation under an open dialog);
  (b) confirmed (concurrent/queued dialogs from a double click: back-to-back dialog thread teardown and start-up is
  the most likely trigger of the unload race, and it lands exactly on the summary page); (c) not the cause of (2) as
  far as dialogs go (options never contained `undefined` members for open dialogs) but hardened; (d) not observed;
  (e) dialog stays open hidden, no crash seen; (f) possible in code (second-instance focus under a modal dialog),
  not exercised.

## Fixes (all paths return `Result` errors instead of throwing)

- `app/dialog-gate.ts` + `electron-ports.ts`: one native dialog at a time for the whole process (a second call
  answers "cancelled" and never shows a dialog); parent only on a live, visible, non-minimised window; options built
  without `undefined` members or empty filters; `navigate()` (lock-screen reload) waits until the dialog has
  returned; `emit` / `navigate` skip destroyed `webContents`.
- `services/lock.ts` `holdWhile(p)`: an open dialog defers the idle lock up to 10 min (answering the dialog counts
  as activity); after the cap the vault locks anyway (DB closed, keys gone) and only the reload waits for the
  dialog. Suspend / screen lock / manual / error locks are never deferred.
- `services/files.ts`: dialog exceptions become `INTERNAL` Results with a PII-free `dialog.failed {kind}` log; a lock
  during the dialog discards the choice (no path token is issued after the lock).
- Renderer: `useBusyAction()` (`lib/api.ts`); the import "Choose file" button shows `loading` while a pick is
  pending. Other pick buttons (response import, templates, backup folder, restore) belong to other lanes and should
  adopt it; the main-process gate already covers them.
- `bootstrap/crash-guard.ts` (registered first in `main/index.ts`): `uncaughtException`, `unhandledRejection`,
  `child-process-gone` (crashes only) log `app.fault {kind, code, phase, at}` (class name or UPPER_CASE code; `at` =
  top three stack locations as file base name:line:col, mappable with the local source maps; never the message), lock the vault, show "Something went wrong; the vault was locked..." with Continue / Quit; a second
  fault within 5 s quits; before ready a plain friendly box and exit. `app:crash-recovered` is emitted once lane A0
  adds the event (`emitRecovered` hook, not wired yet).
- `second-instance` no longer restores / focuses the window while a dialog is open.

## Residual risk and further mitigation

A pure shell-side unload race can still happen on a single, well-behaved dialog. If the owner still sees the
`explorerframe.dll_unloaded` event after this build:
1. Capture a local dump (no upload): `HKCU\Software\Microsoft\Windows\Windows Error Reporting\LocalDumps\Vetting
   Support System.exe` with `DumpType=2`, `DumpFolder` set to a local folder; open it in WinDbg (`!analyze -v`,
   `lm` for loaded shell extensions). The dump contains vault memory: keep it local and delete it after analysis.
2. Check shell extensions with ShellExView / Autoruns (Explorer tab), especially cloud-sync and archive tools.
3. Try the next Electron 45 patch release (Chromium dialog-thread fixes land there); the pinned version is
   45.2.1.
4. Out-of-process dialogs (a separate helper process for the dialog) would isolate the crash; not done here because
   it needs a second signed executable or re-enabling `runAsNode`, which the fuse hardening forbids.

## How to rerun

```
node tools/e2e-native/seed-vault.mjs <tempDir>\vault 15        # synthetic vault via the dev build
pwsh -File tools/e2e-native/drive-import.ps1 -Exe 'dist\win-unpacked\Vetting Support System.exe' `
  -DataDir <tempDir>\vault -Fixture fixtures\requests\req-001-basic.xlsx -Iterations 10 -Modes accept,double,burst,cancel
```

The driver sends no keystrokes, closes every dialog of its own process after each cycle (and verifies it is gone),
has a hard timeout plus an out-of-process watchdog, and stops only the process tree it started.
