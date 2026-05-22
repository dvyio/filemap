import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

import { discoverFiles } from '@/discovery/index.js';
import { type MapEntry } from '@/pipeline/index.js';
import { mapWithConcurrency } from '@/shared/concurrency.js';
import { validateMaxFiles } from '@/shared/max-files.js';

import {
  buildDiscoveredMap,
  buildDiscoveredMapWithModule,
  createFixture,
  createFixtureSymlink,
  createOverviewFixture,
  getThrownError,
  withMockedFsPromises,
  withWorkspace,
} from '../helpers.js';

class MockNodeError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super(`Mock ${code}`);
    this.code = code;
  }
}

function expectMapEntriesIgnoringOrder(
  entries: readonly MapEntry[],
  expectedEntries: readonly MapEntry[],
): void {
  expect(entries).toHaveLength(expectedEntries.length);
  expect(entries).toEqual(expect.arrayContaining([...expectedEntries]));
}

describe('buildMapFromDiscoveredFiles', () => {
  test('given a source file open hits file handle pressure, when building the map, then it retries the source read', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createOverviewFixture(cwd, 'src/app.ts', 'App');
      const sourcePath = join(cwd, 'src/app.ts');
      let sourceOpenAttempts = 0;
      const setTimeoutMock = vi.fn(
        async (_delayMs: number): Promise<void> => {},
      );

      vi.doMock('node:timers/promises', () => ({
        setTimeout: setTimeoutMock,
      }));

      try {
        await withMockedFsPromises(
          (actualFs) => ({
            open: async (
              path: Parameters<typeof actualFs.open>[0],
              flags?: Parameters<typeof actualFs.open>[1],
              mode?: Parameters<typeof actualFs.open>[2],
            ): Promise<Awaited<ReturnType<typeof actualFs.open>>> => {
              if (path === sourcePath && flags === 'r') {
                sourceOpenAttempts += 1;

                if (sourceOpenAttempts === 1) {
                  throw new MockNodeError('EMFILE');
                }
              }

              return actualFs.open(path, flags, mode);
            },
          }),
          async () => {
            const mockedModule: typeof import('@/pipeline/index.js') =
              await import('@/pipeline/index.js');

            await expect(
              buildDiscoveredMapWithModule(mockedModule, ['src/app.ts'], {
                cwd,
              }),
            ).resolves.toEqual([
              {
                description: 'App',
                kind: 'file',
                path: 'src/app.ts',
              },
            ]);
            expect(sourceOpenAttempts).toBe(2);
            expect(setTimeoutMock).toHaveBeenCalledWith(10);
          },
        );
      } finally {
        vi.doUnmock('node:timers/promises');
        vi.resetModules();
      }
    });
  });

  test('given visible files exceed maxFiles, when building the map, then it fails before file reads', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await expect(
        buildDiscoveredMap(['src/a.ts', 'src/b.ts', 'src/c.ts'], {
          cwd,
          maxFiles: validateMaxFiles(2),
        }),
      ).rejects.toThrow(
        'Filemap found 3 visible files, which exceeds the max-files limit of 2. Re-run with --max-files 3 or narrow [scope], --include, or --exclude.',
      );
    });
  });

  test('given a directory scope, when file paths include siblings, then only scoped files are returned', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createOverviewFixture(cwd, 'src/auth/login.ts', 'Login');
      await createOverviewFixture(cwd, 'src/auth/logout.ts', 'Logout');
      await createOverviewFixture(cwd, 'src/app.ts', 'App');

      await expect(
        buildDiscoveredMap(
          ['src/auth/login.ts', 'src/auth/logout.ts', 'src/app.ts'],
          {
            cwd,
            scope: 'src/auth',
          },
        ),
      ).resolves.toEqual([
        {
          description: 'Login',
          kind: 'file',
          path: 'src/auth/login.ts',
        },
        {
          description: 'Logout',
          kind: 'file',
          path: 'src/auth/logout.ts',
        },
      ]);
    });
  });

  test('given a file scope, when file paths include siblings, then only the scoped file is returned', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createOverviewFixture(cwd, 'src/auth/login.ts', 'Login');
      await createOverviewFixture(cwd, 'src/auth/logout.ts', 'Logout');

      await expect(
        buildDiscoveredMap(['src/auth/login.ts', 'src/auth/logout.ts'], {
          cwd,
          scope: 'src/auth/login.ts',
        }),
      ).resolves.toEqual([
        {
          description: 'Login',
          kind: 'file',
          path: 'src/auth/login.ts',
        },
      ]);
    });
  });

  test('given a directory scope with collapse dirs, when file paths include outside files, then only scoped directories collapse', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createFixture(cwd, 'src/auth/.overview', 'Auth code\n');
      await createOverviewFixture(cwd, 'src/auth/login.ts', 'Login');
      await createFixture(cwd, 'scripts/.overview', 'Scripts\n');
      await createOverviewFixture(cwd, 'scripts/build.ts', 'Build');

      await expect(
        buildDiscoveredMap(['src/auth/login.ts', 'scripts/build.ts'], {
          collapseDirs: ['src/auth', 'scripts'],
          cwd,
          scope: 'src/auth',
        }),
      ).resolves.toEqual([
        {
          description: 'Auth code',
          hiddenFileCount: 1,
          kind: 'directory',
          path: 'src/auth',
        },
      ]);
    });
  });
});

