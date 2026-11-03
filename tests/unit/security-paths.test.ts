import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: true, getAppPath: () => '/x', on: vi.fn() },
  protocol: {},
  session: {},
}));

const { resolveAppPath } = await import('../../src/main/bootstrap/security');

describe('vss://app path resolution', () => {
  const root = resolve('/tmp/renderer');
  it('maps / to index.html', () => {
    expect(resolveAppPath(root, '/')).toBe(resolve(root, 'index.html'));
  });
  it('serves nested assets', () => {
    expect(resolveAppPath(root, '/assets/app.js')).toBe(resolve(root, 'assets/app.js'));
  });
  it('rejects traversal, encoded traversal, backslashes and NULs', () => {
    expect(resolveAppPath(root, '/../secret')).toBeNull();
    expect(resolveAppPath(root, '/%2e%2e/secret')).toBeNull();
    expect(resolveAppPath(root, '/a/..%2f..%2fsecret')).toBeNull();
    expect(resolveAppPath(root, '/..\\secret')).toBeNull();
    expect(resolveAppPath(root, '/a%00.js')).toBeNull();
    expect(resolveAppPath(root, '/%E0%A4%A')).toBeNull();
  });
});
