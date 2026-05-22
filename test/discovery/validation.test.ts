import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { discoverFiles } from '@/discovery/index.js';
import { validateMaxFiles } from '@/shared/max-files.js';

import {
  createFixture,
  getNodeErrorCode,
  getThrownError,
  withWorkspace,
} from '../helpers.js';

describe('discoverFiles validation', () => {
  test('given discovered files exceed maxFiles, when discovering, then it fails with the count and limit', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/a.ts');
      await createFixture(cwd, 'src/b.ts');
      await createFixture(cwd, 'src/c.ts');

      await expect(
        discoverFiles({ cwd, maxFiles: validateMaxFiles(2) }),
      ).rejects.toThrow(
        'Filemap found 3 discovered or visible files before Git ignore filtering, which exceeds the max-files limit of 2. Re-run with --max-files 3 or narrow [scope], --include, or --exclude.',
      );
    });
  });

  test('given cwd is missing, when discovering, then it wraps the discovery failure', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      const missingCwd = join(cwd, 'missing');

      await expect(discoverFiles({ cwd: missingCwd })).rejects.toThrow(
        `Failed to discover files in cwd "${missingCwd}" — check that the directory exists and the glob patterns are valid.`,
      );
    });
  });

  test('rejects negated include patterns with the expected pattern shape', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await expect(
        discoverFiles({ cwd, include: ['!src/private/**'] }),
      ).rejects.toThrow(
        'Invalid include pattern "!src/private/**" — expected a repo-relative glob pattern without a leading "!". Remove the leading "!".',
      );
    });
  });

  test.each(['../x/**', 'foo/../../x/**', '*/../x/**'])(
    'given include pattern %s escapes the repo, when discovering, then rejects it',
    async (pattern) => {
      await withWorkspace('filemap-discover-', async (cwd) => {
        await expect(
          discoverFiles({ cwd, include: [pattern] }),
        ).rejects.toThrow(
          `Invalid include pattern "${pattern}" — expected a repo-relative glob pattern.`,
        );
      });
    },
  );

  test('rejects control characters in include patterns before discovery', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await expect(
        discoverFiles({ cwd, include: ['src/\r*.ts'] }),
      ).rejects.toThrow(
        'Invalid include pattern "src/\\u000d*.ts" — expected a glob pattern without control characters.',
      );
    });
  });

  test('discovers only the requested extensions when ext is provided', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/app.ts');
      await createFixture(cwd, 'src/util.py');
      await createFixture(cwd, 'src/styles.css');

      await expect(discoverFiles({ cwd, ext: ['ts', 'py'] })).resolves.toEqual([
        'src/app.ts',
        'src/util.py',
      ]);
    });
  });

  test('strips a leading dot from extension values', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/app.ts');
      await createFixture(cwd, 'src/styles.css');

      await expect(discoverFiles({ cwd, ext: ['.ts'] })).resolves.toEqual([
        'src/app.ts',
      ]);
    });
  });

  test('trims whitespace around extension values', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/app.ts');
      await createFixture(cwd, 'src/styles.css');

      await expect(discoverFiles({ cwd, ext: [' ts '] })).resolves.toEqual([
        'src/app.ts',
      ]);
    });
  });

  test('rejects extension values that normalize to an empty string', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await expect(discoverFiles({ cwd, ext: [' . '] })).rejects.toThrow(
        'Invalid ext " . " — expected a non-empty file extension like "ts" or "kt".',
      );
    });
  });

  test('rejects an empty extension list', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await expect(discoverFiles({ cwd, ext: [] })).rejects.toThrow(
        'Invalid ext "" — expected a non-empty array of file extensions like "ts" or "kt".',
      );
    });
  });

  test('rejects glob extension values', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await expect(discoverFiles({ cwd, ext: ['*'] })).rejects.toThrow(
        'Invalid ext "*" — expected a literal file extension like "ts" or "kt".',
      );
    });
  });

  test('rejects comma-separated extension values', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await expect(discoverFiles({ cwd, ext: ['ts,js'] })).rejects.toThrow(
        'Invalid ext "ts,js" — expected a literal file extension like "ts" or "kt".',
      );
    });
  });

  test('accepts literal extension values', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/app.ts');
      await createFixture(cwd, 'src/component.tsx');
      await createFixture(cwd, 'src/config.cjs');
      await createFixture(cwd, 'src/Main.kt');
      await createFixture(cwd, 'src/style.css');

      await expect(
        discoverFiles({ cwd, ext: ['ts', '.tsx', 'cjs', 'kt'] }),
      ).resolves.toEqual([
        'src/Main.kt',
        'src/app.ts',
        'src/component.tsx',
        'src/config.cjs',
      ]);
    });
  });

  test('combines scope and ext filtering', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/auth/login.ts');
      await createFixture(cwd, 'src/auth/helper.py');
      await createFixture(cwd, 'src/app.ts');

      await expect(
        discoverFiles({ cwd, ext: ['ts'], scope: 'src/auth' }),
      ).resolves.toEqual(['src/auth/login.ts']);
    });
  });

  test('rejects negated exclude patterns with the expected pattern shape', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await expect(
        discoverFiles({ cwd, exclude: ['!src/private/**'] }),
      ).rejects.toThrow(
        'Invalid exclude pattern "!src/private/**" — expected a repo-relative glob pattern without a leading "!". Remove the leading "!".',
      );
    });
  });

  test('rejects an invalid group name in includeGroups', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/app.ts');

      await expect(
        discoverFiles({ cwd, includeGroups: ['test'] }),
      ).rejects.toThrow(
        'Invalid group "test" — expected one of: tests, fixtures, generated, stories, locks, types, config, migrations.',
      );
    });
  });

  test('trims accidental whitespace from group names', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/app.ts');
      await createFixture(cwd, 'src/app.test.ts');

      await expect(
        discoverFiles({ cwd, includeGroups: [' tests '] }),
      ).resolves.toEqual(['src/app.test.ts', 'src/app.ts']);
    });
  });

  test('rejects an empty group name before matching groups', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/app.ts');

      await expect(discoverFiles({ cwd, includeGroups: [''] })).rejects.toThrow(
        'Invalid includeGroups value "" — expected a non-empty group name.',
      );
    });
  });

  test('rejects an invalid group name in excludeGroups', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/app.ts');

      await expect(
        discoverFiles({ cwd, excludeGroups: ['invalid'] }),
      ).rejects.toThrow(
        'Invalid group "invalid" — expected one of: tests, fixtures, generated, stories, locks, types, config, migrations.',
      );
    });
  });

  test('rejects parent-escaping scoped include patterns before discovery', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/auth/app.ts');

      await expect(
        discoverFiles({
          cwd,
          include: ['../secret/**'],
          scope: 'src/auth',
        }),
      ).rejects.toThrow(
        'Invalid include pattern "../secret/**" — expected a repo-relative glob pattern.',
      );
    });
  });

  test('throws when scope does not exist', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await expect(
        discoverFiles({ cwd, scope: 'missing/path' }),
      ).rejects.toThrow(
        'Invalid scope "missing/path" — expected an existing file or directory relative to cwd',
      );
    });
  });

  test('given scope has a file parent, when discovering, then preserves the filesystem cause', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'not-a-directory', 'file\n');

      const error = await getThrownError(async () => {
        await discoverFiles({ cwd, scope: 'not-a-directory/child' });
      });

      expect(error.message).toBe(
        'Failed to inspect scope "not-a-directory/child" — check that the path is readable.',
      );
      expect(getNodeErrorCode(error.cause)).toBe('ENOTDIR');
    });
  });

  test('rejects parent traversal scope before reading the file system', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await expect(discoverFiles({ cwd, scope: '..' })).rejects.toThrow(
        'Invalid scope ".." — expected "." for the repository root or a relative child path.',
      );
    });
  });

  test('rejects unsafe control characters in scope before reading the file system', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await expect(
        discoverFiles({ cwd, scope: 'src/\u001bapp' }),
      ).rejects.toThrow(
        'Invalid scope "src/\\u001bapp" — expected a path without control characters.',
      );
    });
  });
});
