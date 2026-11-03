/**
 * Main-process logger with a field allowlist. It cannot log personal data or request bodies: only the keys below
 * are ever written, only primitive values, strings are truncated and stripped of path separators and control chars.
 * No file I/O here: the sink defaults to stderr (nothing is persisted).
 */

export const LOG_FIELDS: ReadonlySet<string> = new Set([
  'code',
  'phase',
  'version',
  'durationMs',
  'count',
  'bytes',
  'reason',
  'kind',
  'state',
  'channel',
  'ok',
  'enabled',
]);

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_STRING = 80;

export type LogFields = Record<string, unknown>;
export interface LogSink {
  write(line: string): void;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
const clean = (s: string): string =>
  s.replace(CONTROL, ' ').replaceAll('/', '_').replaceAll('\\', '_').slice(0, MAX_STRING);

/** Exposed for tests. Drops every key that is not allowlisted and every non-primitive value. */
export function sanitizeFields(fields: LogFields | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!fields) return out;
  for (const [k, v] of Object.entries(fields)) {
    if (!LOG_FIELDS.has(k)) continue;
    if (typeof v === 'string') out[k] = clean(v);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

export function createLogger(opts: { sink?: LogSink; level?: LogLevel; now?: () => Date } = {}): Logger {
  const sink: LogSink = opts.sink ?? { write: (l) => process.stderr.write(`${l}\n`) };
  const min = ORDER[opts.level ?? 'info'];
  const now = opts.now ?? (() => new Date());
  const emit = (level: LogLevel, event: string, fields?: LogFields): void => {
    if (ORDER[level] < min) return;
    const line = JSON.stringify({ t: now().toISOString(), level, event: clean(event), ...sanitizeFields(fields) });
    try {
      sink.write(line);
    } catch {
      // logging must never break the app
    }
  };
  return {
    debug: (e, f) => emit('debug', e, f),
    info: (e, f) => emit('info', e, f),
    warn: (e, f) => emit('warn', e, f),
    error: (e, f) => emit('error', e, f),
  };
}

export const nullLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
