import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

import { discoverFiles } from '@/discovery/index.js';
import { createGitCheckIgnoreOutputParser } from '@/git/ignore-output-parser.js';
import { toDiscoveredRepoPath } from '@/paths/brands.js';
import { resolveWorkingDirectory } from '@/shared/defaults.js';
import { validateMaxFiles } from '@/shared/max-files.js';

import {
  createFixture,
  createFixtureSymlink,
  createOverviewFixture,
  getThrownError,
  initializeGitRepository,
  withMockedFsPromises,
  withWorkspace,
} from '../helpers.js';

type GitCheckIgnoreMockMode =
  | 'failed'
  | 'spawnMissing'
  | 'stdinEndEmitsError'
  | 'stdinWriteEmitsNonError'
  | 'stdoutNonString'
  | 'timeoutCloses'
  | 'timeoutHangs';

interface GitCheckIgnoreMockState {
  exitCode: number;
  killCalls: number;
  mode: GitCheckIgnoreMockMode;
  spawnArgs: readonly string[] | undefined;
  stderr: string;
  stderrChunks: readonly string[] | undefined;
  stdoutChunk: string | symbol;
}

function createGitCheckIgnoreMockState(
  overrides: Partial<GitCheckIgnoreMockState> = {},
): GitCheckIgnoreMockState {
  return {
    exitCode: 1,
    killCalls: 0,
    mode: 'failed',
    spawnArgs: undefined,
    stderr: '',
    stderrChunks: undefined,
    stdoutChunk: '',
    ...overrides,
  };
}

describe('git check-ignore output parser', () => {
  test('given split Git output, when parsing chunks, then paths keep spaces', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      const parser = createGitCheckIgnoreOutputParser(
        resolveWorkingDirectory(cwd),
        [
          toDiscoveredRepoPath(' spaced file.ts', 'filePath'),
          toDiscoveredRepoPath('src/generated.ts', 'filePath'),
        ],
      );

      parser.addChunk('src/generated');
      parser.addChunk('.ts\0 spaced file.ts\0');

      expect([...parser.finish()].sort()).toEqual([
        ' spaced file.ts',
        'src/generated.ts',
      ]);
    });
  });

  test('given one large Git output chunk, when parsing, then every ignored path is kept', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      const ignoredPaths = Array.from({ length: 1_000 }, (_unused, index) => {
        return toDiscoveredRepoPath(
          `src/generated/${String(index).padStart(4, '0')}.ts`,
          'filePath',
        );
      });
      const parser = createGitCheckIgnoreOutputParser(
        resolveWorkingDirectory(cwd),
        ignoredPaths,
      );

      parser.addChunk(`${ignoredPaths.join('\0')}\0`);

      expect([...parser.finish()]).toEqual(ignoredPaths);
    });
  });

  test('given Git output misses its final NUL byte, when parsing finishes, then it fails clearly', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      const parser = createGitCheckIgnoreOutputParser(
        resolveWorkingDirectory(cwd),
        [toDiscoveredRepoPath('src/generated.ts', 'filePath')],
      );

      parser.addChunk('src/generated.ts');

      expect(() => {
        parser.finish();
      }).toThrow(
        `Failed to read git check-ignore output in cwd "${cwd}" — Git returned incomplete path "src/generated.ts", expected null-separated paths ending with NUL.`,
      );
    });
  });

  test('given an oversized Git output path, when parsing chunks, then it fails clearly', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      const parser = createGitCheckIgnoreOutputParser(
        resolveWorkingDirectory(cwd),
        [toDiscoveredRepoPath('src/generated.ts', 'filePath')],
      );

      expect(() => {
        parser.addChunk('x'.repeat(65_537));
      }).toThrow(
        `Failed to read git check-ignore output in cwd "${cwd}" — Git returned a path longer than 65536 characters.`,
      );
    });
  });

  test('given one oversized Git output chunk, when parsing continues, then the failed chunk is not kept', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      const parser = createGitCheckIgnoreOutputParser(
        resolveWorkingDirectory(cwd),
        [toDiscoveredRepoPath('src/generated.ts', 'filePath')],
      );

      expect(() => {
        parser.addChunk('x'.repeat(100_000));
      }).toThrow(
        `Failed to read git check-ignore output in cwd "${cwd}" — Git returned a path longer than 65536 characters.`,
      );

      parser.addChunk('src/generated.ts\0');

      expect([...parser.finish()]).toEqual(['src/generated.ts']);
    });
  });

  test('given Git returns an absolute output path, when parsing chunks, then it fails clearly', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      const parser = createGitCheckIgnoreOutputParser(
        resolveWorkingDirectory(cwd),
        [toDiscoveredRepoPath('src/app.ts', 'filePath')],
      );

      expect(() => {
        parser.addChunk('/tmp/secret.ts\0');
      }).toThrow(
        `Failed to read git check-ignore output in cwd "${cwd}" — Git returned path "/tmp/secret.ts", expected one of the paths sent to Git.`,
      );
    });
  });

  test('given Git returns parent traversal, when parsing chunks, then it fails clearly', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      const parser = createGitCheckIgnoreOutputParser(
        resolveWorkingDirectory(cwd),
        [toDiscoveredRepoPath('src/app.ts', 'filePath')],
      );

      expect(() => {
        parser.addChunk('../secret.ts\0');
      }).toThrow(
        `Failed to read git check-ignore output in cwd "${cwd}" — Git returned path "../secret.ts", expected one of the paths sent to Git.`,
      );
    });
  });

  test('given Git returns a path that was not checked, when parsing chunks, then it fails clearly', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      const parser = createGitCheckIgnoreOutputParser(
        resolveWorkingDirectory(cwd),
        [toDiscoveredRepoPath('src/app.ts', 'filePath')],
      );

      expect(() => {
        parser.addChunk('src/other.ts\0');
      }).toThrow(
        `Failed to read git check-ignore output in cwd "${cwd}" — Git returned path "src/other.ts", expected one of the paths sent to Git.`,
      );
    });
  });
});

