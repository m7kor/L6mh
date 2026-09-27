// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Globals available in the Node runtime (server, tooling, tests). */
const nodeGlobals = {
  console: 'readonly',
  process: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  queueMicrotask: 'readonly',
  structuredClone: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  fetch: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
};

/** Globals available in the browser (the served dashboard pages). */
const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  EventSource: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  localStorage: 'readonly',
  Node: 'readonly',
  HTMLElement: 'readonly',
  Event: 'readonly',
  CustomEvent: 'readonly',
  MutationObserver: 'readonly',
};

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'data/**',
      'logs/**',
      'public/js/**/*.test.js',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ---- Server / TypeScript sources -------------------------------------
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules: {
      // The Discord client and stream handles are genuinely dynamic; the code
      // annotates those with `any` deliberately rather than scattering casts.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',

      // Correctness rules that catch real defects.
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-unreachable': 'error',
      'no-fallthrough': 'error',
      'no-dupe-keys': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': 'error',
      'no-return-await': 'error',

      // Best-effort teardown legitimately swallows errors. An empty `catch {}`
      // is idiomatic for that, but an empty *branch* (`if (x) {}`) is a bug,
      // so `no-empty` stays on for everything except catch blocks.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // ---- Browser code ----------------------------------------------------
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: browserGlobals,
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },

  // ---- CommonJS + node-style test files -------------------------------
  {
    files: ['**/*.cjs', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...nodeGlobals, module: 'writable', require: 'readonly', jsdom: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      'no-empty': 'off',
    },
  },

  // ---- Tests -----------------------------------------------------------
  {
    files: ['**/*.test.ts', 'tests/**/*.js'],
    rules: {
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-empty': 'off',
    },
  },
);
