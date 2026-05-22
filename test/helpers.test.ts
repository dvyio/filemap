import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  createFixture,
  getNodeErrorCode,
  getThrownError,
  withWorkspace,
} from './helpers.js';

describe('createFixture', () => {
  test('rejects fixture paths outside the temp workspace', async () => {
    await withWorkspace('filemap-helpers-', async (cwd) => {
      const outsideFileName = `${basename(cwd)}-outside.ts`;
      const outsidePath = join(cwd, '..', outsideFileName);
      const error = await getThrownError(async () => {
        await createFixture(cwd, `../${outsideFileName}`, 'leak\n');
      });

      expect(error.message).toBe(
        `Invalid fixture path "../${outsideFileName}" — expected a path inside workspace "${cwd}".`,
      );
      await expect(stat(outsidePath)).rejects.toSatisfy(
        (statError: unknown) => {
          return getNodeErrorCode(statError) === 'ENOENT';
        },
      );
    });
  });
});