describe('discoverFiles git ignore filtering', () => {
  test('given a workspace without Git metadata, when discovering, then Git is not spawned', async () => {
    const gitCheckIgnoreState = mockGitCheckIgnoreProcess({
      exitCode: 1,
    });
    const { discoverFiles: discoverFilesWithMockedGit } =
      await import('@/discovery/index.js');

    try {
      await withWorkspace('filemap-discover-', async (cwd) => {
        await createFixture(cwd, '.gitignore', 'src/ignored.ts\n');
        await createFixture(cwd, 'src/ignored.ts');
        await createFixture(cwd, 'src/visible.ts');

        await expect(discoverFilesWithMockedGit({ cwd })).resolves.toEqual([
          'src/visible.ts',
        ]);
        expect(gitCheckIgnoreState.spawnArgs).toBeUndefined();
      });
    } finally {
      await restoreGitCheckIgnoreProcess();
    }
  });

  test('given a Git workspace with ignored files, when discovering, then ignored paths are skipped', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      initializeGitRepository(cwd);
      await createFixture(cwd, 'src/.gitignore', 'ignored*.ts\n');
      await createFixture(cwd, 'src/ignored.ts');
      await createFixture(cwd, 'src/ignored-with-suffix.ts');
      await createFixture(cwd, 'src/visible.ts');

      await expect(discoverFiles({ cwd })).resolves.toEqual(['src/visible.ts']);
    });
  });

  test('given a Git ignored directory exceeds maxFiles, when discovering, then ignored files do not count', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      initializeGitRepository(cwd);
      await createFixture(cwd, '.gitignore', '.venv/\n');
      await createFixture(cwd, '.venv/a.py');
      await createFixture(cwd, '.venv/b.py');
      await createFixture(cwd, '.venv/c.py');
      await createFixture(cwd, 'src/app.py');

      await expect(
        discoverFiles({ cwd, maxFiles: validateMaxFiles(2) }),
      ).resolves.toEqual(['src/app.py']);
    });
  });

  test('given a Git file scope is visible, when discovering, then it is returned', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      initializeGitRepository(cwd);
      await createFixture(cwd, 'src/app.ts');

      await expect(
        discoverFiles({ cwd, scope: 'src/app.ts' }),
      ).resolves.toEqual(['src/app.ts']);
    });
  });

  test('given a Git file scope is ignored, when discovering, then it is hidden', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      initializeGitRepository(cwd);
      await createFixture(cwd, '.gitignore', 'src/secret.ts\n');
      await createFixture(cwd, 'src/secret.ts');

      await expect(
        discoverFiles({ cwd, scope: 'src/secret.ts' }),
      ).resolves.toEqual([]);
    });
  });

  test('given cwd is inside a parent Git repo, when discovering, then parent ignore metadata is ignored', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      initializeGitRepository(cwd);
      await createFixture(cwd, '.gitignore', 'child/src/secret.ts\n');
      await createFixture(cwd, 'child/src/app.ts');
      await createFixture(cwd, 'child/src/secret.ts');

      await expect(discoverFiles({ cwd: join(cwd, 'child') })).resolves.toEqual(
        ['src/app.ts', 'src/secret.ts'],
      );
    });
  });

  test('given nested gitignore re-includes a root-ignored file, when discovering, then the file is kept', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      initializeGitRepository(cwd);
      await createFixture(cwd, '.gitignore', '*.ts\n');
      await createFixture(cwd, 'src/.gitignore', '!keep.ts\n');
      await createFixture(cwd, 'src/drop.ts');
      await createFixture(cwd, 'src/keep.ts');

      await expect(discoverFiles({ cwd })).resolves.toEqual(['src/keep.ts']);
    });
  });

  test('given a Git ignored path contains spaces, when discovering, then the matching file is skipped', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      initializeGitRepository(cwd);
      await createFixture(cwd, 'src/.gitignore', 'secret file.ts\n');
      await createFixture(cwd, 'src/secret file.ts');
      await createFixture(cwd, 'src/visible file.ts');

      await expect(discoverFiles({ cwd })).resolves.toEqual([
        'src/visible file.ts',
      ]);
    });
  });

  test('given many Git visible files, when discovering, then every visible path is returned', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      initializeGitRepository(cwd);
      const paths = Array.from({ length: 120 }, (_unused, index) => {
        return `src/${String(index).padStart(3, '0')}-${'x'.repeat(48)}.ts`;
      });

      for (const path of paths) {
        await createFixture(cwd, path);
      }

      await expect(discoverFiles({ cwd })).resolves.toEqual(paths);
    });
  });

  test('given Git stdin write emits a non-error value, when checking ignores, then it reports the value', async () => {
    mockGitCheckIgnoreProcess({
      exitCode: 1,
      mode: 'stdinWriteEmitsNonError',
    });
    const { findGitIgnoredPaths } = await import('@/git/ignore.js');

    try {
      await withWorkspace('filemap-discover-', async (cwd) => {
        const error = await getThrownError(async () => {
          await findGitIgnoredPaths(
            [toDiscoveredRepoPath('src/app.ts', 'filePath')],
            resolveWorkingDirectory(cwd),
          );
        });

        expect(error.message).toContain(
          'Failed to send paths to git check-ignore',
        );
        expect(error.message).toContain(
          'Git closed stdin before reading all paths',
        );
        expect(error.cause).toBe('mock stdin write failed');
      });
    } finally {
      await restoreGitCheckIgnoreProcess();
    }
  });

  test('given git check-ignore times out, when checking ignores, then it explains the timeout', async () => {
    const originalTimeout = process.env['FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS'];
    const gitCheckIgnoreState = mockGitCheckIgnoreProcess({
      mode: 'timeoutCloses',
    });
    const { findGitIgnoredPaths } = await import('@/git/ignore.js');

    try {
      await withWorkspace('filemap-discover-', async (cwd) => {
        process.env['FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS'] = '1';
        vi.useFakeTimers({ toFake: ['clearTimeout', 'setTimeout'] });

        try {
          const errorPromise = getThrownError(async () => {
            await findGitIgnoredPaths(
              [toDiscoveredRepoPath('src/app.ts', 'filePath')],
              resolveWorkingDirectory(cwd),
            );
          });

          await vi.advanceTimersByTimeAsync(1);
          await vi.runOnlyPendingTimersAsync();
          const error = await errorPromise;

          expect(error.message).toContain('Timed out running git check-ignore');
          expect(error.message).toContain('after 1 ms — Git was killed.');
          expect(error.message).toContain(
            'Set FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS up to 60000, or run filemap on a narrower scope.',
          );
          expect(gitCheckIgnoreState.killCalls).toBe(1);
        } finally {
          vi.useRealTimers();

          if (originalTimeout === undefined) {
            delete process.env['FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS'];
          } else {
            process.env['FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS'] =
              originalTimeout;
          }
        }
      });
    } finally {
      await restoreGitCheckIgnoreProcess();
    }
  });

  test('given Git visible files exceed maxFiles, when discovering, then it fails after Git ignore filtering', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      initializeGitRepository(cwd);
      await createFixture(cwd, 'src/a.ts');
      await createFixture(cwd, 'src/b.ts');
      await createFixture(cwd, 'src/c.ts');

      await expect(
        discoverFiles({ cwd, maxFiles: validateMaxFiles(2) }),
      ).rejects.toThrow(
        'Filemap found 3 visible files, which exceeds the max-files limit of 2.',
      );
    });
  });

  test('given root gitignore read fails, when discovering files, then it fails instead of ignoring rules', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      const gitignorePath = join(cwd, '.gitignore');
      await createFixture(cwd, '.gitignore', 'src/secret.ts\n');
      await createFixture(cwd, 'src/app.ts');
      await createFixture(cwd, 'src/secret.ts');
      const readError = Object.assign(
        new Error('Mock .gitignore read failed.'),
        {
          code: 'EACCES',
        } satisfies Pick<NodeJS.ErrnoException, 'code'>,
      );

      await withMockedFsPromises(
        (actualFs) => {
          const mockFileHandle = {
            close: vi.fn(async (): Promise<void> => {}),
            read: vi.fn(async (): Promise<never> => {
              throw readError;
            }),
            stat: vi.fn(async () => actualFs.stat(gitignorePath)),
          };

          return {
            open: vi.fn(async () => mockFileHandle),
          };
        },
        async () => {
          const { discoverFiles: discoverFilesWithMockedFs } =
            await import('@/discovery/index.js');

          await expect(discoverFilesWithMockedFs({ cwd })).rejects.toThrow(
            `Failed to read .gitignore in cwd "${cwd}" — check that the file is readable.`,
          );
        },
      );
    });
  });

  test('given root gitignore resolves outside cwd, when discovering files, then it fails before reading it', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      const outsideCwd = `${cwd}-outside`;

      try {
        await createFixture(outsideCwd, 'rules.gitignore', 'src/secret.ts\n');
        const didCreateSymlink = await createFixtureSymlink(
          cwd,
          '.gitignore',
          join(outsideCwd, 'rules.gitignore'),
        );

        if (!didCreateSymlink) {
          return;
        }

        await createFixture(cwd, 'src/app.ts');
        await createFixture(cwd, 'src/secret.ts');

        await expect(discoverFiles({ cwd })).rejects.toThrow(
          `Invalid .gitignore "${join(cwd, '.gitignore')}" — expected a file that resolves inside cwd "${cwd}".`,
        );
      } finally {
        await rm(outsideCwd, { force: true, recursive: true });
      }
    });
  });

  test('given root gitignore is not a file, when discovering files, then it fails before reading it', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await mkdir(join(cwd, '.gitignore'));
      await createFixture(cwd, 'src/app.ts');

      const error = await getThrownError(async () => {
        await discoverFiles({ cwd });
      });

      expect(error.message).toBe(
        `Invalid .gitignore "${join(cwd, '.gitignore')}" — expected a regular file.`,
      );
    });
  });

  test('given root gitignore is oversized, when discovering files, then it fails before reading it', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, '.gitignore', 'x'.repeat(65_537));
      await createFixture(cwd, 'src/app.ts');

      await expect(discoverFiles({ cwd })).rejects.toThrow(
        `Invalid .gitignore "${join(cwd, '.gitignore')}" — expected a file no larger than 65536 bytes.`,
      );
    });
  });

  test('given root gitignore contains invalid UTF-8, when discovering files, then it fails clearly', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, '.gitignore');
      await writeFile(join(cwd, '.gitignore'), Buffer.from([0xff]));
      await createFixture(cwd, 'src/app.ts');

      await expect(discoverFiles({ cwd })).rejects.toThrow(
        `Invalid .gitignore "${join(cwd, '.gitignore')}" — expected valid UTF-8 text; save the file as UTF-8 or remove invalid bytes.`,
      );
    });
  });

  test('given root gitignore read fails with an invalid-prefix message, when discovering files, then it stays a read failure', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, '.gitignore', 'src/secret.ts\n');
      await createFixture(cwd, 'src/app.ts');
      const gitignorePath = join(cwd, '.gitignore');
      const readError = new Error('Invalid .gitignore mock read failed.');

      await withMockedFsPromises(
        (actualFs) => {
          const mockFileHandle = {
            close: vi.fn(async (): Promise<void> => {}),
            read: vi.fn(async (): Promise<never> => {
              throw readError;
            }),
            stat: vi.fn(async () => actualFs.stat(gitignorePath)),
          };

          return {
            open: vi.fn(async () => mockFileHandle),
          };
        },
        async () => {
          const { discoverFiles: discoverFilesWithMockedFs } =
            await import('@/discovery/index.js');

          await expect(discoverFilesWithMockedFs({ cwd })).rejects.toThrow(
            `Failed to read .gitignore in cwd "${cwd}" — check that the file is readable.`,
          );
        },
      );
    });
  });

  test('given root gitignore changes after checking, when discovering files, then it fails before reading rules', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, '.gitignore', 'src/secret.ts\n');
      await createFixture(cwd, 'src/app.ts');
      await createFixture(cwd, 'src/secret.ts');
      const gitignorePath = join(cwd, '.gitignore');

      let readCalls = 0;

      await withMockedFsPromises(
        async (actualFs) => {
          const checkedStats = await actualFs.stat(gitignorePath);
          const changedStats = {
            dev: checkedStats.dev + 1,
            ino: checkedStats.ino + 1,
            isFile: () => true,
            size: checkedStats.size,
          };
          const mockFileHandle = {
            close: vi.fn(async (): Promise<void> => {}),
            read: vi.fn(async (): Promise<{ bytesRead: number }> => {
              readCalls += 1;
              return { bytesRead: 0 };
            }),
            stat: vi.fn(async () => changedStats),
          };

          return {
            open: async (
              path: Parameters<typeof actualFs.open>[0],
            ): Promise<typeof mockFileHandle> => {
              if (String(path) === gitignorePath) {
                return mockFileHandle;
              }

              throw new Error(`Unexpected open path "${String(path)}".`);
            },
          };
        },
        async () => {
          const { discoverFiles: discoverFilesWithMockedFs } =
            await import('@/discovery/index.js');

          await expect(discoverFilesWithMockedFs({ cwd })).rejects.toThrow(
            `Invalid .gitignore "${gitignorePath}" — expected the same file before and after opening it.`,
          );
          expect(readCalls).toBe(0);
        },
      );
    });
  });

  test('given root gitignore changes after realpath, when discovering files, then it fails before reading rules', async () => {
    const outsideCwd = await mkdtemp(join(tmpdir(), 'filemap-outside-'));

    try {
      await withWorkspace('filemap-discover-', async (cwd) => {
        await createFixture(cwd, '.gitignore', '\n');
        await createFixture(cwd, 'src/app.ts');
        await createFixture(cwd, 'src/secret.ts');
        await createFixture(outsideCwd, 'leak.gitignore', 'src/secret.ts\n');
        const gitignorePath = join(cwd, '.gitignore');
        const leakedPath = join(outsideCwd, 'leak.gitignore');
        const canCreateSymlink = await createFixtureSymlink(
          cwd,
          'probe-link.gitignore',
          leakedPath,
        );

        if (!canCreateSymlink) {
          return;
        }

        await rm(join(cwd, 'probe-link.gitignore'), { force: true });

        let didSwapGitignore = false;

        await withMockedFsPromises(
          (actualFs) => ({
            realpath: async (
              path: Parameters<typeof actualFs.realpath>[0],
              options?: Parameters<typeof actualFs.realpath>[1],
            ): Promise<Awaited<ReturnType<typeof actualFs.realpath>>> => {
              const realPath = await actualFs.realpath(path, options);

              if (String(path) === gitignorePath && !didSwapGitignore) {
                didSwapGitignore = true;
                await actualFs.rm(gitignorePath, { force: true });
                await actualFs.symlink(leakedPath, gitignorePath, 'file');
              }

              return realPath;
            },
          }),
          async () => {
            const { discoverFiles: discoverFilesWithMockedFs } =
              await import('@/discovery/index.js');

            await expect(discoverFilesWithMockedFs({ cwd })).rejects.toThrow(
              `Invalid .gitignore "${gitignorePath}" — expected the same file before and after opening it.`,
            );
          },
        );
      });
    } finally {
      await rm(outsideCwd, { force: true, recursive: true });
    }
  });

  test('given cwd disappears while checking root gitignore, when discovering files, then gitignore is treated as absent', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, '.gitignore', 'src/secret.ts\n');
      await createFixture(cwd, 'src/app.ts');
      await createFixture(cwd, 'src/secret.ts');
      const realpathError = Object.assign(new Error('Mock cwd missing.'), {
        code: 'ENOENT',
      } satisfies Pick<NodeJS.ErrnoException, 'code'>);

      await withMockedFsPromises(
        (actualFs) => ({
          realpath: async (
            path: Parameters<typeof actualFs.realpath>[0],
            options?: Parameters<typeof actualFs.realpath>[1],
          ): Promise<Awaited<ReturnType<typeof actualFs.realpath>>> => {
            if (String(path) === cwd) {
              throw realpathError;
            }

            return actualFs.realpath(path, options);
          },
        }),
        async () => {
          const { discoverFiles: discoverFilesWithMockedFs } =
            await import('@/discovery/index.js');

          await expect(discoverFilesWithMockedFs({ cwd })).resolves.toEqual([
            'src/app.ts',
            'src/secret.ts',
          ]);
        },
      );
    });
  });

  test('given root gitignore is removed after checking, when discovering files, then it is treated as absent', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, '.gitignore', 'src/secret.ts\n');
      await createFixture(cwd, 'src/app.ts');
      await createFixture(cwd, 'src/secret.ts');
      const gitignorePath = join(cwd, '.gitignore');
      const openError = Object.assign(new Error('Mock .gitignore missing.'), {
        code: 'ENOENT',
      } satisfies Pick<NodeJS.ErrnoException, 'code'>);

      await withMockedFsPromises(
        (actualFs) => ({
          open: async (
            path: Parameters<typeof actualFs.open>[0],
          ): Promise<Awaited<ReturnType<typeof actualFs.open>>> => {
            if (String(path) === gitignorePath) {
              throw openError;
            }

            return actualFs.open(path);
          },
        }),
        async () => {
          const { discoverFiles: discoverFilesWithMockedFs } =
            await import('@/discovery/index.js');

          await expect(discoverFilesWithMockedFs({ cwd })).resolves.toEqual([
            'src/app.ts',
            'src/secret.ts',
          ]);
        },
      );
    });
  });

  test('given root gitignore grows after opening, when discovering files, then it fails before parsing rules', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, '.gitignore', 'src/secret.ts\n');
      await createFixture(cwd, 'src/app.ts');
      const gitignorePath = join(cwd, '.gitignore');

      await withMockedFsPromises(
        async (actualFs) => {
          const checkedStats = await actualFs.stat(gitignorePath);
          const mockFileHandle = {
            close: vi.fn(async (): Promise<void> => {}),
            read: vi.fn(async (): Promise<{ bytesRead: number }> => {
              return { bytesRead: 65_537 };
            }),
            stat: vi.fn(async () => checkedStats),
          };

          return {
            open: vi.fn(async () => mockFileHandle),
          };
        },
        async () => {
          const { discoverFiles: discoverFilesWithMockedFs } =
            await import('@/discovery/index.js');

          await expect(discoverFilesWithMockedFs({ cwd })).rejects.toThrow(
            `Invalid .gitignore "${gitignorePath}" — expected a file no larger than 65536 bytes.`,
          );
        },
      );
    });
  });

  test('given root gitignore read and close both fail, when discovering files, then it keeps the read failure primary', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, '.gitignore', 'src/secret.ts\n');
      await createFixture(cwd, 'src/app.ts');
      const gitignorePath = join(cwd, '.gitignore');
      const readError = new Error('Mock .gitignore read failed.');
      const closeError = new Error('Mock .gitignore close failed.');

      let openCalls = 0;

      await withMockedFsPromises(
        (actualFs) => {
          const mockFileHandle = {
            close: vi.fn(async (): Promise<void> => {
              throw closeError;
            }),
            read: vi.fn(async (): Promise<never> => {
              throw readError;
            }),
            stat: vi.fn(async () => actualFs.stat(gitignorePath)),
          };

          return {
            open: async (): Promise<typeof mockFileHandle> => {
              openCalls += 1;
              return mockFileHandle;
            },
          };
        },
        async () => {
          const { discoverFiles: discoverFilesWithMockedFs } =
            await import('@/discovery/index.js');

          const error = await getThrownError(async () => {
            await discoverFilesWithMockedFs({ cwd });
          });

          expect(error.message).toBe(
            `Failed to read .gitignore in cwd "${cwd}" — check that the file is readable.`,
          );
          expectReadAndCloseErrors(error.cause, readError, closeError);
        },
      );

      expect(openCalls).toBe(1);
    });
  });

  test('given Git metadata inspection fails, when discovering files, then it keeps the filesystem cause', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/app.ts');
      const gitMetadataPath = join(cwd, '.git');
      const gitMetadataError = Object.assign(
        new Error('Mock Git metadata inspect failed.'),
        { code: 'EACCES' } satisfies Pick<NodeJS.ErrnoException, 'code'>,
      );

      await withMockedFsPromises(
        (actualFs) => ({
          lstat: async (
            path: Parameters<typeof actualFs.lstat>[0],
            options?: Parameters<typeof actualFs.lstat>[1],
          ): Promise<Awaited<ReturnType<typeof actualFs.lstat>>> => {
            if (String(path) === gitMetadataPath) {
              throw gitMetadataError;
            }

            return actualFs.lstat(path, options);
          },
        }),
        async () => {
          const { discoverFiles: discoverFilesWithMockedFs } =
            await import('@/discovery/index.js');

          const error = await getThrownError(() =>
            discoverFilesWithMockedFs({ cwd }),
          );

          expect(error.message).toBe(
            `Failed to inspect Git metadata "${gitMetadataPath}" — check that the path is readable.`,
          );
          expect(error.cause).toBe(gitMetadataError);
        },
      );
    });
  });

  test('truncates large git ls-files stderr output in error messages', async () => {
    await withMockedGitCheckIgnore(
      {
        exitCode: 2,
        mode: 'failed',
        stderr: `${'x'.repeat(9_000)} tail-token`,
      },
      async () => {
        const { discoverFiles: discoverFilesWithMockedGit } =
          await import('@/discovery/index.js');

        await withWorkspace('filemap-discover-', async (cwd) => {
          await createGitMetadata(cwd);
          await createFixture(cwd, 'src/app.ts');

          const error = await getThrownError(async () => {
            await discoverFilesWithMockedGit({ cwd });
          });
          const message = error.message;

          expect(message).toContain(
            `Failed to run git ls-files in cwd "${cwd}" — Git exited with code 2:`,
          );
          expect(message).toContain('stderr was truncated after');
          expect(message).not.toContain('tail-token');
        });
      },
    );
  });

  test('truncates git ls-files stderr after the limit is reached', async () => {
    await withMockedGitCheckIgnore(
      {
        exitCode: 2,
        mode: 'failed',
        stderrChunks: [
          `fatal: useful prefix ${'x'.repeat(8_192)}`,
          ' tail-token',
        ],
      },
      async () => {
        const { discoverFiles: discoverFilesWithMockedGit } =
          await import('@/discovery/index.js');

        await withWorkspace('filemap-discover-', async (cwd) => {
          await createGitMetadata(cwd);
          await createFixture(cwd, 'src/app.ts');

          const error = await getThrownError(async () => {
            await discoverFilesWithMockedGit({ cwd });
          });
          const message = error.message;

          expect(message).toContain('stderr was truncated after');
          expect(message).toContain('fatal: useful prefix');
          expect(message).not.toContain('tail-token');
        });
      },
    );
  });

  test('escapes Unicode format controls in git ls-files stderr', async () => {
    await withMockedGitCheckIgnore(
      {
        exitCode: 2,
        mode: 'failed',
        stderr: 'fatal: bad \u202ename',
      },
      async () => {
        const { discoverFiles: discoverFilesWithMockedGit } =
          await import('@/discovery/index.js');

        await withWorkspace('filemap-discover-', async (cwd) => {
          await createGitMetadata(cwd);
          await createFixture(cwd, 'src/app.ts');

          await expect(discoverFilesWithMockedGit({ cwd })).rejects.toThrow(
            `Failed to run git ls-files in cwd "${cwd}" — Git exited with code 2: fatal: bad \\u202ename`,
          );
        });
      },
    );
  });

  test('given git ls-files fails without stderr, when discovering, then it says stderr was empty', async () => {
    await withMockedGitCheckIgnore(
      {
        exitCode: 2,
        mode: 'failed',
      },
      async () => {
        const { discoverFiles: discoverFilesWithMockedGit } =
          await import('@/discovery/index.js');

        await withWorkspace('filemap-discover-', async (cwd) => {
          await createGitMetadata(cwd);
          await createFixture(cwd, 'src/app.ts');

          await expect(discoverFilesWithMockedGit({ cwd })).rejects.toThrow(
            `Failed to run git ls-files in cwd "${cwd}" — Git exited with code 2: (no stderr)`,
          );
        });
      },
    );
  });

  test('given git ls-files fails, when running the CLI, then stderr starts with the Git code', async () => {
    await withMockedGitCheckIgnore(
      {
        exitCode: 2,
        mode: 'failed',
        stderr: 'fatal: bad git state',
      },
      async () => {
        const { runCli } = await import('@/cli.js');

        await withWorkspace('filemap-discover-', async (cwd) => {
          await createGitMetadata(cwd);
          await createOverviewFixture(cwd, 'src/app.ts', 'App');

          const result = await runSourceCliInWorkspace(runCli, [], cwd);

          expect(result.exitCode).toBe(1);
          expect(result.stdout).toBe('');
          expect(getFirstStderrLine(result.stderr)).toContain(
            'Failed to run git ls-files',
          );
          expect(result.stderr).toContain(
            'Git exited with code 2: fatal: bad git state',
          );
        });
      },
    );
  });

  test('given git ls-files output is incomplete, when running the CLI, then stderr starts with the Git output error', async () => {
    await withMockedGitCheckIgnore(
      {
        exitCode: 0,
        mode: 'stdoutNonString',
        stdoutChunk: 'src/app.ts',
      },
      async () => {
        const { runCli } = await import('@/cli.js');

        await withWorkspace('filemap-discover-', async (cwd) => {
          await createGitMetadata(cwd);
          await createOverviewFixture(cwd, 'src/app.ts', 'App');

          const result = await runSourceCliInWorkspace(runCli, [], cwd);

          expect(result.exitCode).toBe(1);
          expect(result.stdout).toBe('');
          expect(getFirstStderrLine(result.stderr)).toContain(
            'Failed to read git ls-files output',
          );
          expect(result.stderr).toContain(
            'expected null-separated paths ending with NUL',
          );
        });
      },
    );
  });

  test('given Git says cwd is not a repository, when checking ignores, then it returns notGitRepository', async () => {
    mockGitCheckIgnoreProcess({
      exitCode: 128,
      mode: 'failed',
      stderr:
        'fatal: not a git repository (or any of the parent directories): .git',
    });
    const { findGitIgnoredPaths } = await import('@/git/ignore.js');

    try {
      await withWorkspace('filemap-discover-', async (cwd) => {
        const result = await findGitIgnoredPaths(
          [toDiscoveredRepoPath('src/app.ts', 'filePath')],
          resolveWorkingDirectory(cwd),
        );

        expect(result).toEqual({
          status: 'notGitRepository',
        });
      });
    } finally {
      await restoreGitCheckIgnoreProcess();
    }
  });

  test('given Git is missing, when running the CLI, then stderr starts with the Git code', async () => {
    await withMockedGitCheckIgnore(
      {
        mode: 'spawnMissing',
      },
      async () => {
        const { runCli } = await import('@/cli.js');

        await withWorkspace('filemap-discover-', async (cwd) => {
          await createGitMetadata(cwd);
          await createOverviewFixture(cwd, 'src/app.ts', 'App');

          const result = await runSourceCliInWorkspace(runCli, [], cwd);

          expect(result.exitCode).toBe(1);
          expect(result.stdout).toBe('');
          expect(getFirstStderrLine(result.stderr)).toContain(
            'Failed to run git ls-files',
          );
          expect(result.stderr).toContain('check that Git is installed');
        });
      },
    );
  });

  test('given git ls-files stdout fails with an Error, when running the CLI, then stderr starts with the Git code', async () => {
    await withMockedGitCheckIgnore(
      {
        mode: 'stdoutNonString',
        stdoutChunk: Symbol('invalid stdout chunk'),
      },
      async () => {
        const { runCli } = await import('@/cli.js');

        await withWorkspace('filemap-discover-', async (cwd) => {
          await createGitMetadata(cwd);
          await createOverviewFixture(cwd, 'src/app.ts', 'App');

          const result = await runSourceCliInWorkspace(runCli, [], cwd);

          expect(result.exitCode).toBe(1);
          expect(result.stdout).toBe('');
          expect(getFirstStderrLine(result.stderr)).toContain(
            'Failed to read git ls-files output',
          );
          expect(result.stderr).toContain('Failed to read git ls-files output');
        });
      },
    );
  });

  test('given git ls-files times out, when running the CLI, then stderr explains the timeout', async () => {
    const originalTimeout = process.env['FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS'];
    const gitCheckIgnoreState = mockGitCheckIgnoreProcess({
      mode: 'timeoutCloses',
    });
    const { runCli } = await import('@/cli.js');

    try {
      await withWorkspace('filemap-discover-', async (cwd) => {
        await createGitMetadata(cwd);
        process.env['FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS'] = '1';
        await createOverviewFixture(cwd, 'src/app.ts', 'App');
        vi.useFakeTimers({ toFake: ['clearTimeout', 'setTimeout'] });

        try {
          const resultPromise = runSourceCliInWorkspace(runCli, [], cwd);
          await waitForGitCheckIgnoreSpawn(gitCheckIgnoreState);
          expectGitLsFilesSpawn(gitCheckIgnoreState, cwd);
          await vi.advanceTimersByTimeAsync(1);
          await vi.runOnlyPendingTimersAsync();
          const result = await resultPromise;

          expect(result.exitCode).toBe(1);
          expect(result.stdout).toBe('');
          expect(getFirstStderrLine(result.stderr)).toContain(
            'Timed out running git ls-files',
          );
          expect(result.stderr).toContain('after 1 ms — Git was killed.');
          expect(result.stderr).toContain(
            'Set FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS up to 60000, or run filemap on a narrower scope.',
          );
          expect(gitCheckIgnoreState.killCalls).toBe(1);
        } finally {
          vi.useRealTimers();

          if (originalTimeout === undefined) {
            delete process.env['FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS'];
          } else {
            process.env['FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS'] =
              originalTimeout;
          }
        }
      });
    } finally {
      await restoreGitCheckIgnoreProcess();
    }
  });

  test('given git ls-files ignores the timeout kill, when running the CLI, then stderr explains the timeout setting', async () => {
    const originalTimeout = process.env['FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS'];
    const gitCheckIgnoreState = mockGitCheckIgnoreProcess({
      mode: 'timeoutHangs',
    });
    const { runCli } = await import('@/cli.js');

    try {
      await withWorkspace('filemap-discover-', async (cwd) => {
        await createGitMetadata(cwd);
        process.env['FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS'] = '1';
        await createOverviewFixture(cwd, 'src/app.ts', 'App');
        vi.useFakeTimers({ toFake: ['clearTimeout', 'setTimeout'] });

        try {
          const resultPromise = runSourceCliInWorkspace(runCli, [], cwd);
          await waitForGitCheckIgnoreSpawn(gitCheckIgnoreState);
          expectGitLsFilesSpawn(gitCheckIgnoreState, cwd);
          await vi.advanceTimersByTimeAsync(1);
          await vi.advanceTimersByTimeAsync(1_000);
          const result = await resultPromise;

          expect(result.exitCode).toBe(1);
          expect(result.stdout).toBe('');
          expect(result.stderr).toContain('Timed out running git ls-files');
          expect(result.stderr).toContain(
            'Git was killed but did not close within 1000 ms.',
          );
          expect(result.stderr).toContain(
            'Set FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS up to 60000, or run filemap on a narrower scope.',
          );
          expect(gitCheckIgnoreState.killCalls).toBe(2);
        } finally {
          vi.useRealTimers();

          if (originalTimeout === undefined) {
            delete process.env['FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS'];
          } else {
            process.env['FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS'] =
              originalTimeout;
          }
        }
      });
    } finally {
      await restoreGitCheckIgnoreProcess();
    }
  });

  test('rejects an invalid git check-ignore timeout environment value', async () => {
    const originalTimeout = process.env['FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS'];

    await withWorkspace('filemap-discover-', async (cwd) => {
      await createGitMetadata(cwd);
      process.env['FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS'] = 'fast';
      await createFixture(cwd, 'src/app.ts');

      try {
        await expect(discoverFiles({ cwd })).rejects.toThrow(
          'Invalid FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS "fast" — expected a decimal integer from 1 to 60000 milliseconds.',
        );
      } finally {
        if (originalTimeout === undefined) {
          delete process.env['FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS'];
        } else {
          process.env['FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS'] = originalTimeout;
        }
      }
    });
  });

  test('rejects a non-decimal git check-ignore timeout environment value', async () => {
    const originalTimeout = process.env['FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS'];

    await withWorkspace('filemap-discover-', async (cwd) => {
      await createGitMetadata(cwd);
      process.env['FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS'] = '1e3';
      await createFixture(cwd, 'src/app.ts');

      try {
        await expect(discoverFiles({ cwd })).rejects.toThrow(
          'Invalid FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS "1e3" — expected a decimal integer from 1 to 60000 milliseconds.',
        );
      } finally {
        if (originalTimeout === undefined) {
          delete process.env['FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS'];
        } else {
          process.env['FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS'] = originalTimeout;
        }
      }
    });
  });

  test('rejects a git check-ignore timeout above the allowed range', async () => {
    const originalTimeout = process.env['FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS'];

    await withWorkspace('filemap-discover-', async (cwd) => {
      await createGitMetadata(cwd);
      process.env['FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS'] = '60001';
      await createFixture(cwd, 'src/app.ts');

      try {
        await expect(discoverFiles({ cwd })).rejects.toThrow(
          'Invalid FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS "60001" — expected a decimal integer from 1 to 60000 milliseconds.',
        );
      } finally {
        if (originalTimeout === undefined) {
          delete process.env['FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS'];
        } else {
          process.env['FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS'] = originalTimeout;
        }
      }
    });
  });
});

