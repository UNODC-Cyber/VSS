import { describe, expect, it } from 'vitest';
import type { UpdateState } from '../../../src/shared/ipc/contract';
import { sha512Hex } from '../../../src/main/update/crypto';
import { CHECK_INTERVAL_MS, UpdateService } from '../../../src/main/update/service';
import type { FsPort, NetPort, UpdateInfoLike, UpdaterPort } from '../../../src/main/update/service';
import { INSTALLER_BYTES, INSTALLER_NAME, makeKey, makeManifest, signManifest, tamperSig } from './helpers';
import type { Signed } from './helpers';

const KEY = makeKey();
const OTHER = makeKey();
const BASE = 'https://github.com/UNODC-Cyber/VSS/releases/download/v1.2.0/';
const INSTALLER_PATH = 'C:/cache/pending/vss-1.2.0-x64-setup.exe';

class FakeNet implements NetPort {
  calls: string[] = [];
  enabled = false;
  files = new Map<string, Uint8Array>();
  failOn: string | null = null;
  setEnabled(on: boolean): void {
    this.calls.push(`setEnabled:${on}`);
    this.enabled = on;
  }
  async fetchBytes(url: string): Promise<Uint8Array> {
    this.calls.push(`fetch:${url}`);
    if (!this.enabled) throw Object.assign(new Error('disabled'), { code: 'NETWORK_DISABLED' });
    if (this.failOn && url.endsWith(this.failOn)) throw new Error('boom');
    const f = this.files.get(url);
    if (!f) throw new Error('404');
    return f;
  }
  serve(s: Signed, base = BASE): void {
    const enc = (t: string): Uint8Array => new TextEncoder().encode(t);
    this.files.set(`${base}release-manifest.json`, s.bytes);
    this.files.set(`${base}release-manifest.sig.ed25519`, enc(s.sigEd));
    this.files.set(`${base}release-manifest.sig.mldsa65`, enc(s.sigPq));
  }
}

class FakeUpdater implements UpdaterPort {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowDowngrade = true;
  allowPrerelease = true;
  info: UpdateInfoLike | null = {
    version: '1.2.0',
    files: [{ url: INSTALLER_NAME, size: INSTALLER_BYTES.length }],
    releaseNotes: 'Notes',
  };
  checkError: Error | null = null;
  downloadError: Error | null = null;
  installed = 0;
  calls: string[] = [];
  #progress: ((p: { transferred: number; total: number }) => void) | null = null;
  constructor(private readonly net: FakeNet) {}
  async checkForUpdates(): Promise<{ updateInfo: UpdateInfoLike } | null> {
    this.calls.push(`check(net=${this.net.enabled})`);
    if (!this.net.enabled) throw Object.assign(new Error('gate'), { code: 'NETWORK_DISABLED' });
    if (this.checkError) throw this.checkError;
    return this.info ? { updateInfo: this.info } : null;
  }
  async downloadUpdate(): Promise<string[]> {
    this.calls.push(`download(net=${this.net.enabled})`);
    if (!this.net.enabled) throw Object.assign(new Error('gate'), { code: 'NETWORK_DISABLED' });
    if (this.downloadError) throw this.downloadError;
    this.#progress?.({ transferred: 10, total: INSTALLER_BYTES.length });
    return [INSTALLER_PATH];
  }
  quitAndInstall(): void {
    this.installed++;
  }
  onDownloadProgress(l: (p: { transferred: number; total: number }) => void): void {
    this.#progress = l;
  }
}

class FakeFs implements FsPort {
  contents = new Map<string, Uint8Array>([[INSTALLER_PATH, INSTALLER_BYTES]]);
  removed: string[] = [];
  async hashFile(path: string): Promise<{ sha512Hex: string; size: number }> {
    const b = this.contents.get(path);
    if (!b) throw new Error('ENOENT');
    return { sha512Hex: sha512Hex(b), size: b.length };
  }
  async remove(path: string): Promise<void> {
    this.removed.push(path);
    this.contents.delete(path);
  }
}

function setup(opts: { enabled?: boolean; now?: number; current?: string } = {}) {
  const net = new FakeNet();
  const updater = new FakeUpdater(net);
  const fs = new FakeFs();
  let now = opts.now ?? Date.UTC(2026, 10, 3);
  let enabled = opts.enabled ?? true;
  const states: UpdateState[] = [];
  const service = new UpdateService({
    currentVersion: opts.current ?? '1.1.0',
    updater,
    net,
    fs,
    clock: { now: () => now },
    keys: { current: KEY.pub, next: null },
    isCheckEnabled: async () => enabled,
    emit: (s) => states.push(s),
  });
  net.serve(signManifest(KEY, makeManifest('1.2.0')));
  return {
    net,
    updater,
    fs,
    service,
    states,
    advance: (ms: number) => (now += ms),
    setEnabled: (v: boolean) => (enabled = v),
  };
}

