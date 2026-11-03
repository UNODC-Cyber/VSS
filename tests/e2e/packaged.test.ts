/**
 * Smoke test of the PACKAGED (electron-builder, fuses flipped) app. Skipped unless VSS_PACKAGED_EXE points at
 * dist/win-unpacked/<name>.exe.
 *
 *   $env:VSS_PACKAGED_EXE = (Resolve-Path dist/win-unpacked/*.exe)
 *   npx vitest run --config vitest.e2e.config.ts tests/e2e/packaged.test.ts
 *
 * Security review F-10: the packaged app refuses remote-debugging / inspector switches, so it can no longer be
 * driven over CDP the way this test used to (that WAS the attack). What is checked here:
 *   1. started with --remote-debugging-port, the exe exits on its own with a non-zero code and no DevTools endpoint
 *      ever answers on that port;
 *   2. started normally, it stays up (and creates nothing in the data folder before a vault is created).
 * The in-app journey of the packaged build (native module from app.asar.unpacked, exporter template from the asar)
 * is a manual VERIFY item in docs/SECURITY.md; tests/e2e/journey.test.ts covers the same code unpackaged.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';

const exe = process.env['VSS_PACKAGED_EXE'];
const PORT = 9333;
const root = mkdtempSync(join(tmpdir(), 'vss-pkg-'));
const children: ChildProcess[] = [];

afterAll(async () => {
  for (const c of children) {
    if (c.exitCode === null) {
      const exited = new Promise<void>((r) => c.once('exit', () => r()));
      c.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    }
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

function start(args: string[], dataDir: string): ChildProcess {
  const env = { ...process.env, VSS_DATA_DIR: dataDir } as Record<string, string>;
  delete env['ELECTRON_RUN_AS_NODE'];
  const c = spawn(exe!, args, { env, stdio: 'ignore' });
  children.push(c);
  return c;
}

const exitWithin = (c: ChildProcess, ms: number): Promise<number | null> =>
  new Promise((r) => {
    if (c.exitCode !== null) return r(c.exitCode);
    const t = setTimeout(() => r(null), ms);
    c.once('exit', (code) => {
      clearTimeout(t);
      r(code ?? -1);
    });
  });

/** True when a DevTools endpoint answers on the debugging port. */
async function cdpAnswers(): Promise<boolean> {
  try {
    const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 1000 });
    await b.close();
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!exe)('packaged app', () => {
  it('refuses to start with --remote-debugging-port (no CDP endpoint, non-zero exit)', async () => {
    const c = start([`--remote-debugging-port=${PORT}`], join(root, 'a'));
    let answered = false;
    for (let i = 0; i < 10 && c.exitCode === null; i++) {
      answered ||= await cdpAnswers();
      await new Promise((r) => setTimeout(r, 300));
    }
    const code = await exitWithin(c, 15_000);
    expect(answered).toBe(false);
    expect(code).not.toBeNull();
    expect(code).not.toBe(0);
  });

  it.each([['--remote-debugging-pipe'], ['--inspect=0'], ['--js-flags=--allow-natives-syntax']])(
    'refuses %s',
    async (flag) => {
      const code = await exitWithin(start([flag], join(root, 'b')), 15_000);
      expect(code).not.toBeNull();
      expect(code).not.toBe(0);
    },
  );

  it('starts normally without those switches', async () => {
    const dataDir = join(root, 'c');
    const c = start([], dataDir);
    expect(await exitWithin(c, 5000)).toBeNull(); // still running
    expect(existsSync(dataDir) ? readdirSync(dataDir).filter((f) => f.startsWith('vss.db')) : []).toEqual([]);
  });
});