function mockGitCheckIgnoreProcess(
  overrides: Partial<GitCheckIgnoreMockState>,
): GitCheckIgnoreMockState {
  const state = createGitCheckIgnoreMockState(overrides);

  vi.resetModules();
  vi.doMock('node:child_process', async () => {
    const { EventEmitter } = await import('node:events');

    class MockStream extends EventEmitter {
      setEncoding(_encoding: BufferEncoding): void {}
    }

    class MockStdin extends EventEmitter {
      write(_input: string): boolean {
        if (state.mode === 'stdinWriteEmitsNonError') {
          queueMicrotask(() => {
            this.emit('error', 'mock stdin write failed');
            this.emit('finish');
          });
        }

        return true;
      }

      end(
        inputOrCallback?: (() => void) | string,
        callback?: () => void,
      ): this {
        if (state.mode === 'stdinEndEmitsError') {
          queueMicrotask(() => {
            this.emit('error', new Error('mock Git stdin end failed'));
            queueMicrotask(() => {
              this.emit('finish');
            });
          });
          return this;
        }

        const finishCallback =
          typeof inputOrCallback === 'function' ? inputOrCallback : callback;

        queueMicrotask(() => {
          finishCallback?.();
        });

        if (
          state.mode === 'spawnMissing' ||
          state.mode === 'timeoutCloses' ||
          state.mode === 'timeoutHangs'
        ) {
          return this;
        }

        queueMicrotask(() => {
          this.emit('finish');
        });

        return this;
      }
    }

    return {
      spawn: (command: string, args: readonly string[]) => {
        state.spawnArgs = [command, ...args];
        assertMockedGitSpawn(command, args);

        const child = Object.assign(new EventEmitter(), {
          kill: (_signal?: NodeJS.Signals): boolean => {
            state.killCalls += 1;
            if (state.mode === 'timeoutCloses') {
              queueMicrotask(() => {
                child.emit('close', undefined);
              });
            }
            return true;
          },
          stderr: new MockStream(),
          stdin: new MockStdin(),
          stdout: new MockStream(),
        });

        if (isMockedGitLsFilesSpawn(args)) {
          if (state.mode === 'spawnMissing') {
            queueMicrotask(() => {
              const error = Object.assign(new Error('spawn git ENOENT'), {
                code: 'ENOENT',
              } satisfies Pick<NodeJS.ErrnoException, 'code'>);
              child.emit('error', error);
            });
          }

          if (
            state.mode !== 'spawnMissing' &&
            state.mode !== 'timeoutCloses' &&
            state.mode !== 'timeoutHangs'
          ) {
            queueMicrotask(() => {
              if (state.stdoutChunk !== '') {
                child.stdout.emit('data', state.stdoutChunk);
              }
              for (const stderrChunk of state.stderrChunks ?? [state.stderr]) {
                child.stderr.emit('data', stderrChunk);
              }
              child.emit('close', state.exitCode);
            });
          }

          return child;
        }

        child.stdin.on('finish', () => {
          queueMicrotask(() => {
            if (state.mode === 'stdoutNonString') {
              child.stdout.emit('data', state.stdoutChunk);
            }
            for (const stderrChunk of state.stderrChunks ?? [state.stderr]) {
              child.stderr.emit('data', stderrChunk);
            }
            child.emit('close', state.exitCode);
          });
        });

        if (state.mode === 'spawnMissing') {
          queueMicrotask(() => {
            const error = Object.assign(new Error('spawn git ENOENT'), {
              code: 'ENOENT',
            } satisfies Pick<NodeJS.ErrnoException, 'code'>);
            child.emit('error', error);
          });
        }

        return child;
      },
    };
  });

  return state;
}

