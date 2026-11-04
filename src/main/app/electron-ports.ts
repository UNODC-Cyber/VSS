/**
 * Electron adapters for AppPorts. Not unit-tested (they only translate to Electron APIs); covered by the e2e test
 * and the manual checks listed in the lane report. Native dialogs go through the process-wide DialogGate
 * (app/dialog-gate.ts, unit-tested): one at a time, parented only on a live visible window, no undefined options.
 */
import { BrowserWindow, clipboard, ClipboardItem, dialog, powerMonitor, session, shell } from 'electron';
import type { OpenDialogOptions, SaveDialogOptions } from 'electron';
import { eventChannel } from '@shared/ipc/channels';
import { APP_ORIGIN, devRendererUrl } from '../bootstrap/security';
import type { ClipboardPort } from '../services/clipboard';
import type { FilesPort } from '../services/files';
import type { AppPorts, AppRoute } from './compose';
import { compactOptions, DialogGate, dialogParent } from './dialog-gate';

/**
 * Windows clipboard formats that keep an entry out of Win+V history and cloud sync.
 * VERIFY on a real Windows 11 build: the `electron application/osclipboard;format="<name>"` key syntax comes from the
 * Electron 45 typings (`Clipboard.has`); whether `Clipboard.write` registers arbitrary Windows formats the same way
 * must be checked by pasting into Win+V history after a copy. If it does not work the text is still copied and
 * auto-cleared; only the history exclusion is missing.
 */
export const WIN_EXCLUSION_FORMATS = [
  'ExcludeClipboardContentFromMonitorProcessing',
  'CanIncludeInClipboardHistory',
  'CanUploadToCloudClipboard',
] as const;

const osFormat = (name: string): string => `electron application/osclipboard;format="${name}"`;

export function createClipboardPort(): ClipboardPort {
  return {
    async write(text, sensitive) {
      if (!sensitive || process.platform !== 'win32') {
        await clipboard.writeText(text);
        return;
      }
      const zeroDword = new Blob([new Uint8Array([0, 0, 0, 0])]);
      const items: Record<string, string | Blob> = { 'text/plain': text };
      for (const f of WIN_EXCLUSION_FORMATS) items[osFormat(f)] = zeroDword;
      try {
        await clipboard.write([new ClipboardItem(items)]);
      } catch {
        // Unknown format syntax on this build: fall back to plain text (still auto-cleared).
        await clipboard.writeText(text);
      }
    },
    readText: () => clipboard.readText(),
    async clear() {
      await clipboard.clear();
    },
  };
}

/** One native dialog at a time for the whole process (lane J); exported for the crash guard and second-instance. */
export const dialogGate = new DialogGate();

export function createElectronPorts(getWindow: () => BrowserWindow | null): AppPorts {
  const filesPort: FilesPort = {
    showOpenDialog(o) {
      return dialogGate.run(
        async () => {
          const opts = compactOptions({
            title: o.title,
            filters: o.filters,
            properties: o.directory ? ['openDirectory' as const, 'createDirectory' as const] : ['openFile' as const],
          }) as OpenDialogOptions;
          const win = dialogParent(getWindow());
          const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
          return { canceled: r.canceled, filePaths: r.filePaths };
        },
        () => ({ canceled: true, filePaths: [] as string[] }),
      );
    },
    showSaveDialog(o) {
      return dialogGate.run(
        async () => {
          const opts = compactOptions({
            title: o.title,
            defaultPath: o.defaultPath,
            filters: o.filters,
          }) as SaveDialogOptions;
          const win = dialogParent(getWindow());
          const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
          return { canceled: r.canceled, filePath: r.filePath as string | undefined };
        },
        (): { canceled: boolean; filePath?: string | undefined } => ({ canceled: true }),
      );
    },
    showItemInFolder: (p) => shell.showItemInFolder(p),
  };

  /** Latest route asked for while a dialog was open (the reload waits until the dialog has returned). */
  let pendingRoute: AppRoute | null = null;
  const loadRoute = (route: AppRoute): void => {
    const w = getWindow();
    if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return;
    // A fresh document (unique query) so no renderer JS state survives the lock; the hash selects the route.
    const base = devRendererUrl() ?? `${APP_ORIGIN}/index.html`;
    w.webContents.loadURL(`${base}?r=${Date.now()}#/${route}`).catch(() => undefined);
  };

  return {
    files: filesPort,
    clipboard: createClipboardPort(),
    openExternal: (url) => shell.openExternal(url),
    emit(event, payload) {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send(eventChannel(event), payload);
      }
    },
    navigate(route) {
      if (!dialogGate.isOpen) {
        loadRoute(route);
        return;
      }
      // Reloading the window under an open modal shell dialog is what lane J removes; navigate once it returns.
      const first = pendingRoute === null;
      pendingRoute = route;
      if (first)
        void dialogGate.whenIdle().then(() => {
          const r = pendingRoute;
          pendingRoute = null;
          if (r) loadRoute(r);
        });
    },
    async clearRendererState() {
      const ses = session.defaultSession;
      await ses.clearCache();
      await ses.clearStorageData();
    },
    systemIdleSeconds: () => powerMonitor.getSystemIdleTime(),
    power: powerMonitor,
  };
}
