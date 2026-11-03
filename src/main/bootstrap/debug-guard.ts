/**
 * Security review F-10: a packaged VSS refuses to start with remote-debugging or inspector switches.
 *
 * The Electron fuses already disable `--inspect` / NODE_OPTIONS / RunAsNode for the Node side, but
 * `--remote-debugging-port` and `--remote-debugging-pipe` are Chromium switches: a same-user process could start
 * VSS with them and drive the unlocked renderer (and `window.vss`) over the DevTools protocol. Both the parsed
 * Chromium command line (`app.commandLine.hasSwitch`) and the raw argv are checked, so a switch spelled in a form
 * one of them misses is still caught. Pure (no Electron import) so it is unit-tested; index.ts wires it.
 */

/** Chromium / Node switch names (without leading dashes) that open a debugging channel. */
export const FORBIDDEN_SWITCHES: readonly string[] = [
  'remote-debugging-port',
  'remote-debugging-pipe',
  'remote-debugging-address',
  'remote-debugging-targets',
  'remote-allow-origins',
  'auto-open-devtools-for-tabs',
  'inspect',
  'inspect-brk',
  'inspect-port',
  'inspect-wait',
  'inspect-publish-uid',
  'debug',
  'debug-brk',
  'debug-port',
  'js-flags',
];

/** Any argv entry whose switch name starts like a debugging switch (`--remote-debugging...`, `-inspect=...`). */
const ARGV_PATTERN = /^(?:--?|\/)(?:remote-debugging|remote-allow-origins|inspect|debug|js-flags|auto-open-devtools)/i;

/**
 * The first forbidden switch found, or null. `hasSwitch` is `app.commandLine.hasSwitch`; `argv` is `process.argv`.
 * Only argv entries after the executable are inspected.
 */
export function findDebugSwitch(argv: readonly string[], hasSwitch: (name: string) => boolean): string | null {
  for (const s of FORBIDDEN_SWITCHES) {
    try {
      if (hasSwitch(s)) return s;
    } catch {
      return s; // a command line that cannot be inspected is refused too
    }
  }
  for (const a of argv.slice(1)) {
    const m = ARGV_PATTERN.exec(a.trim());
    if (m)
      return a
        .replace(/^[-/]+/, '')
        .split('=')[0]!
        .toLowerCase();
  }
  return null;
}

/** What the user sees; names no switch and no path. */
export const DEBUG_REFUSED_MESSAGE =
  'VSS was started with debugging options and will close. Start VSS from its normal shortcut.';
