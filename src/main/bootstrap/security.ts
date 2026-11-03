/**
 * Process-wide security bootstrap: the vss://app scheme, CSP, permission/navigation denial, spellcheck off.
 * `registerAppScheme()` must run before app 'ready'; `installSecurity()` after.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { app, protocol, session } from 'electron';
import type { Session, WebContents } from 'electron';

export const APP_SCHEME = 'vss';
export const APP_ORIGIN = 'vss://app';

export function buildCsp(styleNonce?: string): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    `style-src 'self'${styleNonce ? ` 'nonce-${styleNonce}'` : ''}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}
export const CSP = buildCsp();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** Dev server origin (only honoured when the app is not packaged). */
export function devRendererUrl(): string | null {
  const url = process.env['ELECTRON_RENDERER_URL'];
  return !app.isPackaged && url ? url : null;
}

export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false, stream: true },
    },
  ]);
}

export function rendererRoot(): string {
  return resolve(join(app.getAppPath(), 'out', 'renderer'));
}

/** Resolve a request path inside the renderer root, refusing traversal. Exported for tests. */
export function resolveAppPath(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').includes('..')) return null;
  const rel = normalize(decoded === '/' || decoded === '' ? '/index.html' : decoded).replace(/^[/\\]+/, '');
  const full = resolve(root, rel);
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

function handleAppProtocol(): void {
  const root = rendererRoot();
  protocol.handle(APP_SCHEME, async (request) => {
    const nonce = randomBytes(16).toString('base64');
    const headers = {
      'content-security-policy': buildCsp(nonce),
      'x-content-type-options': 'nosniff',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    };
    const url = new URL(request.url);
    if (url.host !== 'app' || request.method !== 'GET') return new Response('Forbidden', { status: 403, headers });
    const file = resolveAppPath(root, url.pathname);
    if (!file || !existsSync(file)) return new Response('Not found', { status: 404, headers });
    let body: Uint8Array<ArrayBuffer> = new Uint8Array(await readFile(file));
    if (extname(file).toLowerCase() === '.html') {
      body = new TextEncoder().encode(new TextDecoder().decode(body).replaceAll('__CSP_NONCE__', nonce));
    }
    return new Response(body, {
      status: 200,
      headers: { ...headers, 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' },
    });
  });
}

function hardenSession(ses: Session): void {
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.setSpellCheckerEnabled(false);
  ses.setSpellCheckerLanguages([]);

  const dev = devRendererUrl();
  // Renderer-originated requests may only target our own scheme (or the dev server in unpackaged dev runs).
  // Main-process fetches (no webContents) go through NetGate and are not filtered here.
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (details.webContentsId === undefined) return callback({});
    const u = details.url;
    const allowed =
      u.startsWith(`${APP_ORIGIN}/`) ||
      u.startsWith('data:') ||
      u.startsWith('devtools:') ||
      (dev !== null && (u.startsWith(dev) || u.startsWith(dev.replace(/^http/, 'ws'))));
    callback({ cancel: !allowed });
  });
}

function hardenWebContents(wc: WebContents): void {
  const dev = devRendererUrl();
  const isOurs = (u: string): boolean => u.startsWith(`${APP_ORIGIN}/`) || (dev !== null && u.startsWith(dev));
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (event, url) => {
    if (!isOurs(url)) event.preventDefault();
  });
  wc.on('will-redirect', (event, url) => {
    if (!isOurs(url)) event.preventDefault();
  });
  wc.on('will-attach-webview', (event) => event.preventDefault());
}

export function installSecurity(): void {
  handleAppProtocol();
  hardenSession(session.defaultSession);
  app.on('web-contents-created', (_e, wc) => hardenWebContents(wc));
  // crashReporter is intentionally never started. No telemetry of any kind.
}
