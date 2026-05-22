import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { discoverFiles } from '@/discovery/index.js';

import {
  createFixture,
  getNodeErrorCode,
  getThrownError,
  initializeGitRepository,
  withMockedFsPromises,
  withWorkspace,
} from '../helpers.js';

describe('discoverFiles', () => {
  test('returns supported source files from a mixed workspace in sorted order', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/app.ts');
      await createFixture(cwd, 'lib/util.py');
      await createFixture(cwd, 'main.go');
      await createFixture(cwd, 'styles/main.css');
      await createFixture(cwd, 'README.md');

      await expect(discoverFiles({ cwd })).resolves.toEqual([
        'lib/util.py',
        'main.go',
        'src/app.ts',
      ]);
    });
  });

  test('discovers .mjs, .cjs, .mts, and .cts files by default', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/app.mjs');
      await createFixture(cwd, 'src/config.cjs');
      await createFixture(cwd, 'src/types.mts');
      await createFixture(cwd, 'src/utils.cts');
      await createFixture(cwd, 'src/main.ts');

      await expect(discoverFiles({ cwd })).resolves.toEqual([
        'src/app.mjs',
        'src/config.cjs',
        'src/main.ts',
        'src/types.mts',
        'src/utils.cts',
      ]);
    });
  });

  test('filters results to a subtree when scope is a directory', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/auth/login.ts');
      await createFixture(cwd, 'src/auth/signup.ts');
      await createFixture(cwd, 'src/authz/index.ts');
      await createFixture(cwd, 'src/app.ts');

      await expect(discoverFiles({ cwd, scope: 'src/auth' })).resolves.toEqual([
        'src/auth/login.ts',
        'src/auth/signup.ts',
      ]);
    });
  });

  test('normalizes equivalent directory scope spellings', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/auth/login.ts');
      await createFixture(cwd, 'src/app.ts');

      await expect(
        discoverFiles({ cwd, scope: './src/auth/' }),
      ).resolves.toEqual(['src/auth/login.ts']);
    });
  });

  test('filters results to a single file when scope is a file', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/auth/login.ts');
      await createFixture(cwd, 'src/auth/signup.ts');

      await expect(
        discoverFiles({ cwd, scope: 'src/auth/login.ts' }),
      ).resolves.toEqual(['src/auth/login.ts']);
    });
  });

  test('given a root file scope, when discovering, then it does not walk sibling files', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'root.ts');

      for (let index = 0; index < 20; index += 1) {
        await createFixture(cwd, `sibling-${String(index)}.ts`);
      }

      let opendirCalls = 0;

      await withMockedFsPromises(
        (actualFs) => {
          return {
            opendir: async (
              path: Parameters<typeof actualFs.opendir>[0],
              options?: Parameters<typeof actualFs.opendir>[1],
            ): Promise<Awaited<ReturnType<typeof actualFs.opendir>>> => {
              opendirCalls += 1;
              return actualFs.opendir(path, options);
            },
          };
        },
        async () => {
          const { discoverFiles: discoverFilesWithMockedFs } =
            await import('@/discovery/index.js');

          await expect(
            discoverFilesWithMockedFs({ cwd, scope: 'root.ts' }),
          ).resolves.toEqual(['root.ts']);
          expect(opendirCalls).toBe(0);
        },
      );
    });
  });

  test('given a nested file scope, when discovering, then it only checks the scoped file', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/index.ts');

      for (let index = 0; index < 20; index += 1) {
        await createFixture(cwd, `src/feature-${String(index)}.ts`);
        await createFixture(cwd, `src/nested/deep-${String(index)}.ts`);
      }

      let opendirCalls = 0;

      await withMockedFsPromises(
        (actualFs) => ({
          opendir: async (
            path: Parameters<typeof actualFs.opendir>[0],
            options?: Parameters<typeof actualFs.opendir>[1],
          ): Promise<Awaited<ReturnType<typeof actualFs.opendir>>> => {
            opendirCalls += 1;
            return actualFs.opendir(path, options);
          },
        }),
        async () => {
          const { discoverFiles: discoverFilesWithMockedFs } =
            await import('@/discovery/index.js');

          await expect(
            discoverFilesWithMockedFs({ cwd, scope: 'src/index.ts' }),
          ).resolves.toEqual(['src/index.ts']);
          expect(opendirCalls).toBe(0);
        },
      );
    });
  });

  test('treats repo-root scope as an unscoped run', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/app.ts');
      await createFixture(cwd, 'src/lib.ts');

      await expect(discoverFiles({ cwd, scope: '.' })).resolves.toEqual([
        'src/app.ts',
        'src/lib.ts',
      ]);
    });
  });

  test('respects root gitignore patterns without recursive ignore-file discovery', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(
        cwd,
        '.gitignore',
        '/storage/**\n!/storage/**/*.gitignore\n/public/build\n',
      );
      await createFixture(cwd, 'public/build/app.js');
      await createFixture(cwd, 'src/app.ts');
      await createFixture(cwd, 'storage/app/private.ts');

      await expect(discoverFiles({ cwd })).resolves.toEqual(['src/app.ts']);
    });
  });

  test('given root gitignore hides every candidate, when discovering, then it returns no files', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, '.gitignore', '*.ts\n');
      await createFixture(cwd, 'src/app.ts');

      await expect(discoverFiles({ cwd })).resolves.toEqual([]);
    });
  });

  test('respects nested gitignore patterns in Git workspaces', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      initializeGitRepository(cwd);
      await createFixture(cwd, 'src/.gitignore', 'ignored.ts\n');
      await createFixture(cwd, 'src/ignored.ts');
      await createFixture(cwd, 'src/visible.ts');

      await expect(discoverFiles({ cwd })).resolves.toEqual(['src/visible.ts']);
    });
  });

  test('handles gitignored paths that contain newlines', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      initializeGitRepository(cwd);
      await createFixture(cwd, 'src/.gitignore', 'ignored*\n');
      await createFixture(cwd, 'src/ignored\nfile.ts');
      await createFixture(cwd, 'src/kept.ts');

      await expect(discoverFiles({ cwd })).resolves.toEqual(['src/kept.ts']);
    });
  });

  test('respects .gitignore entries when the workspace contains a .git directory', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await mkdir(join(cwd, '.git'));
      await createFixture(cwd, '.gitignore', 'ignored-dir/\n*.secret.ts\n');
      await createFixture(cwd, 'ignored-dir/secret.ts');
      await createFixture(cwd, 'src/app.ts');
      await createFixture(cwd, 'src/keys.secret.ts');

      await expect(discoverFiles({ cwd })).resolves.toEqual(['src/app.ts']);
    });
  });

  test('scope does not affect .gitignore anchoring at project root', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await mkdir(join(cwd, '.git'));
      await createFixture(cwd, '.gitignore', 'ignored/\n');
      await createFixture(cwd, 'ignored/secret.ts');
      await createFixture(cwd, 'src/auth/kept.ts');
      await createFixture(cwd, 'src/app.ts');

      await expect(discoverFiles({ cwd, scope: 'src/auth' })).resolves.toEqual([
        'src/auth/kept.ts',
      ]);
    });
  });

  test('returns an empty array when scope exists but has no matching files', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await mkdir(join(cwd, 'src/empty'), { recursive: true });
      await createFixture(cwd, 'src/empty/.gitkeep');
      await createFixture(cwd, 'src/app.ts');

      await expect(discoverFiles({ cwd, scope: 'src/empty' })).resolves.toEqual(
        [],
      );
    });
  });

  test('returns POSIX-style separators in all discovered paths', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/nested/app.ts');
      await createFixture(cwd, 'lib/deep/util.py');

      const results = await discoverFiles({ cwd });

      expect(results).toEqual(['lib/deep/util.py', 'src/nested/app.ts']);

      for (const result of results) {
        expect(result.includes('\\')).toBe(false);
      }
    });
  });

  test('given a nested directory cannot be opened, when discovering, then it fails instead of dropping the subtree', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/app.ts');
      const nestedDirectoryPath = join(cwd, 'src');
      const openError = Object.assign(
        new Error('Mock nested directory open failed.'),
        { code: 'EACCES' } satisfies Pick<NodeJS.ErrnoException, 'code'>,
      );

      await withMockedFsPromises(
        (actualFs) => ({
          opendir: async (
            path: Parameters<typeof actualFs.opendir>[0],
            options?: Parameters<typeof actualFs.opendir>[1],
          ): Promise<Awaited<ReturnType<typeof actualFs.opendir>>> => {
            if (String(path) === nestedDirectoryPath) {
              throw openError;
            }

            return actualFs.opendir(path, options);
          },
        }),
        async () => {
          const { discoverFiles: discoverFilesWithMockedFs } =
            await import('@/discovery/index.js');
          const error = await getThrownError(() =>
            discoverFilesWithMockedFs({ cwd }),
          );

          expect(error.message).toBe(
            `Failed to discover files in cwd "${cwd}" — check that the directory exists and the glob patterns are valid.`,
          );
          expect(getNodeErrorCode(error.cause)).toBe('EACCES');
        },
      );
    });
  });

  test('given a nested search root turns into a file before opening, when discovering, then it skips the raced subtree', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/app.ts');
      const nestedDirectoryPath = join(cwd, 'src');
      const openError = Object.assign(
        new Error('Mock nested directory became a file.'),
        { code: 'ENOTDIR' } satisfies Pick<NodeJS.ErrnoException, 'code'>,
      );

      await withMockedFsPromises(
        (actualFs) => ({
          opendir: async (
            path: Parameters<typeof actualFs.opendir>[0],
            options?: Parameters<typeof actualFs.opendir>[1],
          ): Promise<Awaited<ReturnType<typeof actualFs.opendir>>> => {
            if (String(path) === nestedDirectoryPath) {
              throw openError;
            }

            return actualFs.opendir(path, options);
          },
        }),
        async () => {
          const { discoverFiles: discoverFilesWithMockedFs } =
            await import('@/discovery/index.js');

          await expect(
            discoverFilesWithMockedFs({ cwd, scope: 'src' }),
          ).resolves.toEqual([]);
        },
      );
    });
  });
});