describe('discovered map collapse', () => {
  test('produces a collapsed directory entry for a requested subtree', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createOverviewFixture(cwd, 'scripts/build.ts', 'Build');
      await createOverviewFixture(cwd, 'scripts/deploy.ts', 'Deploy');
      await createOverviewFixture(cwd, 'src/app.ts', 'App');

      const filePaths = await discoverFiles({ cwd });

      const entries = await buildDiscoveredMap(filePaths, {
        collapseDirs: ['scripts'],
        cwd,
      });

      expectMapEntriesIgnoringOrder(entries, [
        {
          description: undefined,
          hiddenFileCount: 2,
          kind: 'directory',
          path: 'scripts',
        },
        {
          description: 'App',
          kind: 'file',
          path: 'src/app.ts',
        },
      ]);
    });
  });

  test('given files collapse below maxFiles, when building, then the visible cap passes', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createOverviewFixture(cwd, 'scripts/build.ts', 'Build');
      await createOverviewFixture(cwd, 'scripts/deploy.ts', 'Deploy');
      await createOverviewFixture(cwd, 'scripts/release.ts', 'Release');
      await createOverviewFixture(cwd, 'src/app.ts', 'App');

      const filePaths = await discoverFiles({ cwd });
      const entries = await buildDiscoveredMap(filePaths, {
        collapseDirs: ['scripts'],
        cwd,
        maxFiles: validateMaxFiles(1),
      });

      expectMapEntriesIgnoringOrder(entries, [
        {
          description: undefined,
          hiddenFileCount: 3,
          kind: 'directory',
          path: 'scripts',
        },
        {
          description: 'App',
          kind: 'file',
          path: 'src/app.ts',
        },
      ]);
    });
  });

  test('reads a .overview sidecar and uses it as the directory description', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createFixture(
        cwd,
        'scripts/.overview',
        'Build\n and deploy tooling\n',
      );
      await createOverviewFixture(cwd, 'scripts/build.ts', 'Build');

      const filePaths = await discoverFiles({ cwd });

      await expect(
        buildDiscoveredMap(filePaths, { collapseDirs: ['scripts'], cwd }),
      ).resolves.toEqual([
        {
          description: 'Build and deploy tooling',
          hiddenFileCount: 1,
          kind: 'directory',
          path: 'scripts',
        },
      ]);
    });
  });

  test('escapes non-whitespace control characters in sidecar descriptions', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createFixture(
        cwd,
        'scripts/.overview',
        'Build \u001b[31mtools\u007f\n',
      );
      await createOverviewFixture(cwd, 'scripts/build.ts', 'Build');

      const filePaths = await discoverFiles({ cwd });

      await expect(
        buildDiscoveredMap(filePaths, { collapseDirs: ['scripts'], cwd }),
      ).resolves.toEqual([
        {
          description: 'Build \\u001b[31mtools\\u007f',
          hiddenFileCount: 1,
          kind: 'directory',
          path: 'scripts',
        },
      ]);
    });
  });

  test('rejects a sidecar larger than the read limit', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createFixture(cwd, 'scripts/.overview', 'A'.repeat(64 * 1024 + 1));
      await createOverviewFixture(cwd, 'scripts/build.ts', 'Build');

      const filePaths = await discoverFiles({ cwd });

      await expect(
        buildDiscoveredMap(filePaths, { collapseDirs: ['scripts'], cwd }),
      ).rejects.toThrow(
        `Invalid sidecar "scripts/.overview" — expected a file no larger than 65536 bytes.`,
      );
    });
  });

  test('rejects a sidecar that contains invalid UTF-8', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createOverviewFixture(cwd, 'scripts/build.ts', 'Build');
      await createFixture(cwd, 'scripts/.overview');
      await writeFile(join(cwd, 'scripts/.overview'), Buffer.from([0xff]));

      const filePaths = await discoverFiles({ cwd });
      const error = await getThrownError(async () => {
        await buildDiscoveredMap(filePaths, { collapseDirs: ['scripts'], cwd });
      });

      expect(error.message).toBe(
        `Invalid sidecar "scripts/.overview" — expected valid UTF-8 text; save the file as UTF-8 or remove invalid bytes.`,
      );
    });
  });

  test('rejects a sidecar symlink that resolves outside cwd', async () => {
    const outsideCwd = await mkdtemp(join(tmpdir(), 'filemap-outside-'));

    try {
      await withWorkspace('filemap-pipeline-', async (cwd) => {
        await createFixture(
          outsideCwd,
          'leak.overview',
          'Outside description\n',
        );
        await mkdir(join(cwd, 'scripts'), { recursive: true });
        const didCreateSymlink = await createFixtureSymlink(
          cwd,
          'scripts/.overview',
          join(outsideCwd, 'leak.overview'),
        );

        if (!didCreateSymlink) {
          return;
        }

        await createOverviewFixture(cwd, 'scripts/build.ts', 'Build');
        const filePaths = await discoverFiles({ cwd });

        await expect(
          buildDiscoveredMap(filePaths, { collapseDirs: ['scripts'], cwd }),
        ).rejects.toThrow(
          `Invalid sidecar "scripts/.overview" — expected a file that resolves inside cwd "${cwd}".`,
        );
      });
    } finally {
      await rm(outsideCwd, { force: true, recursive: true });
    }
  });

  test('rejects a sidecar symlink that resolves outside the collapsed directory', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createFixture(cwd, 'shared/overview.txt', 'Shared description\n');
      await mkdir(join(cwd, 'scripts'), { recursive: true });
      const didCreateSymlink = await createFixtureSymlink(
        cwd,
        'scripts/.overview',
        join(cwd, 'shared/overview.txt'),
      );

      if (!didCreateSymlink) {
        return;
      }

      await createOverviewFixture(cwd, 'scripts/build.ts', 'Build');
      const filePaths = await discoverFiles({ cwd });

      await expect(
        buildDiscoveredMap(filePaths, { collapseDirs: ['scripts'], cwd }),
      ).rejects.toThrow(
        `Invalid sidecar "scripts/.overview" — expected a file that resolves inside collapsed directory "scripts" and cwd "${cwd}".`,
      );
    });
  });

  test('given a sidecar changes after validation, when building, then it rejects the read', async () => {
    const outsideCwd = await mkdtemp(join(tmpdir(), 'filemap-outside-'));

    try {
      await withWorkspace('filemap-pipeline-', async (cwd) => {
        const sidecarPath = join(cwd, 'scripts/.overview');
        const leakedPath = join(outsideCwd, 'leak.overview');
        await createOverviewFixture(cwd, 'scripts/build.ts', 'Build');
        await createFixture(cwd, 'scripts/.overview', 'Build scripts\n');
        await createFixture(outsideCwd, 'leak.overview', 'Leak\n');

        const canCreateSymlink = await createFixtureSymlink(
          cwd,
          'probe-link.overview',
          leakedPath,
        );

        if (!canCreateSymlink) {
          return;
        }

        await rm(join(cwd, 'probe-link.overview'), { force: true });

        let didSwapSidecar = false;

        await withMockedFsPromises(
          (actualFs) => ({
            open: async (
              path: Parameters<typeof actualFs.open>[0],
              flags?: Parameters<typeof actualFs.open>[1],
              mode?: Parameters<typeof actualFs.open>[2],
            ): Promise<Awaited<ReturnType<typeof actualFs.open>>> => {
              if (String(path) === sidecarPath && !didSwapSidecar) {
                didSwapSidecar = true;
                await actualFs.rm(sidecarPath, { force: true });
                await actualFs.symlink(leakedPath, sidecarPath, 'file');
              }

              return actualFs.open(path, flags, mode);
            },
          }),
          async () => {
            const mockedModule: typeof import('@/pipeline/index.js') =
              await import('@/pipeline/index.js');

            await expect(
              buildDiscoveredMapWithModule(mockedModule, ['scripts/build.ts'], {
                collapseDirs: ['scripts'],
                cwd,
              }),
            ).rejects.toThrow(
              'Invalid sidecar "scripts/.overview" — expected the same file before and after opening it.',
            );
          },
        );
      });
    } finally {
      await rm(outsideCwd, { force: true, recursive: true });
    }
  });

  test('given a sidecar changes after realpath, when building, then it rejects the read', async () => {
    const outsideCwd = await mkdtemp(join(tmpdir(), 'filemap-outside-'));

    try {
      await withWorkspace('filemap-pipeline-', async (cwd) => {
        const sidecarPath = join(cwd, 'scripts/.overview');
        const leakedPath = join(outsideCwd, 'leak.overview');
        await createOverviewFixture(cwd, 'scripts/build.ts', 'Build');
        await createFixture(cwd, 'scripts/.overview', 'Build scripts\n');
        await createFixture(outsideCwd, 'leak.overview', 'Leak\n');

        const canCreateSymlink = await createFixtureSymlink(
          cwd,
          'probe-link.overview',
          leakedPath,
        );

        if (!canCreateSymlink) {
          return;
        }

        await rm(join(cwd, 'probe-link.overview'), { force: true });

        let didSwapSidecar = false;

        await withMockedFsPromises(
          (actualFs) => ({
            realpath: async (
              path: Parameters<typeof actualFs.realpath>[0],
              options?: Parameters<typeof actualFs.realpath>[1],
            ): Promise<Awaited<ReturnType<typeof actualFs.realpath>>> => {
              const realPath = await actualFs.realpath(path, options);

              if (String(path) === sidecarPath && !didSwapSidecar) {
                didSwapSidecar = true;
                await actualFs.rm(sidecarPath, { force: true });
                await actualFs.symlink(leakedPath, sidecarPath, 'file');
              }

              return realPath;
            },
          }),
          async () => {
            const mockedModule: typeof import('@/pipeline/index.js') =
              await import('@/pipeline/index.js');

            await expect(
              buildDiscoveredMapWithModule(mockedModule, ['scripts/build.ts'], {
                collapseDirs: ['scripts'],
                cwd,
              }),
            ).rejects.toThrow(
              'Invalid sidecar "scripts/.overview" — expected the same file before and after opening it.',
            );
          },
        );
      });
    } finally {
      await rm(outsideCwd, { force: true, recursive: true });
    }
  });

  test('given a sidecar realpath fails, when building, then it keeps the read error', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      const sidecarPath = join(cwd, 'scripts/.overview');
      await createOverviewFixture(cwd, 'scripts/build.ts', 'Build');
      await createFixture(cwd, 'scripts/.overview', 'Build scripts\n');

      const realpathError = Object.assign(new Error('Mock realpath failed.'), {
        code: 'EACCES',
      } satisfies Pick<NodeJS.ErrnoException, 'code'>);

      await withMockedFsPromises(
        (actualFs) => ({
          realpath: async (
            path: Parameters<typeof actualFs.realpath>[0],
            options?: Parameters<typeof actualFs.realpath>[1],
          ): Promise<Awaited<ReturnType<typeof actualFs.realpath>>> => {
            if (String(path) === sidecarPath) {
              throw realpathError;
            }

            return actualFs.realpath(path, options);
          },
        }),
        async () => {
          const mockedModule: typeof import('@/pipeline/index.js') =
            await import('@/pipeline/index.js');
          const error = await getThrownError(() =>
            buildDiscoveredMapWithModule(mockedModule, ['scripts/build.ts'], {
              collapseDirs: ['scripts'],
              cwd,
            }),
          );

          expect(error.message).toBe(
            `Failed to read sidecar "${sidecarPath}" — check that the file is readable or remove the collapse directory.`,
          );
          expect(error.cause).toBe(realpathError);
        },
      );
    });
  });

  test('given a sidecar stat fails, when building, then it keeps the read error', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      const sidecarPath = join(cwd, 'scripts/.overview');
      await createOverviewFixture(cwd, 'scripts/build.ts', 'Build');
      await createFixture(cwd, 'scripts/.overview', 'Build scripts\n');

      const statError = Object.assign(new Error('Mock stat failed.'), {
        code: 'EACCES',
      } satisfies Pick<NodeJS.ErrnoException, 'code'>);

      await withMockedFsPromises(
        (actualFs) => ({
          stat: async (
            path: Parameters<typeof actualFs.stat>[0],
            options?: Parameters<typeof actualFs.stat>[1],
          ): Promise<Awaited<ReturnType<typeof actualFs.stat>>> => {
            if (String(path) === sidecarPath) {
              throw statError;
            }

            return actualFs.stat(path, options);
          },
        }),
        async () => {
          const mockedModule: typeof import('@/pipeline/index.js') =
            await import('@/pipeline/index.js');
          const error = await getThrownError(() =>
            buildDiscoveredMapWithModule(mockedModule, ['scripts/build.ts'], {
              collapseDirs: ['scripts'],
              cwd,
            }),
          );

          expect(error.message).toBe(
            `Failed to read sidecar "${sidecarPath}" — check that the file is readable or remove the collapse directory.`,
          );
          expect(error.cause).toBe(statError);
        },
      );
    });
  });

  test('given a sidecar open fails, when building, then it keeps the read error', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      const sidecarPath = join(cwd, 'scripts/.overview');
      await createOverviewFixture(cwd, 'scripts/build.ts', 'Build');
      await createFixture(cwd, 'scripts/.overview', 'Build scripts\n');

      const openError = Object.assign(new Error('Mock open failed.'), {
        code: 'EACCES',
      } satisfies Pick<NodeJS.ErrnoException, 'code'>);

      await withMockedFsPromises(
        (actualFs) => ({
          open: async (
            path: Parameters<typeof actualFs.open>[0],
            flags?: Parameters<typeof actualFs.open>[1],
            mode?: Parameters<typeof actualFs.open>[2],
          ): Promise<Awaited<ReturnType<typeof actualFs.open>>> => {
            if (String(path) === sidecarPath) {
              throw openError;
            }

            return actualFs.open(path, flags, mode);
          },
        }),
        async () => {
          const mockedModule: typeof import('@/pipeline/index.js') =
            await import('@/pipeline/index.js');
          const error = await getThrownError(() =>
            buildDiscoveredMapWithModule(mockedModule, ['scripts/build.ts'], {
              collapseDirs: ['scripts'],
              cwd,
            }),
          );

          expect(error.message).toBe(
            `Failed to read sidecar "${sidecarPath}" — check that the file is readable or remove the collapse directory.`,
          );
          expect(error.cause).toBe(openError);
        },
      );
    });
  });

  test('given a sidecar is a directory, when building, then it rejects the sidecar', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createOverviewFixture(cwd, 'scripts/build.ts', 'Build');
      await mkdir(join(cwd, 'scripts/.overview'), { recursive: true });

      await expect(
        buildDiscoveredMap(['scripts/build.ts'], {
          collapseDirs: ['scripts'],
          cwd,
        }),
      ).rejects.toThrow(
        'Invalid sidecar "scripts/.overview" — expected a file inside collapsed directory "scripts".',
      );
    });
  });

  test('leaves the directory description undefined when the sidecar is missing', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createOverviewFixture(cwd, 'scripts/build.ts', 'Build');

      const filePaths = await discoverFiles({ cwd });

      const entries = await buildDiscoveredMap(filePaths, {
        collapseDirs: ['scripts'],
        cwd,
      });

      expectMapEntriesIgnoringOrder(entries, [
        {
          description: undefined,
          hiddenFileCount: 1,
          kind: 'directory',
          path: 'scripts',
        },
      ]);
    });
  });

  test('counts the whole descendant subtree when collapsing a directory', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createOverviewFixture(cwd, 'scripts/build.ts', 'Build');
      await createOverviewFixture(cwd, 'scripts/nested/deploy.ts', 'Deploy');
      await createOverviewFixture(
        cwd,
        'scripts/nested/deep/release.ts',
        'Release',
      );

      const filePaths = await discoverFiles({ cwd });
      const entries = await buildDiscoveredMap(filePaths, {
        collapseDirs: ['scripts'],
        cwd,
      });

      expect(entries).toEqual([
        {
          description: undefined,
          hiddenFileCount: 3,
          kind: 'directory',
          path: 'scripts',
        },
      ]);
    });
  });

  test('given sidecar read and close both fail, when building map, then the read error stays primary', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createOverviewFixture(cwd, 'scripts/build.ts', 'Build');
      await createFixture(cwd, 'scripts/.overview', 'Build scripts\n');
      const sidecarPath = join(cwd, 'scripts/.overview');
      const readError = new Error('Mock sidecar read failed.');
      const closeError = new Error('Mock sidecar close failed.');

      await withMockedFsPromises(
        (actualFs) => {
          const mockFileHandle = {
            close: vi.fn(async (): Promise<void> => {
              throw closeError;
            }),
            read: vi.fn(async (): Promise<never> => {
              throw readError;
            }),
            stat: vi.fn(async () => actualFs.stat(sidecarPath)),
          };

          return {
            open: vi.fn(async () => mockFileHandle),
          };
        },
        async () => {
          const mockedModule: typeof import('@/pipeline/index.js') =
            await import('@/pipeline/index.js');
          const error = await getThrownError(() =>
            buildDiscoveredMapWithModule(mockedModule, ['scripts/build.ts'], {
              collapseDirs: ['scripts'],
              cwd,
            }),
          );

          expect(error.message).toBe(
            `Failed to read sidecar "${sidecarPath}" — check that the file is readable or remove the collapse directory.`,
          );

          expectReadAndCloseErrors(error.cause, readError, closeError);
        },
      );
    });
  });

  test('given an unrelated error starts with the invalid sidecar prefix, when building map, then it keeps build-map context', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createOverviewFixture(cwd, 'scripts/build.ts', 'Build');
      const unrelatedError = new Error('Invalid sidecar mock unrelated.');

      vi.resetModules();
      vi.doMock('@/pipeline/sidecars.js', async () => {
        const actualSidecars = await vi.importActual<
          typeof import('@/pipeline/sidecars.js')
        >('@/pipeline/sidecars.js');

        return {
          ...actualSidecars,
          readDirectorySidecar: async (): Promise<never> => {
            throw unrelatedError;
          },
        };
      });

      try {
        const mockedModule: typeof import('@/pipeline/index.js') =
          await import('@/pipeline/index.js');
        const error = await getThrownError(() =>
          buildDiscoveredMapWithModule(mockedModule, ['scripts/build.ts'], {
            collapseDirs: ['scripts'],
            cwd,
          }),
        );

        expect(error.message).toBe(
          `Failed to build file map entries in cwd "${cwd}" — fix the collapse options or file read error and try again.`,
        );
        expect(error.cause).toBe(unrelatedError);
      } finally {
        vi.doUnmock('@/pipeline/sidecars.js');
        vi.resetModules();
      }
    });
  });

  test('given a sidecar arrives in multiple reads, when building map, then it keeps the full description', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createOverviewFixture(cwd, 'scripts/build.ts', 'Build');
      await createFixture(cwd, 'scripts/.overview', 'Build scripts\n');
      const sidecarPath = join(cwd, 'scripts/.overview');
      const sidecarChunks = [
        Buffer.from('Build '),
        Buffer.from('scripts\n'),
        Buffer.alloc(0),
      ];

      await withMockedFsPromises(
        (actualFs) => {
          const mockFileHandle = {
            close: vi.fn(async (): Promise<void> => {}),
            read: vi.fn(
              async (
                buffer: Buffer,
                offset: number,
              ): Promise<{ bytesRead: number }> => {
                const chunk = sidecarChunks.shift();

                if (chunk === undefined) {
                  throw new Error('Expected no more sidecar reads.');
                }

                chunk.copy(buffer, offset);

                return { bytesRead: chunk.length };
              },
            ),
            stat: vi.fn(async () => actualFs.stat(sidecarPath)),
          };

          return {
            open: vi.fn(async () => mockFileHandle),
          };
        },
        async () => {
          const mockedModule: typeof import('@/pipeline/index.js') =
            await import('@/pipeline/index.js');
          const entries = await buildDiscoveredMapWithModule(
            mockedModule,
            ['scripts/build.ts'],
            {
              collapseDirs: ['scripts'],
              cwd,
            },
          );

          expect(entries).toEqual([
            {
              description: 'Build scripts',
              hiddenFileCount: 1,
              kind: 'directory',
              path: 'scripts',
            },
          ]);
        },
      );
    });
  });

  test('does not extract fileoverviews for hidden descendants', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createOverviewFixture(cwd, 'scripts/build.ts', 'Build');
      await createOverviewFixture(cwd, 'src/app.ts', 'App');

      const filePaths = await discoverFiles({ cwd });

      const entries = await buildDiscoveredMap(filePaths, {
        collapseDirs: ['scripts'],
        cwd,
      });

      expectMapEntriesIgnoringOrder(entries, [
        {
          description: undefined,
          hiddenFileCount: 1,
          kind: 'directory',
          path: 'scripts',
        },
        {
          description: 'App',
          kind: 'file',
          path: 'src/app.ts',
        },
      ]);
    });
  });

  test('supports multiple collapsed directories in one run', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createOverviewFixture(cwd, 'scripts/build.ts', 'Build');
      await createOverviewFixture(cwd, 'tools/release.ts', 'Release');
      await createOverviewFixture(cwd, 'src/app.ts', 'App');

      const filePaths = await discoverFiles({ cwd });

      const entries = await buildDiscoveredMap(filePaths, {
        collapseDirs: ['scripts', 'tools'],
        cwd,
      });

      expectMapEntriesIgnoringOrder(entries, [
        {
          description: undefined,
          hiddenFileCount: 1,
          kind: 'directory',
          path: 'scripts',
        },
        {
          description: undefined,
          hiddenFileCount: 1,
          kind: 'directory',
          path: 'tools',
        },
        {
          description: 'App',
          kind: 'file',
          path: 'src/app.ts',
        },
      ]);
    });
  });

  test('given multiple collapsed sidecars, when building the map, then cwd realpath is reused', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createFixture(cwd, 'scripts/.overview', 'Scripts\n');
      await createOverviewFixture(cwd, 'scripts/build.ts', 'Build');
      await createFixture(cwd, 'tools/.overview', 'Tools\n');
      await createOverviewFixture(cwd, 'tools/release.ts', 'Release');
      let cwdRealpathCalls = 0;

      await withMockedFsPromises(
        (actualFs) => ({
          realpath: async (
            path: Parameters<typeof actualFs.realpath>[0],
            options?: Parameters<typeof actualFs.realpath>[1],
          ): Promise<Awaited<ReturnType<typeof actualFs.realpath>>> => {
            if (String(path) === cwd) {
              cwdRealpathCalls += 1;
            }

            return actualFs.realpath(path, options);
          },
        }),
        async () => {
          const mockedModule: typeof import('@/pipeline/index.js') =
            await import('@/pipeline/index.js');
          const entries = await buildDiscoveredMapWithModule(
            mockedModule,
            ['scripts/build.ts', 'tools/release.ts'],
            {
              collapseDirs: ['scripts', 'tools'],
              cwd,
            },
          );

          expectMapEntriesIgnoringOrder(entries, [
            {
              description: 'Scripts',
              hiddenFileCount: 1,
              kind: 'directory',
              path: 'scripts',
            },
            {
              description: 'Tools',
              hiddenFileCount: 1,
              kind: 'directory',
              path: 'tools',
            },
          ]);
          expect(cwdRealpathCalls).toBe(1);
        },
      );
    });
  });

  test('collapses only the outermost requested directory when collapse dirs overlap', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createOverviewFixture(cwd, 'scripts/nested/build.ts', 'Build');

      const filePaths = await discoverFiles({ cwd });

      await expect(
        buildDiscoveredMap(filePaths, {
          collapseDirs: ['scripts', 'scripts/nested'],
          cwd,
        }),
      ).resolves.toEqual([
        {
          description: undefined,
          hiddenFileCount: 1,
          kind: 'directory',
          path: 'scripts',
        },
      ]);
    });
  });

  test('collapses a shallow directory when it is explicitly requested even within depth', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createOverviewFixture(cwd, 'src/app.ts', 'App');
      await createOverviewFixture(cwd, 'lib/util.ts', 'Utility');

      const filePaths = await discoverFiles({ cwd });

      const entries = await buildDiscoveredMap(filePaths, {
        collapseDirs: ['src'],
        cwd,
        depth: 2,
      });

      expectMapEntriesIgnoringOrder(entries, [
        {
          description: undefined,
          hiddenFileCount: 1,
          kind: 'directory',
          path: 'src',
        },
        {
          description: 'Utility',
          kind: 'file',
          path: 'lib/util.ts',
        },
      ]);
    });
  });
});

