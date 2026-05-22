/** @fileoverview Runs tests in Node and checks coverage thresholds */

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const sourceRoot = fileURLToPath(new URL('src', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': sourceRoot,
    },
  },
  test: {
    coverage: {
      include: ['src/**/*.ts', 'eslint-rules/**/*.js'],
      provider: 'v8',
      reporter: ['text'],
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
    environment: 'node',
    fileParallelism: true,
    globals: false,
  },
});
