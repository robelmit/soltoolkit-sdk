/**
 * Lint rules for the whole repo, in one flat config at the root.
 *
 * Lint is here to catch what the typecheck cannot: an unused binding left by a
 * half-finished rename, an empty catch, a stray console.log in library code.
 * Rules are errors, not warnings: a warning in CI is a rule nobody obeys.
 */

import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/.turbo/**', '**/*.d.ts', 'indexer/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx,mts,cts,mjs,cjs,js}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.es2024 },
    },
  },

  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-empty': ['error', { allowEmptyCatch: false }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // Libraries do not print. Apps and examples do (see below).
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  {
    // Tests build deliberately wrong shapes and print live results.
    files: ['**/test/**', '**/*.test.{ts,tsx}'],
    rules: { '@typescript-eslint/no-explicit-any': 'off', 'no-console': 'off' },
  },

  {
    // Apps, examples, scripts and config files are run by hand or as daemons; printing is their output.
    files: ['apps/**', 'examples/**', '**/scripts/**', '**/*.config.{ts,mjs,js}'],
    rules: { 'no-console': 'off' },
  },

  {
    // Browser code (the holder map viewer and the page of its example) also gets DOM globals.
    files: ['packages/holder-map-react/**/*.{ts,tsx}', 'examples/holder-map-viewer/**/*.tsx'],
    languageOptions: { globals: { ...globals.browser } },
  },
);
