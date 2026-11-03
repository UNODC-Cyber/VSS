/**
 * Security review F-15: the NetGate allowlist also pins the port (default https only). `electron` is mocked so the
 * test does not import (and download) the Electron binary (F-20).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }));

const { netGate } = await import('../../src/main/net/NetGate');

describe('F-15 NetGate refuses non-default ports on allowlisted hosts', () => {
  it.each(['https://api.github.com:8443/x', 'https://api.github.com:80/x', 'https://api.github.com:1/x'])(
    '%s is refused',
    (u) => {
      netGate.setEnabled(true);
      try {
        expect(netGate.isAllowed(u)).toBe(false);
      } finally {
        netGate.setEnabled(false);
      }
    },
  );
  it.each(['https://api.github.com/x', 'https://api.github.com:443/x'])('%s is allowed', (u) => {
    netGate.setEnabled(true);
    try {
      expect(netGate.isAllowed(u)).toBe(true);
    } finally {
      netGate.setEnabled(false);
    }
  });
});
