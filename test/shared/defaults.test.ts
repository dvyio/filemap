import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

import { toCwdPath } from '@/paths/brands.js';
import {
  assertWorkingDirectory,
  resolveWorkingDirectory,
} from '@/shared/defaults.js';

import {
  createFixture,
  getNodeErrorCode,
  getThrownError,
  withWorkspace,
} from '../helpers.js';

describe('resolveWorkingDirectory', () => {
  test('returns process.cwd() when cwd is undefined', () => {
    expect(resolveWorkingDirectory(undefined)).toBe(process.cwd());
  });

  test('resolves a relative cwd to an absolute path', () => {
    expect(resolveWorkingDirectory('src')).toBe(resolve('src'));
  });

  test('rejects an empty cwd with the existing error message', () => {
    expect(() => resolveWorkingDirectory('')).toThrow(
      'Invalid cwd "" — expected a non-empty string path.',
    );
  });
});

describe('assertWorkingDirectory', () => {
  test('given cwd is missing, when checking it, then it uses the cwd code', async () => {
    await withWorkspace('filemap-defaults-', async (cwd) => {
      const missingCwd = `${cwd}/missing`;

      const error = await getThrownError(async () => {
        await assertWorkingDirectory(toCwdPath(missingCwd));
      });

      expect(error.message).toBe(
        `Invalid cwd "${missingCwd}" — expected an existing directory.`,
      );
    });
  });

  test('given cwd has a file parent, when checking it, then preserves the filesystem cause', async () => {
    await withWorkspace('filemap-defaults-', async (cwd) => {
      await createFixture(cwd, 'not-a-directory', 'file\n');
      const invalidCwd = `${cwd}/not-a-directory/child`;

      const error = await getThrownError(async () => {
        await assertWorkingDirectory(toCwdPath(invalidCwd));
      });

      expect(error.message).toBe(
        `Failed to inspect cwd "${invalidCwd}" — check that the path is readable.`,
      );
      expect(error.cause).toBeInstanceOf(Error);

      if (!(error.cause instanceof Error)) {
        throw new Error('Expected cwd failure cause to be an Error.');
      }

      expect(getNodeErrorCode(error.cause)).toBe('ENOTDIR');
    });
  });
});
