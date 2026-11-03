# Notes: encrypted SQLite (better-sqlite3-multiple-ciphers)

Verified 2026-11-03 with `better-sqlite3-multiple-ciphers` 13.0.3, Node 24.22.1 and Electron 45.2.1 (`npm run probe:sqlite`
runs `tools/sqlite-probe.cjs` under plain Node; run it under Electron with
`node_modules/electron/dist/electron.exe tools/sqlite-probe.cjs`).

## No native rebuild needed
The package ships N-API (`node-addon-api`) prebuilds for win32-x64/arm64 in `prebuilds/`, so one binary works under Node
and under every Electron version; `electron-rebuild` is not required and `.npmrc` keeps `ignore-scripts=true`.
For packaging, `electron-builder.yml` unpacks `node_modules/better-sqlite3-multiple-ciphers/{prebuilds,lib}` from the asar
and sets `npmRebuild: false`.

## Pragma sequence (raw 32-byte key, ChaCha20-Poly1305 page encryption)
```js
const db = new Database(file);
db.pragma("cipher='chacha20'");        // 1. select cipher BEFORE the key
db.pragma(`key="x'${keyHex64}'"`);     // 2. raw key: x'' + 64 hex chars (32 bytes); no KDF is applied to it
// 3. first real statement (e.g. CREATE TABLE or SELECT) validates the key; a wrong key throws "file is not a database"
db.pragma('foreign_keys = ON');        // 4. regular pragmas after the key
```
Observations
- Reopening needs the same two pragmas in the same order on every connection.
- Wrong key: the first statement throws; the DB header is not readable without the key (no plaintext marker found in the file).
- FTS5 with `tokenize='trigram'` works on the encrypted DB (the DEK is random, so use the raw-key form, not a passphrase).
- Close the connection and overwrite the key buffer (`buf.fill(0)`) on lock; build the pragma string transiently.
- `PRAGMA rekey="x'<hex>'"` works on an open WAL-mode connection (verified 2026-11-03, 3.53.4): every page is
  re-encrypted, the open connection keeps working, and only the new key opens the file afterwards. A password change
  rotates the DEK and re-keys the DB this way (security review F-03; tests/security/password-rotation.test.ts).
- VERIFY: atomicity of `PRAGMA rekey` under a power cut in WAL mode. VSS does not rely on it: the rotation keeps both
  DEKs recoverable (`vault.json.rotation`) and decides at the next unlock with `PRAGMA quick_check` which key the file
  is under.