describe('UpdateService configuration', () => {
  it('forces autoDownload, autoInstallOnAppQuit, allowDowngrade and prerelease off', () => {
    const { updater } = setup();
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
    expect(updater.allowPrerelease).toBe(false);
  });
});

describe('updateCheckEnabled = false', () => {
  it('makes ZERO NetGate calls on unlock, check and download', async () => {
    const t = setup({ enabled: false });
    await t.service.onUnlocked();
    const r = await t.service.check();
    expect(r).toMatchObject({ ok: true, value: { phase: 'disabled' } });
    const d = await t.service.download();
    expect(d.ok).toBe(false);
    expect(t.net.calls).toEqual([]);
    expect(t.updater.calls).toEqual([]);
  });
  it('a download is refused (no network) if checks were turned off after a check', async () => {
    const t = setup();
    await t.service.check();
    t.net.calls = [];
    t.setEnabled(false);
    expect(await t.service.download()).toMatchObject({ ok: false, error: { code: 'NETWORK_DISABLED' } });
    expect(t.net.calls).toEqual([]);
  });
});

describe('check', () => {
  it('idle -> checking -> available, gate enabled only during the check', async () => {
    const t = setup();
    const r = await t.service.check();
    expect(r).toMatchObject({
      ok: true,
      value: { phase: 'available', availableVersion: '1.2.0', releaseNotes: 'Notes' },
    });
    expect(t.states.map((s) => s.phase)).toEqual(['checking', 'available']);
    expect(t.net.calls).toEqual(['setEnabled:true', 'setEnabled:false']);
    expect(t.updater.calls).toEqual(['check(net=true)']);
    expect(t.net.enabled).toBe(false);
  });
  it('reports up-to-date for same / older / prerelease offers', async () => {
    for (const version of ['1.1.0', '1.0.0', '1.2.0-rc.1']) {
      const t = setup();
      t.updater.info = { version, files: [{ url: INSTALLER_NAME }] };
      expect(await t.service.check()).toMatchObject({ ok: true, value: { phase: 'up-to-date' } });
    }
  });
  it('disables the gate again after a failed check and returns a typed error', async () => {
    const t = setup();
    t.updater.checkError = new Error('offline');
    const r = await t.service.check();
    expect(r).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    expect(t.service.snapshot.phase).toBe('error');
    expect(t.net.calls).toEqual(['setEnabled:true', 'setEnabled:false']);
    expect(t.net.enabled).toBe(false);
  });
  it('null result (unpackaged build) -> NOT_SUPPORTED', async () => {
    const t = setup();
    t.updater.info = null;
    expect(await t.service.check()).toMatchObject({ ok: false, error: { code: 'NOT_SUPPORTED' } });
  });
});

describe('automatic check after unlock (<= 1 per 24 h)', () => {
  it('checks on first unlock, not again within 24 h, again after 24 h', async () => {
    const t = setup();
    t.updater.info = { version: '1.1.0', files: [{ url: INSTALLER_NAME }] };
    await t.service.onUnlocked();
    await t.service.onUnlocked();
    t.advance(CHECK_INTERVAL_MS - 1);
    await t.service.onUnlocked();
    expect(t.updater.calls).toHaveLength(1);
    t.advance(1);
    await t.service.onUnlocked();
    expect(t.updater.calls).toHaveLength(2);
  });
  it('a clock moved backwards does not suppress checks forever', async () => {
    const t = setup();
    t.updater.info = { version: '1.1.0', files: [{ url: INSTALLER_NAME }] };
    await t.service.onUnlocked();
    t.advance(-1000);
    await t.service.onUnlocked();
    expect(t.updater.calls).toHaveLength(2);
  });
});

