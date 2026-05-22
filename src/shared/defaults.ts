/** @fileoverview Defines discovery defaults and resolves working directories */

import { resolve } from 'node:path';

import {
  assertSafeUserPathString,
  type CwdPath,
  toCwdPath,
} from '@/paths/brands.js';
import { readPathStatsIfExists } from '@/paths/scope.js';
import { formatInvalidValueMessage } from '@/shared/error-format.js';
import { validateNonEmptyString } from '@/shared/validation.js';

export const DEFAULT_EXTENSIONS = [
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'php',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'swift',
  'kt',
] as const;

export const DEFAULT_INCLUDE_PATTERNS = [
  `**/*.{${DEFAULT_EXTENSIONS.join(',')}}`,
] as const;

export const HARD_EXCLUDE_PATTERNS = [
  '**/node_modules/**',
  '**/vendor/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.cache/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.turbo/**',
  '**/.agent-batch/**',
  '**/.git/**',
  '**/coverage/**',
] as const;

export const EXCLUDE_GROUPS = {
  config: {
    defaultOn: false,
    patterns: ['**/*.config.*'],
  },
  fixtures: {
    defaultOn: true,
    patterns: [
      '**/__fixtures__/**',
      '**/__mocks__/**',
      '**/__snapshots__/**',
      '**/fixtures/**',
    ],
  },
  generated: {
    defaultOn: true,
    patterns: ['**/*.generated.*', '**/__generated__/**'],
  },
  locks: {
    defaultOn: true,
    patterns: [
      '**/package-lock.json',
      '**/pnpm-lock.yaml',
      '**/yarn.lock',
      '**/bun.lock',
      '**/bun.lockb',
      '**/composer.lock',
      '**/Gemfile.lock',
      '**/Cargo.lock',
      '**/go.sum',
      '**/poetry.lock',
      '**/Pipfile.lock',
    ],
  },
  migrations: {
    defaultOn: false,
    patterns: ['**/migrations/**'],
  },
  stories: {
    defaultOn: true,
    patterns: ['**/.storybook/**', '**/stories/**', '**/*.stories.*'],
  },
  tests: {
    defaultOn: true,
    patterns: [
      '**/*.test.*',
      '**/*.spec.*',
      '**/__tests__/**',
      '**/test/**',
      '**/tests/**',
      '**/e2e/**',
      '**/cypress/**',
      '**/playwright/**',
    ],
  },
  types: {
    defaultOn: true,
    patterns: ['**/*.d.ts'],
  },
} as const;

export const EXCLUDE_GROUP_ORDER = [
  'tests',
  'fixtures',
  'generated',
  'stories',
  'locks',
  'types',
  'config',
  'migrations',
] as const satisfies readonly (keyof typeof EXCLUDE_GROUPS)[];

type MissingOrderedExcludeGroups = Exclude<
  keyof typeof EXCLUDE_GROUPS,
  (typeof EXCLUDE_GROUP_ORDER)[number]
>;

assertExcludeGroupOrderCoverage<MissingOrderedExcludeGroups>();

/**
 * Resolves the working directory used by discovery operations.
 *
 * @param cwd - Optional directory override from the caller.
 * @param baseCwd - Directory used to resolve relative cwd values.
 * @returns The absolute working directory path to use for file operations.
 */
export function resolveWorkingDirectory(
  cwd: unknown,
  baseCwd = process.cwd(),
): CwdPath {
  if (cwd === undefined) {
    return toCwdPath(baseCwd);
  }

  const trimmedCwd = validateNonEmptyString(
    cwd,
    'cwd',
    'a non-empty string path',
  ).trim();

  assertSafeUserPathString(trimmedCwd, 'cwd');

  return toCwdPath(resolve(baseCwd, trimmedCwd));
}

/**
 * Checks that the resolved working directory exists before discovery runs.
 *
 * @param cwd - Absolute working directory path from `resolveWorkingDirectory`.
 */
export async function assertWorkingDirectory(cwd: CwdPath): Promise<void> {
  const cwdStats = await readPathStatsIfExists(cwd, 'cwd', cwd);

  if (cwdStats === undefined || !cwdStats.isDirectory()) {
    throw new Error(
      formatInvalidValueMessage('cwd', cwd, 'an existing directory'),
    );
  }
}

function assertExcludeGroupOrderCoverage<TMissing extends never>(
  ..._missingGroups: readonly TMissing[]
): void {}