describe('discovered map depth', () => {
  test('collapses directories deeper than the requested depth', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createOverviewFixture(cwd, 'src/app.ts', 'App');
      await createOverviewFixture(cwd, 'src/auth/login.ts', 'Login');
      await createOverviewFixture(cwd, 'src/auth/utils/hash.ts', 'Hash');

      const filePaths = await discoverFiles({ cwd });

      await expect(
        buildDiscoveredMap(filePaths, { cwd, depth: 1 }),
      ).resolves.toEqual([
        {
          description: 'App',
          kind: 'file',
          path: 'src/app.ts',
        },
        {
          description: undefined,
          hiddenFileCount: 2,
          kind: 'directory',
          path: 'src/auth',
        },
      ]);
    });
  });

  test('measures depth relative to the scope root when one is provided', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createOverviewFixture(cwd, 'src/auth/login.ts', 'Login');
      await createOverviewFixture(cwd, 'src/auth/utils/hash.ts', 'Hash');
      await createOverviewFixture(
        cwd,
        'src/auth/utils/nested/rules.ts',
        'Rules',
      );

      const filePaths = await discoverFiles({ cwd, scope: 'src' });

      await expect(
        buildDiscoveredMap(filePaths, {
          cwd,
          depth: 1,
          scope: 'src',
        }),
      ).resolves.toEqual([
        {
          description: 'Login',
          kind: 'file',
          path: 'src/auth/login.ts',
        },
        {
          description: undefined,
          hiddenFileCount: 2,
          kind: 'directory',
          path: 'src/auth/utils',
        },
      ]);
    });
  });

  test('does not collapse ancestors outside a scoped depth root', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createOverviewFixture(cwd, 'app/foo/a.ts', 'App foo');

      const filePaths = await discoverFiles({ cwd, scope: 'app/foo' });

      await expect(
        buildDiscoveredMap(filePaths, {
          cwd,
          depth: 0,
          scope: 'app/foo',
        }),
      ).resolves.toEqual([
        {
          description: 'App foo',
          kind: 'file',
          path: 'app/foo/a.ts',
        },
      ]);
    });
  });

  test('collapses every non-root directory when depth is zero', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      await createOverviewFixture(cwd, 'root.ts', 'Root');
      await createOverviewFixture(cwd, 'src/app.ts', 'App');

      const filePaths = await discoverFiles({ cwd });

      await expect(
        buildDiscoveredMap(filePaths, { cwd, depth: 0 }),
      ).resolves.toEqual([
        {
          description: 'Root',
          kind: 'file',
          path: 'root.ts',
        },
        {
          description: undefined,
          hiddenFileCount: 1,
          kind: 'directory',
          path: 'src',
        },
      ]);
    });
  });

  test('given a large tree, when collapsing by depth, then hidden files are grouped once', async () => {
    await withWorkspace('filemap-pipeline-', async (cwd) => {
      const packageCount = 16;
      const filesPerPackage = 12;
      const fixtureWrites = [createOverviewFixture(cwd, 'root.ts', 'Root')];
      const filePaths = ['root.ts'];

      for (let packageIndex = 0; packageIndex < packageCount; packageIndex++) {
        for (let fileIndex = 0; fileIndex < filesPerPackage; fileIndex++) {
          const filePath = `packages/pkg-${String(packageIndex)}/feature-${String(fileIndex)}/file.ts`;
          filePaths.push(filePath);
          fixtureWrites.push(createOverviewFixture(cwd, filePath, 'Hidden'));
        }
      }

      await Promise.all(fixtureWrites);

      const entries = await buildDiscoveredMap(filePaths, { cwd, depth: 1 });
      const directoryEntries = entries.filter(isDirectoryEntry);
      const hiddenFileTotal = directoryEntries.reduce((total, entry) => {
        return total + entry.hiddenFileCount;
      }, 0);

      expect(directoryEntries).toHaveLength(packageCount);
      expect(hiddenFileTotal).toBe(packageCount * filesPerPackage);
      expect(entries).toContainEqual({
        description: 'Root',
        kind: 'file',
        path: 'root.ts',
      });
    });
  });
});

