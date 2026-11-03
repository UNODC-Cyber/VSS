import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }));

const { netGate, NetworkDisabledError } = await import('../../src/main/net/NetGate');

describe('NetGate', () => {
  it('is disabled by default and refuses everything', () => {
    expect(netGate.enabled).toBe(false);
    expect(() => netGate.assertAllowed('https://api.github.com/x')).toThrow(NetworkDisabledError);
  });
  it('when enabled allows only https allowlisted hosts', () => {
    netGate.setEnabled(true);
    try {
      expect(netGate.isAllowed('https://api.github.com/repos/UNODC-Cyber/VSS/releases/latest')).toBe(true);
      expect(netGate.isAllowed('http://api.github.com/x')).toBe(false);
      expect(netGate.isAllowed('https://evil.example.com/x')).toBe(false);
      expect(netGate.isAllowed('https://api.github.com.evil.example/x')).toBe(false);
      expect(netGate.isAllowed('https://user:pw@api.github.com/x')).toBe(false);
      expect(netGate.isAllowed('not a url')).toBe(false);
    } finally {
      netGate.setEnabled(false);
    }
  });
});
