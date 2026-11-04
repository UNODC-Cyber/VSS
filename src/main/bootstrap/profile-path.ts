/**
 * Guard for `app.setPath(name, path)` (lane J, R10). The owner's packaged build stopped at
 * `app.setPath('userData', paths.sessionDir)` with "Error processing argument at index 1, conversion failure".
 * Electron 45 raises exactly that message for a non-string path or a string containing NUL (probe results in
 * docs/INVESTIGATION-dialog-crash.md); a relative path gives "Path must be absolute" instead. This check runs first
 * so such a value becomes a coded, PII-free startup fault with a friendly message instead of Electron's raw box.
 */
import { isAbsolute } from 'node:path';

export class ProfilePathError extends Error {
  readonly code = 'PROFILE_PATH_INVALID' as const;
  constructor() {
    super('profile path invalid');
    this.name = 'ProfilePathError';
  }
}

/** `p` if Electron can take it as an absolute FilePath; throws ProfilePathError otherwise. */
export function checkedProfilePath(p: unknown): string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 32_000 || p.includes('\u0000') || !isAbsolute(p)) {
    throw new ProfilePathError();
  }
  return p;
}
