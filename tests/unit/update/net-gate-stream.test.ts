import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.mock('electron', () => ({ net: { fetch: fetchMock }, session: { fromPartition: vi.fn() } }));

const { netGate, NetworkDisabledError, NetworkRequestError } = await import('../../../src/main/net/NetGate');

function bodyOf(chunks: Uint8Array[], onChunk?: (i: number) => void): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= chunks.length) return c.close();
      onChunk?.(i);
      c.enqueue(chunks[i++]!);
    },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  netGate.setEnabled(false);
});

describe('NetGate.fetchBytes', () => {
  it('refuses while disabled without touching the network', async () => {
    await expect(netGate.fetchBytes('https://github.com/x', { maxBytes: 10 })).rejects.toBeInstanceOf(
      NetworkDisabledError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('streams a 200 body', async () => {
    netGate.setEnabled(true);
    fetchMock.mockResolvedValueOnce(new Response(bodyOf([new Uint8Array([1, 2]), new Uint8Array([3])])));
    expect(await netGate.fetchBytes('https://github.com/x', { maxBytes: 10 })).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: 'manual', credentials: 'omit' });
  });
  it('enforces the size cap (declared and streamed)', async () => {
    netGate.setEnabled(true);
    fetchMock.mockResolvedValueOnce(new Response('x'.repeat(20), { headers: { 'content-length': '20' } }));
    await expect(netGate.fetchBytes('https://github.com/x', { maxBytes: 10 })).rejects.toBeInstanceOf(
      NetworkRequestError,
    );
    fetchMock.mockResolvedValueOnce(new Response(bodyOf([new Uint8Array(8), new Uint8Array(8)])));
    await expect(netGate.fetchBytes('https://github.com/x', { maxBytes: 10 })).rejects.toBeInstanceOf(
      NetworkRequestError,
    );
  });
  it('rejects non-200 responses', async () => {
    netGate.setEnabled(true);
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }));
    await expect(netGate.fetchBytes('https://github.com/x', { maxBytes: 10 })).rejects.toThrow(/404/);
  });
  it('aborts if the gate is disabled mid-stream', async () => {
    netGate.setEnabled(true);
    fetchMock.mockResolvedValueOnce(
      new Response(bodyOf([new Uint8Array(1), new Uint8Array(1)], (i) => i === 1 && netGate.setEnabled(false))),
    );
    await expect(netGate.fetchBytes('https://github.com/x', { maxBytes: 10 })).rejects.toBeInstanceOf(
      NetworkDisabledError,
    );
  });
  it('follows allowlisted redirects, drops headers across hosts, refuses off-allowlist hops', async () => {
    netGate.setEnabled(true);
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/a' } }),
      )
      .mockResolvedValueOnce(new Response('ok'));
    const out = await netGate.fetchBytes('https://github.com/x', { maxBytes: 10, headers: { accept: 'x/y' } });
    expect(new TextDecoder().decode(out)).toBe('ok');
    expect(fetchMock.mock.calls[0]![1].headers).toEqual({ accept: 'x/y' });
    expect(fetchMock.mock.calls[1]![1].headers).toBeUndefined();

    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://evil.example.com/a' } }),
    );
    await expect(netGate.fetchBytes('https://github.com/x', { maxBytes: 10 })).rejects.toBeInstanceOf(
      NetworkDisabledError,
    );
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://github.com/a' } }));
    await expect(netGate.fetchBytes('https://github.com/x', { maxBytes: 10 })).rejects.toBeInstanceOf(
      NetworkDisabledError,
    );
  });
});

describe('NetGate.guardSession', () => {
  it('cancels electron-updater session requests unless enabled and allowlisted', () => {
    let handler: ((d: { url: string }, cb: (r: { cancel: boolean }) => void) => void) | null = null;
    netGate.guardSession({
      webRequest: { onBeforeRequest: (h: typeof handler) => (handler = h) },
    } as never);
    const decide = (url: string): boolean => {
      let cancel: boolean | null = null;
      handler!({ url }, (r) => (cancel = r.cancel));
      return cancel!;
    };
    expect(decide('https://github.com/UNODC-Cyber/VSS/releases.atom')).toBe(true);
    netGate.setEnabled(true);
    expect(decide('https://github.com/UNODC-Cyber/VSS/releases.atom')).toBe(false);
    expect(decide('https://evil.example.com/x')).toBe(true);
    expect(decide('http://github.com/x')).toBe(true);
    netGate.setEnabled(false);
  });
});
