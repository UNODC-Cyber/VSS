import { describe, expect, it } from 'vitest';
import {
  CHANNEL,
  channelVersionProblem,
  feedbackUrl,
  FEEDBACK_BASE,
  isPrereleaseVersion,
  parseChannel,
  updatesAllowed,
} from '../../../src/main/app/channel';
import { createDisabledUpdateService } from '../../../src/main/services/alpha-updates';

describe('build channel', () => {
  it('tests run as dev (no build define)', () => {
    expect(CHANNEL).toBe('dev');
  });

  it('parses only known channels', () => {
    expect(parseChannel('alpha')).toBe('alpha');
    expect(parseChannel('release')).toBe('release');
    expect(parseChannel('ALPHA')).toBe('dev');
    expect(parseChannel(undefined)).toBe('dev');
    expect(parseChannel('')).toBe('dev');
  });

  it('detects prerelease versions', () => {
    expect(isPrereleaseVersion('0.2.0-alpha.1')).toBe(true);
    expect(isPrereleaseVersion('1.0.0-beta.2+build.5')).toBe(true);
    expect(isPrereleaseVersion('0.2.0')).toBe(false);
    expect(isPrereleaseVersion('0.2.0+build.5')).toBe(false);
  });

  it('version / channel matrix', () => {
    const cases: [Parameters<typeof channelVersionProblem>[0], string, boolean][] = [
      ['alpha', '0.2.0-alpha.1', true],
      ['alpha', '0.2.0-beta.1', true],
      ['alpha', '0.2.0', false],
      ['release', '0.2.0', true],
      ['release', '0.2.0-alpha.1', false],
      ['release', '0.2.0-rc.1', false],
      ['dev', '0.2.0', true],
      ['dev', '0.2.0-alpha.1', true],
    ];
    for (const [channel, version, allowed] of cases) {
      expect(channelVersionProblem(channel, version) === null, `${channel} ${version}`).toBe(allowed);
    }
  });

  it('the package version agrees with its channel rules', async () => {
    const { version } = (await import('../../../package.json')).default as { version: string };
    expect(channelVersionProblem(isPrereleaseVersion(version) ? 'alpha' : 'release', version)).toBeNull();
  });

  it('updates exist only outside alpha', () => {
    expect(updatesAllowed('alpha')).toBe(false);
    expect(updatesAllowed('release')).toBe(true);
    expect(updatesAllowed('dev')).toBe(true);
  });

  it('the alpha update service is a no-network stub', async () => {
    const svc = await createDisabledUpdateService('0.2.0-alpha.1')({
      isCheckEnabled: async () => true,
      emit: () => undefined,
      store: { load: async () => null, save: async () => undefined },
    });
    const h = svc.handlers();
    const s = await h.check();
    expect(s.ok && s.value.phase).toBe('disabled');
    expect(s.ok && s.value.message).toBe('updates.alphaDisabled');
    expect((await h.download()).ok).toBe(false);
    expect((await h.install()).ok).toBe(false);
  });
});

describe('feedback URL', () => {
  it('is the fixed issue-form URL plus version, OS and architecture only', () => {
    const url = feedbackUrl({ version: '0.2.0-alpha.1', os: 'win32-10.0.26300', arch: 'x64' });
    expect(url).toBe(`${FEEDBACK_BASE}[alpha+0.2.0-alpha.1]+win32-10.0.26300+x64`);
    expect(
      url.startsWith('https://github.com/UNODC-Cyber/VSS/issues/new?template=alpha-feedback.yml&labels=alpha&title='),
    ).toBe(true);
  });

  it('strips anything that could smuggle extra parameters or data', () => {
    const url = feedbackUrl({ version: '1&body=secret', os: 'x y\n#z', arch: '%00' });
    expect(url.slice(FEEDBACK_BASE.length)).not.toMatch(/[&#%\s]/);
    expect(url).not.toContain('body=');
  });
});