function assertMockedGitSpawn(command: string, args: readonly string[]): void {
  if (command !== 'git') {
    throw new Error(
      `Invalid mocked git check-ignore command "${command}" — expected "git".`,
    );
  }

  if (isMockedGitLsFilesSpawn(args)) {
    return;
  }

  if (
    args.length !== 5 ||
    args[0] !== '-C' ||
    args[1] === undefined ||
    args[1] === '' ||
    args[2] !== 'check-ignore' ||
    args[3] !== '-z' ||
    args[4] !== '--stdin'
  ) {
    throw new Error(
      `Invalid mocked git check-ignore args "${args.join(' ')}" — expected "-C <cwd> check-ignore -z --stdin".`,
    );
  }
}

function isMockedGitLsFilesSpawn(args: readonly string[]): boolean {
  return (
    args.length === 7 &&
    args[0] === '-C' &&
    args[1] !== undefined &&
    args[1] !== '' &&
    args[2] === 'ls-files' &&
    args[3] === '--cached' &&
    args[4] === '--others' &&
    args[5] === '--exclude-standard' &&
    args[6] === '-z'
  );
}

async function withMockedGitCheckIgnore(
  overrides: Partial<GitCheckIgnoreMockState>,
  run: () => Promise<void>,
): Promise<void> {
  mockGitCheckIgnoreProcess(overrides);

  try {
    await run();
  } finally {
    await restoreGitCheckIgnoreProcess();
  }
}

