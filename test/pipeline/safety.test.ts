import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

import { discoverFiles } from '@/discovery/index.js';

import {
  buildDiscoveredMap,
  buildDiscoveredMapWithModule,
  createDirectorySymlink,
  createFixture,
  createFixtureSymlink,
  createOverviewFixture,
  getNodeErrorCode,
  getThrownError,
  withMockedFsPromises,
  withWorkspace,
} from '../helpers.js';

describe('discovered map safety', () => {
  test('returns JSON-serializable map entries', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createFixture(cwd, 'scripts/.overview', 'Tooling\n');
      await createOverviewFixture(cwd, 'scripts/build.ts', 'Build');
      await createOverviewFixture(cwd, 'src/app.ts', 'App');

      const filePaths = await discoverFiles({ cwd });
      const entries = await buildDiscoveredMap(filePaths, {
        collapseDirs: ['scripts'],
        cwd,
      });

      expect(JSON.parse(JSON.stringify(entries))).toEqual(entries);
    });
  });

  test('rejects collapse dirs outside cwd', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await expect(
        buildDiscoveredMap([], {
          collapseDirs: ['../outside'],
          cwd,
        }),
      ).rejects.toThrow(
        `Invalid collapseDir "../outside" — expected a path inside cwd "${cwd}".`,
      );
    });
  });

  test('rejects directory file paths before extraction', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await mkdir(join(cwd, 'src'), { recursive: true });

      const error = await getThrownError(async () => {
        await buildDiscoveredMap(['src'], { cwd });
      });

      expect(error.message).toBe(
        `Invalid filePath "src" — expected an existing file relative to cwd "${cwd}".`,
      );
    });
  });

  test('given file path has a file parent, when building, then preserves the filesystem cause', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createFixture(cwd, 'not-a-directory', 'file\n');

      const error = await getThrownError(async () => {
        await buildDiscoveredMap(['not-a-directory/child.ts'], { cwd });
      });

      expect(error.message).toBe(
        'Failed to inspect filePath "not-a-directory/child.ts" — check that the path is readable.',
      );
      expect(getNodeErrorCode(error.cause)).toBe('ENOTDIR');
    });
  });

  test('given a source file cannot be read, when building, then it uses the read code', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      const filePath = join(cwd, 'src/app.ts');
      await createOverviewFixture(cwd, 'src/app.ts', 'App');
      const readError = Object.assign(new Error('Mock source read failed.'), {
        code: 'EACCES',
      } satisfies Pick<NodeJS.ErrnoException, 'code'>);

      await withMockedFsPromises(
        (actualFs) => {
          const mockFileHandle = {
            close: vi.fn(async (): Promise<void> => {}),
            read: vi.fn(async (): Promise<never> => {
              throw readError;
            }),
            stat: vi.fn(async () => actualFs.stat(filePath)),
          };

          return {
            open: async (
              path: Parameters<typeof actualFs.open>[0],
              flags?: Parameters<typeof actualFs.open>[1],
              mode?: Parameters<typeof actualFs.open>[2],
            ): Promise<
              Awaited<ReturnType<typeof actualFs.open>> | typeof mockFileHandle
            > => {
              if (String(path) === filePath) {
                return mockFileHandle;
              }

              return actualFs.open(path, flags, mode);
            },
          };
        },
        async () => {
          const mockedModule: typeof import('@/pipeline/index.js') =
            await import('@/pipeline/index.js');
          const error = await getThrownError(async () => {
            await buildDiscoveredMapWithModule(mockedModule, ['src/app.ts'], {
              cwd,
            });
          });

          expect(error.message).toBe(
            `Failed to build file map entries in cwd "${cwd}" — fix the collapse options or file read error and try again.`,
          );
        },
      );
    });
  });

  test('given a source file changes after validation, when building, then it rejects the read', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      const outsideCwd = `${cwd}-outside`;
      const sourcePath = join(cwd, 'src/app.ts');
      const leakedPath = join(outsideCwd, 'leak.ts');

      try {
        await createOverviewFixture(cwd, 'src/app.ts', 'App');
        await createFixture(
          outsideCwd,
          'leak.ts',
          '/** @fileoverview Leak */\n',
        );

        const canCreateSymlink = await createFixtureSymlink(
          cwd,
          'probe-link.ts',
          leakedPath,
        );

        if (!canCreateSymlink) {
          return;
        }

        await rm(join(cwd, 'probe-link.ts'), { force: true });

        let didSwapSource = false;

        await withMockedFsPromises(
          (actualFs) => ({
            open: async (
              path: Parameters<typeof actualFs.open>[0],
              flags?: Parameters<typeof actualFs.open>[1],
              mode?: Parameters<typeof actualFs.open>[2],
            ): Promise<Awaited<ReturnType<typeof actualFs.open>>> => {
              if (String(path) === sourcePath && !didSwapSource) {
                didSwapSource = true;
                await actualFs.rm(sourcePath, { force: true });
                await actualFs.symlink(leakedPath, sourcePath, 'file');
              }

              return actualFs.open(path, flags, mode);
            },
          }),
          async () => {
            const mockedModule: typeof import('@/pipeline/index.js') =
              await import('@/pipeline/index.js');
            const error = await getThrownError(async () => {
              await buildDiscoveredMapWithModule(mockedModule, ['src/app.ts'], {
                cwd,
              });
            });

            expect(error.message).toBe(
              `Failed to build file map entries in cwd "${cwd}" — fix the collapse options or file read error and try again.`,
            );
            expect(error.cause).toBeInstanceOf(Error);

            if (error.cause instanceof Error) {
              expect(error.cause.message).toBe(
                'Invalid filePath "src/app.ts" — expected the same file before and after opening it.',
              );
            }
          },
        );
      } finally {
        await rm(outsideCwd, { force: true, recursive: true });
      }
    });
  });

  test('given a symlinked source file target is missing, when building, then it rejects the path', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      const createdSymlink = await createFixtureSymlink(
        cwd,
        'linked.ts',
        join(cwd, 'missing.ts'),
      );

      if (!createdSymlink) {
        return;
      }

      const error = await getThrownError(async () => {
        await buildDiscoveredMap(['linked.ts'], { cwd });
      });

      expect(error.message).toBe(
        `Failed to build file map entries in cwd "${cwd}" — fix the collapse options or file read error and try again.`,
      );
      expect(error.cause).toBeInstanceOf(Error);

      if (error.cause instanceof Error) {
        expect(error.cause.message).toBe(
          `Invalid filePath "linked.ts" — expected an existing file relative to cwd "${cwd}".`,
        );
      }
    });
  });

  test('given a symlinked source file realpath fails, when building, then it keeps the filesystem cause', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createOverviewFixture(cwd, 'src/app.ts', 'App');
      const linkedPath = join(cwd, 'linked.ts');
      const createdSymlink = await createFixtureSymlink(
        cwd,
        'linked.ts',
        join(cwd, 'src/app.ts'),
      );

      if (!createdSymlink) {
        return;
      }

      const realpathError = Object.assign(new Error('Mock realpath failed.'), {
        code: 'EACCES',
      } satisfies Pick<NodeJS.ErrnoException, 'code'>);

      await withMockedFsPromises(
        (actualFs) => ({
          realpath: async (
            path: Parameters<typeof actualFs.realpath>[0],
            options?: Parameters<typeof actualFs.realpath>[1],
          ): Promise<Awaited<ReturnType<typeof actualFs.realpath>>> => {
            if (String(path) === linkedPath) {
              throw realpathError;
            }

            return actualFs.realpath(path, options);
          },
        }),
        async () => {
          const mockedModule: typeof import('@/pipeline/index.js') =
            await import('@/pipeline/index.js');
          const error = await getThrownError(async () => {
            await buildDiscoveredMapWithModule(mockedModule, ['linked.ts'], {
              cwd,
            });
          });

          expect(error.message).toBe(
            `Failed to resolve real path for "${linkedPath}" — check that the path is readable.`,
          );
          expect(getNodeErrorCode(error.cause)).toBe('EACCES');
        },
      );
    });
  });

  test('allows symlinked files that resolve inside cwd', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createOverviewFixture(cwd, 'src/app.ts', 'App');

      const createdSymlink = await createFixtureSymlink(
        cwd,
        'linked.ts',
        join(cwd, 'src/app.ts'),
      );

      if (!createdSymlink) {
        return;
      }

      await expect(buildDiscoveredMap(['linked.ts'], { cwd })).resolves.toEqual(
        [
          {
            description: 'App',
            kind: 'file',
            path: 'linked.ts',
          },
        ],
      );
    });
  });

  test('rejects file paths that resolve outside cwd through symlinks', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      const outsideCwd = `${cwd}-outside`;

      try {
        await createFixture(
          outsideCwd,
          'leak.ts',
          '/** @fileoverview Leak */\n',
        );

        const createdSymlink = await createFixtureSymlink(
          cwd,
          'linked.ts',
          join(outsideCwd, 'leak.ts'),
        );

        if (!createdSymlink) {
          return;
        }

        await expect(
          buildDiscoveredMap(['linked.ts'], { cwd }),
        ).rejects.toThrow(
          `Invalid filePath "linked.ts" — expected a file that resolves inside cwd "${cwd}".`,
        );
      } finally {
        await rm(outsideCwd, { force: true, recursive: true });
      }
    });
  });

  test('rejects file paths that resolve outside cwd through symlinked parent directories', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      const outsideCwd = `${cwd}-outside`;

      try {
        await createFixture(
          outsideCwd,
          'leak.ts',
          '/** @fileoverview Leak */\n',
        );

        const createdSymlink = await createDirectorySymlink(
          cwd,
          'linked',
          outsideCwd,
        );

        if (!createdSymlink) {
          return;
        }

        await expect(
          buildDiscoveredMap(['linked/leak.ts'], { cwd }),
        ).rejects.toThrow(
          `Invalid filePath "linked/leak.ts" — expected a file that resolves inside cwd "${cwd}".`,
        );
      } finally {
        await rm(outsideCwd, { force: true, recursive: true });
      }
    });
  });

  test('rejects collapse dirs that resolve outside cwd through symlinks', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      const outsideCwd = `${cwd}-outside`;

      try {
        await mkdir(outsideCwd, { recursive: true });
        await createOverviewFixture(cwd, 'src/app.ts', 'App');
        await createFixture(
          outsideCwd,
          'leak.ts',
          '/** @fileoverview Leak */\n',
        );

        const createdSymlink = await createDirectorySymlink(
          cwd,
          'linked',
          outsideCwd,
        );

        if (!createdSymlink) {
          return;
        }

        await expect(
          buildDiscoveredMap(['src/app.ts'], { collapseDirs: ['linked'], cwd }),
        ).rejects.toThrow(
          `Invalid collapseDir "linked" — expected a directory that resolves inside cwd "${cwd}".`,
        );
      } finally {
        await rm(outsideCwd, { force: true, recursive: true });
      }
    });
  });

  test('given collapse dir has a file parent, when building, then preserves the filesystem cause', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createOverviewFixture(cwd, 'src/app.ts', 'App');
      await createFixture(cwd, 'not-a-directory', 'file\n');

      const error = await getThrownError(async () => {
        await buildDiscoveredMap(['src/app.ts'], {
          collapseDirs: ['not-a-directory/child'],
          cwd,
        });
      });

      expect(error.message).toBe(
        'Failed to inspect collapseDir "not-a-directory/child" — check that the path is readable.',
      );
      expect(getNodeErrorCode(error.cause)).toBe('ENOTDIR');
    });
  });

  test('given depth scope has a file parent, when building, then preserves the filesystem cause', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createOverviewFixture(cwd, 'src/app.ts', 'App');
      await createFixture(cwd, 'not-a-directory', 'file\n');

      const error = await getThrownError(async () => {
        await buildDiscoveredMap(['src/app.ts'], {
          cwd,
          depth: 1,
          scope: 'not-a-directory/child',
        });
      });

      expect(error.message).toBe(
        'Failed to inspect scope "not-a-directory/child" — check that the path is readable.',
      );
      expect(getNodeErrorCode(error.cause)).toBe('ENOTDIR');
    });
  });

  test('surfaces invalid collapse dirs as the top-level caller error', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createOverviewFixture(cwd, 'src/app.ts', 'App');

      await expect(
        buildDiscoveredMap(['src/app.ts'], { collapseDirs: ['missing'], cwd }),
      ).rejects.toThrow(
        `Invalid collapseDir "missing" — expected an existing directory relative to cwd "${cwd}".`,
      );
    });
  });

  test('keeps file read failures wrapped with cwd and path context', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await expect(
        buildDiscoveredMap(['src/missing.ts'], { cwd }),
      ).rejects.toThrow(
        `Failed to build file map entries in cwd "${cwd}" — fix the collapse options or file read error and try again.`,
      );
    });
  });

  test('rejects an empty custom tag before reading files', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await expect(buildDiscoveredMap([], { cwd, tag: '' })).rejects.toThrow(
        'Invalid tag "" — expected a tag like "@fileoverview" using letters, numbers, underscores, or hyphens.',
      );
    });
  });

  test('rejects an empty custom tag when all files are collapsed', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createFixture(cwd, 'scripts/build.ts', '/** @overview Build */\n');

      await expect(
        buildDiscoveredMap(['scripts/build.ts'], {
          collapseDirs: ['scripts'],
          cwd,
          tag: '',
        }),
      ).rejects.toThrow(
        'Invalid tag "" — expected a tag like "@fileoverview" using letters, numbers, underscores, or hyphens.',
      );
    });
  });

  test('rejects a depth directory scope that resolves outside cwd through a symlink', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      const outsideCwd = `${cwd}-outside`;

      try {
        await createFixture(outsideCwd, '.keep', '');
        await createOverviewFixture(cwd, 'src/app.ts', 'App');
        const createdSymlink = await createDirectorySymlink(
          cwd,
          'linked',
          outsideCwd,
        );

        if (!createdSymlink) {
          return;
        }

        await expect(
          buildDiscoveredMap(['src/app.ts'], {
            cwd,
            depth: 1,
            scope: 'linked',
          }),
        ).rejects.toThrow(
          `Invalid scope "linked" — expected a directory that resolves inside cwd "${cwd}".`,
        );
      } finally {
        await rm(outsideCwd, { force: true, recursive: true });
      }
    });
  });

  test('rejects a depth file scope that resolves outside cwd through a symlink', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      const outsideCwd = `${cwd}-outside`;

      try {
        await createFixture(
          outsideCwd,
          'leak.ts',
          '/** @fileoverview Leak */\n',
        );
        await createOverviewFixture(cwd, 'src/app.ts', 'App');
        const createdSymlink = await createFixtureSymlink(
          cwd,
          'linked.ts',
          join(outsideCwd, 'leak.ts'),
        );

        if (!createdSymlink) {
          return;
        }

        await expect(
          buildDiscoveredMap(['src/app.ts'], {
            cwd,
            depth: 1,
            scope: 'linked.ts',
          }),
        ).rejects.toThrow(
          `Invalid scope "linked.ts" — expected a file that resolves inside cwd "${cwd}".`,
        );
      } finally {
        await rm(outsideCwd, { force: true, recursive: true });
      }
    });
  });

  test('keeps an in-cwd symlink depth scope consistent with normal scopes', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createOverviewFixture(cwd, 'src/auth/login.ts', 'Login');
      const createdSymlink = await createDirectorySymlink(
        cwd,
        'linked',
        join(cwd, 'src/auth'),
      );

      if (!createdSymlink) {
        return;
      }

      await expect(
        buildDiscoveredMap(['linked/login.ts'], {
          cwd,
          depth: 1,
          scope: 'linked',
        }),
      ).resolves.toEqual([
        {
          description: 'Login',
          kind: 'file',
          path: 'linked/login.ts',
        },
      ]);
    });
  });
});
