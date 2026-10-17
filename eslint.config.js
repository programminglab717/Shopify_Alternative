// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/.turbo/**', '**/node_modules/**', 'docs/**'],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Packages are consumed only through their public entry points (package.json "exports").
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@hatti/*/src/*', '@hatti/*/dist/*', '@hatti/*/internal/*'],
              message: 'Import other packages through their public entry point only.',
            },
          ],
        },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
    },
  },
  {
    // Themes' scripts run in shoppers' browsers, as classic scripts.
    files: ['themes/**/assets/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
  },
  {
    // CLI entry points may print to the console.
    files: [
      '**/src/cli/**/*.ts',
      '**/src/seed.ts',
      '**/src/support-agent.ts',
      '**/src/partner-payouts.ts',
      '**/src/vapid-keys.ts',
      '**/src/email-suppression.ts',
      '**/src/billing-transfers.ts',
      '**/src/support-requests.ts',
      '**/src/courier-cities.ts',
      '**/src/status-incidents.ts',
      '**/src/trust-reports.ts',
      'scripts/**',
    ],
    rules: { 'no-console': 'off' },
  },
);
