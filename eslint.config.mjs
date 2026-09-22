import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores([
    'web/dist/',
    'web/public/wasm/',
    'bin/',
    'test-results/',
    'playwright-report/',
    '.wrangler/',
  ]),
  {
    files: ['**/*.{js,mjs,ts}'],
    extends: [js.configs.recommended],
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: { 'no-unused-vars': ['error', { ignoreRestSiblings: true }] },
  },
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  {
    files: ['web/src/**/*.ts'],
    ignores: ['web/src/worker.ts'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['web/src/worker.ts'],
    languageOptions: { globals: globals.worker },
  },
  {
    files: ['*.mjs', 'scripts/**/*.mjs', '*.config.ts', 'web/*.config.ts', 'tests/**/*.{ts,mjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    // Playwright's page.evaluate callbacks execute in the browser.
    files: ['scripts/smoke-deployment.mjs', 'tests/browser/**/*.ts'],
    languageOptions: { globals: globals.browser },
  },
]);
