import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Modules that open sockets / do network I/O. Only src/main/net/NetGate.ts may import them. */
const NET_MODULES = [
  'net',
  'http',
  'https',
  'http2',
  'tls',
  'dgram',
  'dns',
  'dns/promises',
  'ws',
  'undici',
  'axios',
  'node-fetch',
  'got',
  'superagent',
  'request',
  'electron-updater',
  'socket.io',
  'socket.io-client',
  'bonjour',
  'bonjour-service',
  'multicast-dns',
].flatMap((m) => [m, `node:${m}`]);

const netPaths = [
  ...NET_MODULES.map((name) => ({
    name,
    message: 'Network APIs may only be imported by src/main/net/NetGate.ts.',
  })),
  {
    name: 'electron',
    importNames: ['net', 'autoUpdater'],
    message: 'electron net/autoUpdater may only be imported by src/main/net/NetGate.ts.',
  },
];

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**', 'coverage/**', 'test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } },
    rules: {
      'no-restricted-imports': ['error', { paths: netPaths }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Use NetGate.' },
        { name: 'XMLHttpRequest', message: 'Use NetGate.' },
        { name: 'WebSocket', message: 'Use NetGate.' },
        { name: 'EventSource', message: 'Use NetGate.' },
      ],
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['src/main/net/NetGate.ts'],
    rules: { 'no-restricted-imports': 'off', 'no-restricted-globals': 'off' },
  },
  {
    files: ['tools/**/*.{js,cjs,mjs}'],
    languageOptions: { globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
