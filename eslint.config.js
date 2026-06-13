// ESLint Flat Config — bewusst minimal: eslint:recommended, kein Stil-Linting.
// Node/CommonJS für den Server, Browser-Globals für public/ und Service Worker.
const js = require('@eslint/js');

const nodeGlobals = {
  require: 'readonly', module: 'writable', exports: 'writable',
  process: 'readonly', console: 'readonly', __dirname: 'readonly',
  __filename: 'readonly', Buffer: 'readonly', setTimeout: 'readonly',
  clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  setImmediate: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
  fetch: 'readonly', AbortController: 'readonly', structuredClone: 'readonly',
  TextEncoder: 'readonly', TextDecoder: 'readonly', performance: 'readonly',
};

const browserGlobals = {
  window: 'readonly', document: 'readonly', navigator: 'readonly',
  location: 'readonly', localStorage: 'readonly', sessionStorage: 'readonly',
  fetch: 'readonly', WebSocket: 'readonly', console: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
  clearInterval: 'readonly', requestAnimationFrame: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly', alert: 'readonly',
  confirm: 'readonly', prompt: 'readonly', history: 'readonly',
  CustomEvent: 'readonly', AbortController: 'readonly', performance: 'readonly',
  caches: 'readonly', self: 'readonly', CSS: 'readonly',
  // Vendor-Libs (per <script> geladen)
  ForceGraph3D: 'readonly', markdownit: 'readonly', THREE: 'readonly',
};

module.exports = [
  js.configs.recommended,
  {
    ignores: ['node_modules/**', 'data/**', 'logs/**', 'public/vendor/**'],
  },
  {
    files: ['**/*.js'],
    ignores: ['public/**'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: nodeGlobals,
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: browserGlobals,
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
];
