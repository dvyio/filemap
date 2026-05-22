/** @fileoverview Enforces TypeScript, import ordering, and local safety rules */

import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import n from 'eslint-plugin-n';
import perfectionist from 'eslint-plugin-perfectionist';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';
import typescript from 'typescript-eslint';

import localPlugin from './eslint-rules/index.js';

export default typescript.config(
  js.configs.recommended,
  ...typescript.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      local: localPlugin,
      n,
      'unused-imports': unusedImports,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': 'off',
      'local/no-unsafe-path-brand-casts': 'error',
      'local/require-caught-error-cause': 'error',
      'no-duplicate-imports': 'error',
      'prefer-promise-reject-errors': 'error',
      'preserve-caught-error': ['error', { requireCatchParameter: true }],
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/git/ignore.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              message:
                'Run child processes through src/git/ignore.ts so timeouts and output checks stay in one place.',
              name: 'node:child_process',
            },
            {
              message:
                'Run child processes through src/git/ignore.ts so timeouts and output checks stay in one place.',
              name: 'child_process',
            },
          ],
        },
      ],
      'no-restricted-imports': 'off',
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/cli.ts', 'src/cli/cli-reporting.ts'],
    rules: {
      'no-console': 'error',
      'no-restricted-syntax': [
        'error',
        {
          message: 'Route stdout through src/cli/cli-reporting.ts.',
          selector:
            'CallExpression[callee.type="MemberExpression"][callee.property.name="write"][callee.object.type="MemberExpression"][callee.object.object.name="process"][callee.object.property.name="stdout"]',
        },
        {
          message: 'Route stdout through src/cli/cli-reporting.ts.',
          selector:
            'CallExpression[callee.type="MemberExpression"][callee.property.name="write"][callee.object.type="MemberExpression"][callee.object.object.name="process"][callee.object.property.value="stdout"]',
        },
        {
          message: 'Route stderr through src/cli/cli-reporting.ts.',
          selector:
            'CallExpression[callee.type="MemberExpression"][callee.property.name="write"][callee.object.type="MemberExpression"][callee.object.object.name="process"][callee.object.property.name="stderr"]',
        },
        {
          message: 'Route stderr through src/cli/cli-reporting.ts.',
          selector:
            'CallExpression[callee.type="MemberExpression"][callee.property.name="write"][callee.object.type="MemberExpression"][callee.object.object.name="process"][callee.object.property.value="stderr"]',
        },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/git/ignore.ts'],
    rules: {
      'n/no-process-env': 'error',
    },
  },
  {
    files: [
      '*.config.ts',
      'eslint-rules/**/*.js',
      'eslint.config.mjs',
      'scripts/**/*.mjs',
      'src/**/*.ts',
      'test/**/*.ts',
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.js.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],
      '@typescript-eslint/strict-boolean-expressions': 'error',
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'error',
    },
  },
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    plugins: {
      perfectionist,
    },
    rules: {
      'perfectionist/sort-enums': [
        'error',
        {
          ignoreCase: true,
          order: 'asc',
          partitionByNewLine: true,
          type: 'alphabetical',
        },
      ],
      'perfectionist/sort-imports': [
        'error',
        {
          groups: [
            'type-import',
            ['value-builtin', 'value-external'],
            'type-internal',
            'value-internal',
            ['type-parent', 'type-sibling', 'type-index'],
            ['value-parent', 'value-sibling', 'value-index'],
            'ts-equals-import',
            'unknown',
          ],
          ignoreCase: true,
          newlinesBetween: 1,
          order: 'asc',
          type: 'alphabetical',
        },
      ],
      'perfectionist/sort-interfaces': [
        'error',
        {
          ignoreCase: true,
          order: 'asc',
          partitionByNewLine: true,
          type: 'alphabetical',
        },
      ],
      'perfectionist/sort-intersection-types': [
        'error',
        {
          ignoreCase: true,
          order: 'asc',
          type: 'alphabetical',
        },
      ],
      'perfectionist/sort-named-exports': [
        'error',
        {
          ignoreCase: true,
          order: 'asc',
          type: 'alphabetical',
        },
      ],
      'perfectionist/sort-named-imports': [
        'error',
        {
          ignoreCase: true,
          order: 'asc',
          type: 'alphabetical',
        },
      ],
      'perfectionist/sort-object-types': [
        'error',
        {
          ignoreCase: true,
          order: 'asc',
          partitionByNewLine: true,
          type: 'alphabetical',
        },
      ],
      'perfectionist/sort-objects': [
        'error',
        {
          ignoreCase: true,
          order: 'asc',
          partitionByNewLine: true,
          type: 'alphabetical',
        },
      ],
      'perfectionist/sort-union-types': [
        'error',
        {
          ignoreCase: true,
          order: 'asc',
          type: 'alphabetical',
        },
      ],
    },
  },
  {
    ignores: ['coverage', 'dist', 'node_modules'],
  },
  prettier,
);
