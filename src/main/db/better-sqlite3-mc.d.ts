/* eslint-disable @typescript-eslint/consistent-type-imports -- ambient module: import() types are the only way in */
// The package ships index.d.ts but its package.json "exports" hides it from TypeScript's Bundler resolution
// (TS7016). Re-expose the bundled typings under the package name.
declare module 'better-sqlite3-multiple-ciphers' {
  type Bundled = typeof import('../../../node_modules/better-sqlite3-multiple-ciphers/index');
  const Database: Bundled;
  namespace Database {
    type Database = import('../../../node_modules/better-sqlite3-multiple-ciphers/index').Database;
    type Statement = import('../../../node_modules/better-sqlite3-multiple-ciphers/index').Statement;
    type RunResult = import('../../../node_modules/better-sqlite3-multiple-ciphers/index').RunResult;
  }
  export default Database;
}