async function restoreGitCheckIgnoreProcess(): Promise<void> {
  vi.doUnmock('node:child_process');
  vi.resetModules();
}

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

async function waitForGitCheckIgnoreSpawn(
  state: GitCheckIgnoreMockState,
): Promise<void> {
  const maxAttempts = 100;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (state.spawnArgs !== undefined) {
      return;
    }

    await waitForEventLoopTurn();
  }

  throw new Error('Timed out waiting for mocked Git to spawn.');
}

function expectGitLsFilesSpawn(
  state: GitCheckIgnoreMockState,
  cwd: string,
): void {
  expect(state.spawnArgs).toEqual([
    'git',
    '-C',
    cwd,
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '-z',
  ]);
}

async function waitForEventLoopTurn(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

interface CliResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

async function runSourceCliInWorkspace(
  runCli: typeof import('@/cli.js').runCli,
  args: readonly string[],
  cwd: string,
): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const exitCode = await runCli(
    ['node', 'filemap', ...args],
    {
      writeStderr(message: string) {
        stderr.push(message);
      },
      writeStdout(message: string) {
        stdout.push(message);
      },
    },
    { invocationCwd: cwd },
  );

  return {
    exitCode,
    stderr: stderr.join(''),
    stdout: stdout.join(''),
  };
}

function getFirstStderrLine(stderr: string): string {
  return stderr.split('\n')[0] ?? '';
}

async function createGitMetadata(cwd: string): Promise<void> {
  await mkdir(join(cwd, '.git'));
}