describe('mapWithConcurrency', () => {
  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'given invalid concurrency %s, when mapping, then it rejects before starting workers',
    async (concurrency) => {
      await expect(
        mapWithConcurrency([1, 2, 3], concurrency, async (item) => {
          return item;
        }),
      ).rejects.toThrow(
        `Invalid concurrency "${String(concurrency)}" — expected a positive integer.`,
      );
    },
  );

  test('given an undefined item, when mapping, then rejects instead of skipping work', async () => {
    await expect(
      Reflect.apply(mapWithConcurrency, undefined, [
        [1, undefined, 3],
        1,
        async (item: unknown): Promise<unknown> => {
          return item;
        },
      ]),
    ).rejects.toThrow(
      'Invalid concurrency item "undefined" — expected every item to be defined.',
    );
  });

  test('given one worker fails, when started work settles, then later items do not start', async () => {
    const failure = new Error('Mock worker failed.');
    const startedItems: number[] = [];
    let releaseFirstWorker = (): void => {
      throw new Error('Expected the first worker to start.');
    };
    const firstWorkerRelease = new Promise<number>((resolve) => {
      releaseFirstWorker = () => {
        resolve(1);
      };
    });
    let failSecondWorker = (): void => {
      throw new Error('Expected the second worker to start.');
    };
    const secondWorkerFailure = new Promise<number>((_resolve, reject) => {
      failSecondWorker = () => {
        reject(failure);
      };
    });

    const resultPromise = mapWithConcurrency(
      [1, 2, 3, 4],
      2,
      async (item): Promise<number> => {
        startedItems.push(item);

        if (item === 1) {
          return firstWorkerRelease;
        }

        if (item === 2) {
          return secondWorkerFailure;
        }

        return item;
      },
    );
    const errorPromise = resultPromise.catch((error: unknown) => error);

    expect(startedItems).toEqual([1, 2]);

    failSecondWorker();
    await Promise.resolve();
    const earlyStatus = await Promise.race([
      errorPromise.then(() => {
        return 'rejected';
      }),
      Promise.resolve('pending'),
    ]);

    expect(earlyStatus).toBe('pending');

    releaseFirstWorker();
    const error = await errorPromise;
    await Promise.resolve();

    expect(error).toBe(failure);
    expect(startedItems).toEqual([1, 2]);
  });
});

function expectReadAndCloseErrors(
  error: unknown,
  readError: Error,
  closeError: Error,
): void {
  expect(error).toBeInstanceOf(AggregateError);

  if (!(error instanceof AggregateError)) {
    throw new Error('Expected an AggregateError.');
  }

  expect(error.message).toBe(readError.message);
  expect(error.cause).toBe(readError);
  expect(error.errors).toHaveLength(1);

  const closeFailure: unknown = error.errors[0];

  expect(closeFailure).toBeInstanceOf(Error);

  if (!(closeFailure instanceof Error)) {
    throw new Error('Expected close failure to be an Error.');
  }

  expect(closeFailure.message).toBe('Failed to close file handle after read.');
  expect(closeFailure.cause).toBe(closeError);
}

function isDirectoryEntry(
  entry: MapEntry,
): entry is Extract<MapEntry, { readonly kind: 'directory' }> {
  return entry.kind === 'directory';
}
