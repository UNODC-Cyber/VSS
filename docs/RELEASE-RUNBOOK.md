# VSS release runbook

How VSS releases are built, signed, published and verified, and how the update-signing keys are created, held and
rotated. Public document: it contains no key material, names or internal details.

## 1. Trust model in one paragraph

GitHub Actions builds an **unsigned draft** release. The maintainer downloads the draft assets to an offline machine and
signs a small manifest (`release-manifest.json`: version, date, SHA-512 and size of every asset) with **two** keys:
Ed25519 and ML-DSA-65 (FIPS 204, post-quantum). The installed app downloads an update only when the user clicks
**Download**, then fetches the manifest and both signatures through `NetGate`, requires **both** signatures to verify
under one embedded key slot, refuses any version that is not newer than the running one or differs from the version
offered, and compares the SHA-512 and size of the downloaded installer. Only then can the user click **Install**.
CI never sees a private key, so a compromised CI, GitHub account or TLS connection cannot ship a release that installed
apps accept.

Files (all release assets, same directory):

| File                           | Content                                                                    |
| ------------------------------ | -------------------------------------------------------------------------- |
| `release-manifest.json`        | canonical JSON (sorted keys, no whitespace, no trailing newline)           |
| `release-manifest.sig.ed25519` | base64 Ed25519 signature over the exact manifest bytes                     |
| `release-manifest.sig.mldsa65` | base64 ML-DSA-65 signature, FIPS 204 context `VSS release manifest v1`     |
| `SHA512SUMS`                   | convenience checksums produced by CI (not trusted by the app)              |
| `vss-<version>.cdx.json`       | CycloneDX SBOM                                                             |
| `latest.yml`, `*.blockmap`     | electron-updater feed metadata (not trusted; the manifest is what counts)  |

Manifest schema (`formatVersion` 2): `{"date":"YYYY-MM-DD","files":[{"name":…,"sha512":"<128 lowercase hex>","size":<int>}],"formatVersion":2,"notAfter":"YYYY-MM-DD","notBefore":"YYYY-MM-DD","version":"<SemVer 2.0.0>"}`.

**Validity window (security review F-12).** `notBefore` / `notAfter` (UTC days, inclusive) are signed with the rest. An
installed app accepts the manifest only inside that window (one day of clock tolerance either side), so somebody who
controls the feed but not the offline keys cannot keep offering an old signed release forever. `sign-manifest` sets
`notBefore = --date` and `notAfter = --date + --valid-days` (default 90, at most 180). While a release is still the
current one, **re-sign its manifest before `notAfter`** (same assets, new `--date`) and replace the three manifest files
on the release; nothing else changes. `verify-release` reports an expired or not-yet-valid manifest. Version 1
manifests (no window) are refused. Residual: a feed that withholds every newer release (freeze) is not detected; that
would need a signed "latest" statement checked on every update check.

Tools (Node 22.12+, run from a checkout after `npm ci`):

```
node tools/release/run.mjs gen-keys       --out <file outside any git repo> [--slot current|next]
node tools/release/run.mjs sign-manifest  --dir <assets> --version <x.y.z> --seeds <seed-file|-> [--date YYYY-MM-DD]
node tools/release/run.mjs verify-release --dir <assets> [--expect-version x.y.z] [--allow-missing]
```

Seeds are read from a file path or from stdin (`-`). The tools never read keys from environment variables, never write
them inside a git work tree, and `gen-keys` never overwrites an existing file.

## 2. Key ceremony (once, and again for each rotation)

**The keys in `src/main/update/keys.ts` today are TEST / PLACEHOLDER keys. Their seeds were destroyed. They MUST be
replaced before the first real release.** Release CI fails while any slot says `placeholder: true`.

1. Use an offline machine (no network adapter enabled), freshly booted, with full-disk encryption. A live USB of a
   current OS is fine. Copy a verified checkout of the tagged source and its `node_modules` onto it (or `npm ci` before
   disconnecting, then disconnect).
2. Prepare two encrypted removable media (for example two USB sticks with VeraCrypt or BitLocker To Go volumes, with
   different strong passphrases held by the maintainer and one named deputy).
3. Generate the **current** and **next** key sets, writing the seeds directly onto encrypted media:
   ```
   node tools/release/run.mjs gen-keys --out E:\vss-update-current.json --slot current
   node tools/release/run.mjs gen-keys --out E:\vss-update-next.json    --slot next
   ```
   Each command prints the public key block for `keys.ts` and a loud warning on stderr.
4. Copy each seed file to the second medium. Verify both copies by running `sign-manifest` on a scratch directory with
   `--allow-unembedded-key`, then `verify-release` after pasting the keys (step 5) in the scratch checkout.
5. Paste the printed public blocks into `src/main/update/keys.ts` (`current`, `next`), remove `placeholder: true` and
   the placeholder warning, commit through a reviewed pull request. Record the two key ids in the release notes.
6. Store the media in two physically separate, locked places. Never copy seeds to a networked machine, a password
   manager that syncs, CI secrets, chat, email or cloud storage. Wipe the offline machine's temp files and power off.

Lost keys: if both copies of `current` are lost but `next` survives, sign with `next` and rotate (section 5). If both
are lost, installed apps cannot be updated automatically; publish a manual-download release and announce it.

