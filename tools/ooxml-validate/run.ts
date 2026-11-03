/**
 * X-08 runner: exports sample workbooks from the synthetic fixtures, checks them with the Node structural validator,
 * then with the OpenXML SDK validator (tools/ooxml-validate/OoxmlValidate.csproj) and a LibreOffice headless
 * conversion.
 *
 *   node tools/ooxml-validate/run.ts             # local: skips a tool that is not installed
 *   node tools/ooxml-validate/run.ts --require   # CI: a missing .NET SDK or LibreOffice is a failure
 *
 * Output goes to out/ooxml-validate/ (git-ignored).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSamples } from './export-samples.ts';
import { validatePackageStructure } from './structural.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require_ = process.argv.includes('--require');
const outDir = join(root, 'out', 'ooxml-validate');
let failed = false;

function fail(msg: string): void {
  console.error(`FAIL ${msg}`);
  failed = true;
}

function missing(tool: string): void {
  if (require_) fail(`${tool} is not available`);
  else console.log(`SKIP ${tool} is not installed (CI runs it with --require)`);
}

rmSync(outDir, { recursive: true, force: true });
const samples = writeSamples(join(outDir, 'samples'));
console.log(`exported ${samples.length} samples`);

for (const f of samples) {
  const errs = validatePackageStructure(new Uint8Array(readFileSync(f)));
  if (errs.length > 0) fail(`structural ${basename(f)}: ${errs.join('; ')}`);
}
if (!failed) console.log('PASS structural validator');

// OpenXML SDK (needs a .NET SDK, not just a runtime).
const sdks = spawnSync('dotnet', ['--list-sdks'], { encoding: 'utf8' });
if (sdks.status !== 0 || sdks.stdout.trim() === '') {
  missing('.NET SDK');
} else {
  const r = spawnSync(
    'dotnet',
    [
      'run',
      '--project',
      join(root, 'tools', 'ooxml-validate', 'OoxmlValidate.csproj'),
      '-c',
      'Release',
      '--',
      join(outDir, 'samples'),
    ],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) fail(`OpenXML SDK validator exited ${r.status}`);
  else console.log('PASS OpenXML SDK validator');
}

// LibreOffice headless: every sample must load and convert.
const soffice = process.platform === 'win32' ? 'soffice.com' : 'soffice';
const probe = spawnSync(soffice, ['--version'], { encoding: 'utf8' });
if (probe.error || probe.status !== 0) {
  missing('LibreOffice');
} else {
  const conv = join(outDir, 'libreoffice');
  mkdirSync(conv, { recursive: true });
  const profile = `file:///${join(outDir, 'lo-profile').replace(/\\/g, '/').replace(/^\//, '')}`;
  for (const f of samples) {
    const r = spawnSync(
      soffice,
      [`-env:UserInstallation=${profile}`, '--headless', '--convert-to', 'ods', '--outdir', conv, f],
      { encoding: 'utf8', timeout: 180_000 },
    );
    const out = join(conv, basename(f).replace(/\.xlsx$/, '.ods'));
    if (r.status !== 0) fail(`LibreOffice exited ${r.status} on ${basename(f)}`);
    else if (!existsSync(out) || statSync(out).size === 0) fail(`LibreOffice produced no output for ${basename(f)}`);
  }
  if (!failed) console.log('PASS LibreOffice headless conversion');
}

process.exit(failed ? 1 : 0);