describe('download + verify', () => {
  it('happy path: available -> downloading -> verifying -> verified; install hands over once', async () => {
    const t = setup();
    await t.service.check();
    t.net.calls = [];
    const r = await t.service.download();
    expect(r).toMatchObject({ ok: true, value: { phase: 'verified' } });
    expect(t.states.map((s) => s.phase)).toEqual([
      'checking',
      'available',
      'downloading',
      'downloading',
      'verifying',
      'verified',
    ]);
    expect(t.net.calls).toEqual([
      'setEnabled:true',
      `fetch:${BASE}release-manifest.json`,
      `fetch:${BASE}release-manifest.sig.ed25519`,
      `fetch:${BASE}release-manifest.sig.mldsa65`,
      'setEnabled:false',
    ]);
    expect(t.net.enabled).toBe(false);
    expect(t.updater.installed).toBe(0); // never auto-installs
    expect(await t.service.install()).toEqual({ ok: true, value: { ok: true } });
    expect(t.updater.installed).toBe(1);
    expect(t.fs.removed).toEqual([]);
  });

  it('install is refused unless verified', async () => {
    const t = setup();
    expect(await t.service.install()).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    await t.service.check();
    expect(await t.service.install()).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(t.updater.installed).toBe(0);
  });

  it('download is refused unless an update is available', async () => {
    const t = setup();
    expect(await t.service.download()).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(t.net.calls).toEqual([]);
  });

  type Case = [string, (t: ReturnType<typeof setup>) => void];
  const cases: Case[] = [
    [
      'tampered manifest',
      (t) => {
        const s = signManifest(KEY, makeManifest('1.2.0'));
        const b = new Uint8Array(s.bytes);
        b[b.length - 3] = b[b.length - 3]! ^ 1;
        t.net.serve({ ...s, bytes: b });
      },
    ],
    [
      'tampered Ed25519 signature',
      (t) => {
        const s = signManifest(KEY, makeManifest('1.2.0'));
        t.net.serve({ ...s, sigEd: tamperSig(s.sigEd) });
      },
    ],
    [
      'tampered ML-DSA-65 signature',
      (t) => {
        const s = signManifest(KEY, makeManifest('1.2.0'));
        t.net.serve({ ...s, sigPq: tamperSig(s.sigPq) });
      },
    ],
    [
      'only one signature',
      (t) => {
        const s = signManifest(KEY, makeManifest('1.2.0'));
        t.net.serve({ ...s, sigPq: '' });
      },
    ],
    ['wrong key', (t) => t.net.serve(signManifest(OTHER, makeManifest('1.2.0')))],
    [
      'wrong installer hash',
      (t) => t.fs.contents.set(INSTALLER_PATH, new TextEncoder().encode('synthetic installer bytes for test5')),
    ],
    ['size mismatch', (t) => t.fs.contents.set(INSTALLER_PATH, new TextEncoder().encode('short'))],
    [
      'installer missing from manifest',
      (t) => {
        const m = makeManifest('1.2.0');
        m.files = m.files.slice(1);
        t.net.serve(signManifest(KEY, m));
      },
    ],
    ['replay of an older valid manifest', (t) => t.net.serve(signManifest(KEY, makeManifest('1.1.0')))],
    [
      'an expired signed manifest (F-12)',
      (t) =>
        t.net.serve(signManifest(KEY, { ...makeManifest('1.2.0'), notBefore: '2026-01-01', notAfter: '2026-03-31' })),
    ],
    [
      'a signed manifest that is not valid yet (F-12)',
      (t) =>
        t.net.serve(signManifest(KEY, { ...makeManifest('1.2.0'), notBefore: '2027-01-01', notAfter: '2027-03-31' })),
    ],
  ];
  for (const [name, arrange] of cases) {
    it(`rejects ${name}: verify-failed, download deleted, gate off, no install`, async () => {
      const t = setup();
      await t.service.check();
      arrange(t);
      const r = await t.service.download();
      expect(r).toMatchObject({ ok: false, error: { code: 'UPDATE_VERIFY_FAILED' } });
      expect(t.service.snapshot.phase).toBe('verify-failed');
      expect(t.fs.removed).toEqual([INSTALLER_PATH]);
      expect(t.net.enabled).toBe(false);
      expect(t.net.calls.at(-1)).toBe('setEnabled:false');
      expect(await t.service.install()).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      expect(t.updater.installed).toBe(0);
    });
  }

  it('rejects a downgrade offer (feed and manifest both older)', async () => {
    const t = setup({ current: '1.3.0' });
    t.updater.info = { version: '1.2.0', files: [{ url: INSTALLER_NAME }] };
    expect(await t.service.check()).toMatchObject({ ok: true, value: { phase: 'up-to-date' } });
    expect(await t.service.download()).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });

  it('network failure while fetching signatures: error, download deleted, gate off', async () => {
    const t = setup();
    await t.service.check();
    t.net.failOn = 'release-manifest.sig.mldsa65';
    const r = await t.service.download();
    expect(r).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    expect(t.service.snapshot.phase).toBe('error');
    expect(t.fs.removed).toEqual([INSTALLER_PATH]);
    expect(t.net.enabled).toBe(false);
  });

  it('download failure: error, gate off', async () => {
    const t = setup();
    await t.service.check();
    t.updater.downloadError = new Error('reset');
    expect(await t.service.download()).toMatchObject({ ok: false });
    expect(t.net.enabled).toBe(false);
    expect(t.net.calls.at(-1)).toBe('setEnabled:false');
  });

  it('install refuses an installer modified after verification and deletes it', async () => {
    const t = setup();
    await t.service.check();
    await t.service.download();
    t.fs.contents.set(INSTALLER_PATH, new TextEncoder().encode('swapped'));
    expect(await t.service.install()).toMatchObject({ ok: false, error: { code: 'UPDATE_VERIFY_FAILED' } });
    expect(t.updater.installed).toBe(0);
    expect(t.fs.removed).toEqual([INSTALLER_PATH]);
  });
});
