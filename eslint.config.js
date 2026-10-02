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
    // CLI entry points may print to the console.
    files: ['**/src/cli/**/*.ts', '**/src/seed.ts', '**/src/support-agent.ts', 'scripts/**'],
    rules: { 'no-console': 'off' },
  },
);