## 3. Release procedure

1. On `main`: bump `package.json` version (SemVer 2.0.0), update `CHANGELOG.md`, merge.
2. Tag and push: `git tag -s vX.Y.Z && git push origin vX.Y.Z` (tag must equal `v` + package.json version).
3. `.github/workflows/release.yml` runs on `windows-latest`: lint, typecheck, unit tests, `npm run dist` (NSIS +
   portable, `SOURCE_DATE_EPOCH` from the commit), CycloneDX SBOM, `SHA512SUMS`, and uploads everything to a
   **draft** release. It never publishes.
4. Download all draft assets (`gh release download vX.Y.Z --dir assets`) and move them to the offline machine.
5. Compare the `SHA512SUMS` you downloaded with `sha512sum` of the files (sanity check of the transfer).
6. Sign, with the seed medium mounted read-only:
   ```
   node tools/release/run.mjs sign-manifest --dir assets --version X.Y.Z --seeds F:\vss-update-current.json
   ```
   The tool refuses a key that is not embedded in `keys.ts` and self-verifies before writing.
7. Back online: upload the three new files to the draft:
   `gh release upload vX.Y.Z assets/release-manifest.json assets/release-manifest.sig.ed25519 assets/release-manifest.sig.mldsa65`
8. Independent re-verification from a clean directory (ideally by a second person):
   `gh release download vX.Y.Z --dir check && node tools/release/run.mjs verify-release --dir check --expect-version X.Y.Z`
9. Publish the draft in the GitHub UI. Never mark a release published before step 8 passes. Prereleases (`-rc.N`) are
   ignored by installed apps unless prerelease updates are enabled.

## 4. What installed apps do

- Check at most once per 24 h, only after unlock, only if **Settings > Updates > Check for updates** is on. When off,
  VSS makes no network connection at all for updates.
- `NetGate` is enabled only during the check or the download + manifest fetch, then disabled again. Hosts are limited
  to `api.github.com`, `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`, https only.
  electron-updater's own session is guarded by the same switch and allowlist.
- Never downloads or installs automatically. Any verification failure deletes the download and shows a
  "verification failed" state. The installer is re-hashed right before install.

## 5. Key rotation plan

- **Planned rotation (normal case).** Every release embeds `current` and `next`. To rotate: sign release N+1 with
  `next`; in that release, move `next` to `current` and embed a freshly generated `next` (ceremony section 2, `next`
  only). Retire the old `current` seeds by destroying both copies after release N+1 has been out long enough that no
  supported install depends on it (suggest 12 months), and record the date.
- **Cadence.** Rotate at least every 2 years, on suspicion of compromise, or when a maintainer with key access leaves.
- **Compromise of one slot.** Ship an emergency release signed with the other slot that drops the compromised one.
  Both algorithms must verify under the same slot, so one leaked algorithm key alone cannot sign a release.
- **Signed rotation statements (hook).** `verifyKeyRotation()` in `src/main/update/verify.ts` verifies a canonical
  `{"date","formatVersion":1,"newKeys":{id,ed25519,mldsa65},"purpose":"vss-key-rotation"}` statement signed by both
  algorithms of a trusted slot (ML-DSA context `VSS key rotation v1`). It is not yet wired into the service; when
  needed, the service can fetch `key-rotation.json` + signatures from a release, verify it, and persist the new key
  set as `next` inside the encrypted settings.

## 6. SignPath Foundation (free OSS code signing) application checklist

Authenticode signing removes most SmartScreen friction; it is complementary to (not a replacement for) the manifest
signatures above.

- [ ] Repository public with an OSI license (Apache-2.0), README stating purpose, maintainers listed.
- [ ] Builds are fully automated from source in GitHub Actions (`release.yml`), no manual build steps.
- [ ] No proprietary or closed components in the shipped binaries; SBOM attached to each release.
- [ ] Project has had releases and visible activity; security policy (`SECURITY.md`) in place.
- [ ] MFA enabled for all maintainers on GitHub; branch protection on `main`; tags signed.
- [ ] Code signing policy page drafted (who approves releases, what is signed).
- [ ] Apply at signpath.org (Foundation programme); after approval, add the SignPath GitHub action as a step that
      signs the build artefacts **before** `SHA512SUMS` and before the manifest is signed offline.
- [ ] Then set `publisherName` in `electron-builder.yml` so electron-updater also checks Authenticode.

## 7. First run on Windows (unsigned builds, SmartScreen)

Until builds are Authenticode-signed, Windows shows "Windows protected your PC".

1. Download the installer from the project's GitHub Releases page only.
2. Optional: verify it. In PowerShell: `Get-FileHash .\vss-X.Y.Z-x64-setup.exe -Algorithm SHA512` and compare with the
   line in `SHA512SUMS`; or run `verify-release` (section 1).
3. Double-click the installer. On the blue SmartScreen dialog click **More info**, check that the file name is the one
   you downloaded, then click **Run anyway**.
4. If the browser blocks the download, choose **Keep** (Edge: "..." > **Keep** > **Show more** > **Keep anyway**).
5. VSS installs per user (no admin rights) under `%LOCALAPPDATA%\Programs`. Later updates are verified by VSS itself.
