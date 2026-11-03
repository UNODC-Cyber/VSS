import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { APP_ORIGIN, devRendererUrl } from './security';

const here = dirname(fileURLToPath(import.meta.url));

/** `route` becomes the hash of the first load (`#/create`, `#/unlock`, `#/lock`). */
export function createMainWindow(route?: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Vetting Support System',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      spellcheck: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      devTools: !app.isPackaged,
    },
  });
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => win.show());
  void win.loadURL(`${devRendererUrl() ?? `${APP_ORIGIN}/index.html`}${route ? `#/${route}` : ''}`);
  return win;
}
