import { join } from 'node:path';
import { app, BrowserWindow, dialog, powerMonitor, screen } from 'electron';
import { composeApp } from './app/compose';
import type { ComposedApp } from './app/compose';
import { createElectronPorts, dialogGate } from './app/electron-ports';
import { createLogger } from './app/logger';
import { resolveAppPaths } from './app/paths';
import { installCrashGuard } from './bootstrap/crash-guard';
import { createWindowStateKeeper, WINDOW_STATE_FILE } from './app/window-state';
import { DEBUG_REFUSED_MESSAGE, findDebugSwitch } from './bootstrap/debug-guard';
import { checkedProfilePath } from './bootstrap/profile-path';
import { installSecurity, registerAppScheme } from './bootstrap/security';
import { createMainWindow } from './bootstrap/window';
import { registerIpc } from './ipc/registry';
import { createRealUpdateService } from './services/updates-wiring';
import { vaultExists } from './crypto/vault';
import { isDemoSeedAllowed, seedDemo } from '../../tools/demo/seed';

// F-10: a packaged build never runs with a remote-debugging / inspector channel (CDP would expose the unlocked
// renderer and window.vss to any same-user process). Checked first, before anything is opened.
// No modal dialog here: it would keep the process (and a DevTools endpoint Chromium may already have opened) alive
// until someone clicks OK. The message goes to stderr and the process exits at once.
if (app.isPackaged && findDebugSwitch(process.argv, (s) => app.commandLine.hasSwitch(s)) !== null) {
  try {
    process.stderr.write(`${DEBUG_REFUSED_MESSAGE}\n`);
  } catch {
    // no console attached
  }
  app.exit(1);
  process.exit(1);
}

// Must run before 'ready'.
registerAppScheme();

const APP_USER_MODEL_ID = 'org.unodc.cyber.vss';
const log = createLogger({ level: app.isPackaged ? 'info' : 'debug' });

let mainWindow: BrowserWindow | null = null;
let composed: ComposedApp | null = null;

// Lane J (R10): registered before anything else can throw, so Electron's raw main-process error box never shows.
const crashGuard = installCrashGuard({
  onProcess: (event, fn) => void process.on(event, fn),
  onChildGone: (fn) => void app.on('child-process-gone', (_e, details) => fn(details)),
  log,
  isReady: () => app.isReady(),
  lock: () => composed?.lock.lock('error'),
  async showDialog(text) {
    const win = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? mainWindow : null;
    const opts = {
      type: 'error' as const,
      title: text.title,
      message: text.message,
      detail: text.detail,
      buttons: [text.continue, text.quit],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    return r.response === 1 ? 'quit' : 'continue';
  },
  showStartupError: (text) => dialog.showErrorBox(text.title, `${text.startup}\n\n${text.startupDetail}`),
  quit: () => app.quit(),
  exit: (code) => app.exit(code),
});

// --- process hygiene (all before 'ready') ---------------------------------------------------------------------------
// No telemetry: crashReporter is never started, Chromium's own breakpad/crashpad uploader is switched off, and the
// crash-dump folder (never written without a started reporter) is pinned inside our own profile folder.
app.commandLine.appendSwitch('disable-breakpad');
app.enableSandbox();
app.setAppUserModelId(APP_USER_MODEL_ID);

const paths = resolveAppPaths(process.env, app.getPath('appData'));
// Keep the Chromium profile (cache, storage) next to the vault, not in %APPDATA%. Must precede the instance lock.
// Lane J: the owner's "conversion failure" at this call is turned into a coded startup fault with a friendly box.
try {
  const sessionDir = checkedProfilePath(paths.sessionDir);
  app.setPath('userData', sessionDir);
  app.setPath('crashDumps', checkedProfilePath(join(sessionDir, 'crash-dumps-unused')));
} catch (e) {
  crashGuard.fatalStartup('paths', e);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let quitting = false;
  // R16: remember the window's size/position (plain file in the session folder, never in the vault).
  const windowState = createWindowStateKeeper({
    file: join(paths.sessionDir, WINDOW_STATE_FILE),
    defaults: { width: 1280, height: 800 },
    min: { width: 960, height: 600 },
    displays: () => ({
      displays: screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, workArea: d.workArea })),
      primaryId: screen.getPrimaryDisplay().id,
    }),
  });

  app.on('second-instance', () => {
    // Never restore / refocus the window under an open modal dialog (lane J, hypothesis f): the dialog keeps focus.
    if (dialogGate.isOpen) return;
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // Extra per-webContents guards on top of installSecurity() (navigation, window.open, permissions live there).
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-attach-webview', (event) => event.preventDefault());
    wc.on('render-process-gone', (_ev, details) => {
      log.error('renderer.gone', { reason: details.reason });
      // A dead renderer must not leave the vault open behind a blank window.
      void composed?.lock.lock('error');
    });
    if (app.isPackaged) wc.on('devtools-opened', () => wc.closeDevTools());
  });

  void app.whenReady().then(async () => {
    installSecurity();
    const ports = createElectronPorts(() => mainWindow);
    composed = await composeApp({
      paths,
      ports,
      updates: createRealUpdateService,
      logger: log,
      appInfo: { version: app.getVersion() },
      resetWindowState: () => windowState.reset(),
    });
    registerIpc(composed.handlers);
    // Demo seeder (lane H, tools/demo/seed.ts): dev / alpha builds only, never over an existing vault.
    const seedPassword = isDemoSeedAllowed({
      env: process.env,
      isPackaged: app.isPackaged,
      vaultExists: vaultExists(paths.dataDir),
    });
    if (seedPassword) {
      try {
        await seedDemo({
          handlers: composed.handlers,
          grants: composed.grants,
          password: seedPassword,
          fixturesDir: join(app.getAppPath(), 'fixtures', 'demo'),
          tempDir: join(app.getPath('temp'), 'vss-demo-seed'),
          log: (m) => log.info('demo.seed', { step: m }),
        });
      } catch (e) {
        log.error('demo.seed.failed', { message: e instanceof Error ? e.message : 'unknown' });
        await composed.shutdown({ backup: false }).catch(() => undefined);
      }
    }
    // OS shutdown / logoff: lock synchronously, nothing else can be relied on.
    powerMonitor.on('shutdown', () => composed?.vault.forceLock());
    const route = await composed.initialRoute();
    mainWindow = createMainWindow(route, windowState.initial());
    windowState.attach(mainWindow);
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
    log.info('app.ready', { version: app.getVersion(), state: route });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow('lock', windowState.initial());
        windowState.attach(mainWindow);
      }
    });
  });

  // Graceful shutdown: lock first (closes the DB, disposes keys, clears the clipboard), then really quit.
  app.on('before-quit', (event) => {
    if (quitting || !composed) return;
    quitting = true;
    event.preventDefault();
    void composed.shutdown().finally(() => app.quit());
  });

  app.on('window-all-closed', () => app.quit());
}
