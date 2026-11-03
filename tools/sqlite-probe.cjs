// Probe: create + reopen an encrypted DB with a raw 32-byte key (chacha20). Runs under Node and Electron main.
// Usage: node tools/sqlite-probe.cjs   |   ELECTRON_RUN_AS_NODE unset: electron tools/sqlite-probe.cjs
const Database = require('better-sqlite3-multiple-ciphers');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vss-probe-'));
const file = path.join(dir, 'probe.db');
const keyHex = crypto.randomBytes(32).toString('hex');
const SECRET = 'SYNTHETIC-PLAINTEXT-MARKER-12345';
const out = {
  runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.versions.node}`,
};

function open(keyHexValue) {
  const db = new Database(file);
  db.pragma("cipher='chacha20'");
  db.pragma(`key="x'${keyHexValue}'"`);
  return db;
}
let db = open(keyHex);
db.exec('CREATE TABLE t(a TEXT); CREATE VIRTUAL TABLE s USING fts5(b, tokenize="trigram");');
db.prepare('INSERT INTO t VALUES (?)').run(SECRET);
db.prepare('INSERT INTO s VALUES (?)').run(SECRET);
out.ftsHit = db.prepare("SELECT count(*) c FROM s WHERE s MATCH 'MARKER'").get().c;
db.close();
out.fileHasPlaintext = fs.readFileSync(file).includes(Buffer.from(SECRET));
db = open(keyHex);
out.reopen = db.prepare('SELECT a FROM t').get().a === SECRET;
db.close();
try {
  db = open(crypto.randomBytes(32).toString('hex'));
  db.prepare('SELECT a FROM t').get();
  out.wrongKeyRejected = false;
} catch {
  out.wrongKeyRejected = true;
}
try {
  db.close();
} catch {
  /* already closed */
}
console.log(JSON.stringify(out));
fs.rmSync(dir, { recursive: true, force: true });
if (process.versions.electron) require('electron').app.quit();
