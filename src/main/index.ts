import { join } from 'node:path';
import { app, BrowserWindow, powerMonitor } from 'electron';
import { composeApp } from './app/compose';
import type { ComposedApp } from './app/compose';
import { createElectronPorts } from './app/electron-ports';
import { createLogger } from './app/logger';
import { resolveAppPaths } from './app/paths';
import { DEBUG_REFUSED_MESSAGE, findDebugSwitch } from './bootstrap/debug-guard';
import { installSecurity, registerAppScheme } from './bootstrap/security';
import { createMainWindow } from './bootstrap/window';
import { registerIpc } from './ipc/registry';
import { createRealUpdateService } from './services/updates-wiring';

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

// --- process hygiene (all before 'ready') ---------------------------------------------------------------------------
// No telemetry: crashReporter is never started, Chromium's own breakpad/crashpad uploader is switched off, and the
// crash-dump folder (never written without a started reporter) is pinned inside our own profile folder.
app.commandLine.appendSwitch('disable-breakpad');
app.enableSandbox();
app.setAppUserModelId(APP_USER_MODEL_ID);

const paths = resolveAppPaths(process.env, app.getPath('appData'));
// Keep the Chromium profile (cache, storage) next to the vault, not in %APPDATA%. Must precede the instance lock.
app.setPath('userData', paths.sessionDir);
app.setPath('crashDumps', join(paths.sessionDir, 'crash-dumps-unused'));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;
  let composed: ComposedApp | null = null;
  let quitting = false;

  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
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
    composed = await composeApp({ paths, ports, updates: createRealUpdateService, logger: log });
    registerIpc(composed.handlers);
    // OS shutdown / logoff: lock synchronously, nothing else can be relied on.
    powerMonitor.on('shutdown', () => composed?.vault.forceLock());
    const route = await composed.initialRoute();
    mainWindow = createMainWindow(route);
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
    log.info('app.ready', { version: app.getVersion(), state: route });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow('lock');
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
