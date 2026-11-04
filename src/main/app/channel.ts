/**
 * Build channel (docs/PLAN-ALPHA.md section 12, R9).
 *
 * `__VSS_CHANNEL__` is a build-time define (electron.vite.config.ts, main bundle): `npm run dist:alpha` sets `alpha`,
 * `npm run dist` sets `release`, a plain `npm run build` / `npm run dev` leaves it unset (`dev`). Everything in this
 * file is pure (no Electron import) so the build config and the tests can use it too.
 */
import type { AppChannel } from '@shared/ipc/contract';

declare const __VSS_CHANNEL__: string | undefined;

export const CHANNELS: readonly AppChannel[] = ['dev', 'alpha', 'release'];

export function parseChannel(raw: unknown): AppChannel {
  return typeof raw === 'string' && (CHANNELS as readonly string[]).includes(raw) ? (raw as AppChannel) : 'dev';
}

/** The channel this bundle was built for. Tests (no define) run as `dev`. */
export const CHANNEL: AppChannel = parseChannel(typeof __VSS_CHANNEL__ === 'undefined' ? undefined : __VSS_CHANNEL__);

/** A SemVer 2.0.0 version with a prerelease part (`0.2.0-alpha.1`). Build metadata is ignored. */
export function isPrereleaseVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+(\+[0-9A-Za-z.-]+)?$/.test(version);
}

/**
 * Which versions may be built for which channel: prerelease versions only with `alpha`, `release` only with a
 * plain version, `dev` (local builds, tests) with anything. Returns null when allowed, else the reason.
 */
export function channelVersionProblem(channel: AppChannel, version: string): string | null {
  if (channel === 'dev') return null;
  const pre = isPrereleaseVersion(version);
  if (channel === 'alpha' && !pre) return `channel alpha needs a prerelease version, got ${version}`;
  if (channel === 'release' && pre) return `a prerelease version (${version}) must be built with channel alpha`;
  return null;
}

/** Updates (electron-updater, NetGate) exist only in `release` and `dev` builds. */
export function updatesAllowed(channel: AppChannel): boolean {
  return channel !== 'alpha';
}

/** The fixed issue-form URL; nothing but version, OS version and architecture is ever appended. */
export const FEEDBACK_BASE =
  'https://github.com/UNODC-Cyber/VSS/issues/new?template=alpha-feedback.yml&labels=alpha&title=';

export function feedbackUrl(env: { version: string; os: string; arch: string }): string {
  const clean = (s: string) => s.replace(/[^0-9A-Za-z._+-]/g, '').slice(0, 40);
  const version = clean(env.version);
  const os = clean(env.os);
  const arch = clean(env.arch);
  return `${FEEDBACK_BASE}[alpha+${version}]+${os}+${arch}`;
}
