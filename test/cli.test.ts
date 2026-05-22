import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

import { handleCliProcessOutputError, runCli as runSourceCli } from '@/cli.js';
import {
  buildDiscoverOptions,
  buildMapInputOptions,
  type SharedCliOptions,
  toDiscoveryOptionInput,
} from '@/cli/options.js';
import { toCwdPath } from '@/paths/brands.js';
import { normalizeRepoScope } from '@/paths/scope.js';
import { validateDepth } from '@/pipeline/depth.js';
import { validateTag } from '@/pipeline/tag.js';
import { validateMaxFiles } from '@/shared/max-files.js';

import {
  createFixture,
  createOverviewFixture,
  initializeGitRepository,
  withMockedFsPromises,
  withWorkspace,
} from './helpers.js';

const STRICT_OVERVIEW_TAG_FAILURE =
  'missing an overview tag (@fileoverview, @file, or @overview)';
const STRICT_FILE_RECOVERY =
  'Add an overview tag to each file, or run without --strict.';
const STRICT_DIRECTORY_RECOVERY =
  'Add a .overview file to each collapsed directory, remove the collapse flag, or run without --strict.';
const HELP_TEXT_LINE_WIDTH = 78;
const LARGE_COLLAPSED_TREE_FILE_COUNT = 10_001;
const LARGE_COLLAPSED_TREE_TEST_TIMEOUT_MS = 10_000;

describe('buildDiscoverOptions', () => {
  test('keeps discovery options minimal when optional fields are omitted', () => {
    const options: SharedCliOptions = {
      collapseDirs: undefined,
      debug: false,
      noDefaultExcludes: false,
      scope: undefined,
      strict: false,
      tag: undefined,
    };

    expect(
      buildDiscoverOptions(toDiscoveryOptionInput(options), toCwdPath('/repo')),
    ).toEqual({
      cwd: '/repo',
    });
  });

  test('given shared CLI options, when projecting them, then discovery and map building get their own fields', () => {
    const depth = validateDepth(1);
    const maxFiles = validateMaxFiles(100);
    const scope = normalizeRepoScope('src');
    const tag = validateTag('@summary');

    if (scope === undefined) {
      throw new Error('Expected test scope to normalize.');
    }

    const options: SharedCliOptions = {
      collapseDirs: ['docs'],
      debug: true,
      depth,
      exclude: ['dist/**'],
      excludeGroups: ['tests'],
      ext: ['ts'],
      include: ['src/app.test.ts'],
      includeGroups: ['config'],
      maxFiles,
      noDefaultExcludes: true,
      scope,
      strict: true,
      tag,
    };
    const discoveryOptions = toDiscoveryOptionInput(options);

    expect(discoveryOptions).toEqual({
      exclude: ['dist/**'],
      excludeGroups: ['tests'],
      ext: ['ts'],
      include: ['src/app.test.ts'],
      includeGroups: ['config'],
      maxFiles,
      noDefaultExcludes: true,
      scope: 'src',
    });

    expect(buildDiscoverOptions(discoveryOptions, toCwdPath('/repo'))).toEqual({
      cwd: '/repo',
      exclude: ['dist/**'],
      excludeGroups: ['tests'],
      ext: ['ts'],
      include: ['src/app.test.ts'],
      includeGroups: ['config'],
      maxFiles,
      noDefaultExcludes: true,
      scope: 'src',
    });

    expect(buildMapInputOptions(options, toCwdPath('/repo'))).toEqual({
      collapseDirs: ['docs'],
      cwd: '/repo',
      depth,
      maxFiles,
      scope: 'src',
      tag,
    });
  });
});

describe('filemap CLI', () => {
  test('given invalid argv, when running filemap, then it fails before parsing', async () => {
    await expect(
      runSourceCli(null, createCliTestOutput(), {
        invocationCwd: process.cwd(),
      }),
    ).rejects.toThrow('Invalid argv "null" — expected an array of strings.');
  });

  test('given argv contains a non-string, when running filemap, then it fails before parsing', async () => {
    await expect(
      runSourceCli(['node', 123], createCliTestOutput(), {
        invocationCwd: process.cwd(),
      }),
    ).rejects.toThrow('Invalid argv[1] "123" — expected a non-empty string.');
  });

  test('given argv contains an empty string, when running filemap, then it fails before parsing', async () => {
    await expect(
      runSourceCli(['node', ''], createCliTestOutput(), {
        invocationCwd: process.cwd(),
      }),
    ).rejects.toThrow('Invalid argv[1] "" — expected a non-empty string.');
  });

  test('given invalid runtime, when running filemap, then it fails before redacting paths', async () => {
    await expect(
      runSourceCli(['node', 'filemap'], createCliTestOutput(), null),
    ).rejects.toThrow('Invalid runtime "null" — expected an options object.');
  });

  test('given invalid output writer, when running filemap, then it fails before writing output', async () => {
    await expect(
      runSourceCli(
        ['node', 'filemap'],
        {
          writeStderr: 'bad',
          writeStdout() {},
        },
        { invocationCwd: process.cwd() },
      ),
    ).rejects.toThrow(
      'Invalid output.writeStderr "bad" — expected a function.',
    );
  });

  test('given stdout closes early, when Node reports EPIPE, then filemap exits quietly', () => {
    const originalExitCode = process.exitCode;
    const error = Object.assign(new Error('write EPIPE'), {
      code: 'EPIPE',
    } satisfies Pick<NodeJS.ErrnoException, 'code'>);

    try {
      expect(() => {
        handleCliProcessOutputError(error, 'stdout');
      }).not.toThrow();
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  test('given stderr closes early, when Node reports EPIPE, then filemap keeps the failure loud', () => {
    const error = Object.assign(new Error('write EPIPE'), {
      code: 'EPIPE',
    } satisfies Pick<NodeJS.ErrnoException, 'code'>);

    expect(() => {
      handleCliProcessOutputError(error, 'stderr');
    }).toThrow(error);
  });

  test('given stdout has a non-pipe error, when Node reports it, then filemap keeps the failure loud', () => {
    const error = Object.assign(new Error('write failed'), {
      code: 'EIO',
    } satisfies Pick<NodeJS.ErrnoException, 'code'>);

    expect(() => {
      handleCliProcessOutputError(error, 'stdout');
    }).toThrow(error);
  });

  test('given stdout throws a non-error, when Node reports it, then filemap wraps the value', () => {
    expect(() => {
      handleCliProcessOutputError('mock stream failed', 'stdout');
    }).toThrow(
      'Failed to write stdout — output stream failed with a non-error value "mock stream failed".',
    );
  });

  test('given command parsing rejects with a non-error, when running filemap, then it formats the failure', async () => {
    const actualCommander =
      await vi.importActual<typeof import('commander')>('commander');

    vi.resetModules();
    vi.doMock('commander', () => ({
      ...actualCommander,
      Command: class MockCommand extends actualCommander.Command {
        public override parseAsync(): Promise<this> {
          const rejectedValue: unknown = 'mock parse failed';

          return Promise.reject(rejectedValue);
        }
      },
    }));

    try {
      const { runCli: runCliWithMockedCommander } = await import('@/cli.js');
      const stderr: string[] = [];
      const exitCode = await runCliWithMockedCommander(
        ['node', 'filemap'],
        {
          writeStderr(message: string) {
            stderr.push(message);
          },
          writeStdout() {},
        },
        { invocationCwd: toCwdPath(process.cwd()) },
      );

      expect(exitCode).toBe(1);
      expect(stderr.join('')).toContain(
        'Caught non-Error value "mock parse failed".',
      );
    } finally {
      vi.doUnmock('commander');
      vi.resetModules();
    }
  });

  test('given source files, when running filemap, then it renders the file map', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      await createFixture(
        cwd,
        'src/app.ts',
        '/** @fileoverview App module */\nexport const app = true;\n',
      );

      const result = await runCli([], cwd);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('./src/app.ts — App module\n');
    });
  });

  test('given source files, when injecting output writers, then it prints the rendered map', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      await createFixture(
        cwd,
        'src/app.ts',
        '/** @fileoverview App module */\nexport const app = true;\n',
      );
      await createFixture(
        cwd,
        'src/lib.ts',
        '/** @fileoverview Library module */\nexport const lib = true;\n',
      );

      const result = await runCliWithInjectedWriters([], cwd);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe(
        './src/app.ts — App module\n./src/lib.ts — Library module\n',
      );
    });
  });

  test('given invalid input, when running filemap, then it formats the error', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      const result = await runCli(['--depth', 'bad'], cwd);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        'Invalid depth "bad" — expected a non-negative decimal integer.',
      );
    });
  });

  test('given source files, when running filemap, then it prints the map to stdout', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      await createFixture(
        cwd,
        'src/app.ts',
        '/** @fileoverview App module */\nexport const app = true;\n',
      );
      await createFixture(cwd, 'src/lib.ts', 'export const lib = true;\n');

      const result = await runCli([], cwd);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('./src/app.ts — App module\n./src/lib.ts\n');
    });
  });

  test('given no flags, when defaults could change output, then it keeps normal stdout behavior', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      await createFixture(
        cwd,
        'src/app.ts',
        '/** @fileoverview App module */\nexport const app = true;\n',
      );
      await createFixture(cwd, 'src/lib.ts', 'export const lib = true;\n');
      await createFixture(
        cwd,
        'src/app.test.ts',
        '/** @fileoverview App test */\nexport const test = true;\n',
      );

      const result = await runCli([], cwd);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('./src/app.ts — App module\n./src/lib.ts\n');
    });
  });

  test('given a directory scope, when running filemap, then it prints scope-relative paths', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      await createFixture(
        cwd,
        'src/auth/login.ts',
        '/** @fileoverview Login */\nexport const login = true;\n',
      );
      await createFixture(
        cwd,
        'src/auth/signup.ts',
        '/** @fileoverview Signup */\nexport const signup = true;\n',
      );
      await createOverviewFixture(cwd, 'src/app.ts', 'App');

      const result = await runCli(['src/auth'], cwd);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('./login.ts — Login\n./signup.ts — Signup\n');
    });
  });

  test('given a scoped collapsed directory root, when running filemap, then it prints the root as scope-relative', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      await createFixture(
        cwd,
        'src/auth/login.ts',
        '/** @fileoverview Login */\nexport const login = true;\n',
      );
      await createFixture(
        cwd,
        'src/auth/signup.ts',
        '/** @fileoverview Signup */\nexport const signup = true;\n',
      );
      await createFixture(cwd, 'src/auth/.overview', 'Auth features\n');

      const result = await runCli(
        ['src/auth', '--collapse-dir', 'src/auth'],
        cwd,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('./ — Auth features (2 files)\n');
    });
  });

  test('given a file scope, when running filemap, then it prints only that file', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      await createFixture(
        cwd,
        'src/auth/login.ts',
        '/** @fileoverview Login */\nexport const login = true;\n',
      );
      await createFixture(
        cwd,
        'src/auth/signup.ts',
        '/** @fileoverview Signup */\nexport const signup = true;\n',
      );

      const result = await runCli(['src/auth/login.ts'], cwd);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('./src/auth/login.ts — Login\n');
    });
  });

  test('given a root file scope and depth, when running filemap, then it prints only that file', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      await createFixture(
        cwd,
        'root.ts',
        '/** @fileoverview Root */\nexport const root = true;\n',
      );
      await createOverviewFixture(cwd, 'src/app.ts', 'App');

      const result = await runCli(['root.ts', '--depth', '0'], cwd);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('./root.ts — Root\n');
    });
  });

  test('given a missing scope path, when running filemap, then stderr starts with the usage code', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      const result = await runCli(['missing/path'], cwd);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        'Invalid scope "missing/path" — expected an existing file or directory relative to cwd',
      );
    });
  });

  test('given a custom tag, when running filemap, then it reads that tag instead of the defaults', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      await createFixture(
        cwd,
        'src/custom.ts',
        '/** @custom Custom module */\nexport const custom = true;\n',
      );
      await createFixture(
        cwd,
        'src/default.ts',
        '/** @fileoverview Default module */\nexport const fallback = true;\n',
      );

      const result = await runCli(['--tag', '@custom'], cwd);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe(
        './src/custom.ts — Custom module\n./src/default.ts\n',
      );
    });
  });

  test('given custom tag strict mode, when a visible file misses that tag, then it names the tag', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      await createFixture(
        cwd,
        'src/custom.ts',
        '/** @custom Custom module */\nexport const custom = true;\n',
      );
      await createFixture(
        cwd,
        'src/default.ts',
        '/** @fileoverview Default module */\nexport const fallback = true;\n',
      );

      const result = await runCli(['--strict', '--tag', '@custom'], cwd);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('filemap: 1 file missing @custom:');
      expect(result.stderr).toContain('- src/default.ts');
    });
  });

  test('given extension flags, when running filemap, then it scans those extensions instead of defaults', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      await createFixture(
        cwd,
        'docs/page.md',
        '<!-- @fileoverview Docs page -->\n',
      );
      await createOverviewFixture(cwd, 'src/app.ts', 'App');

      const result = await runCli(['--ext', 'md'], cwd);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('./docs/page.md — Docs page\n');
    });
  });

  test('given a test directory scope, when including test groups, then it prints direct test children', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      await createFixture(
        cwd,
        'test/unit.ts',
        '/** @fileoverview Unit tests */\nexport const unit = true;\n',
      );
      await createOverviewFixture(cwd, 'src/app.ts', 'App');

      const result = await runCli(['test', '--include-groups', 'tests'], cwd);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('./unit.ts — Unit tests\n');
    });
  });

  test('given include and exclude flags, when both match soft-excluded files, then exclude wins', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      await createOverviewFixture(cwd, 'src/app.ts', 'App');
      await createFixture(
        cwd,
        'src/app.test.ts',
        '/** @fileoverview App test */\nexport const test = true;\n',
      );
      await createFixture(
        cwd,
        'src/skip.test.ts',
        '/** @fileoverview Skipped test */\nexport const skip = true;\n',
      );

      const result = await runCli(
        ['--include', '**/*.test.ts', '--exclude', 'src/skip.test.ts'],
        cwd,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe(
        './src/app.test.ts — App test\n./src/app.ts — App\n',
      );
    });
  });

  test('given include enables rescue mode, when exclude is a root glob, then exclude keeps the same depth rule', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      await createFixture(
        cwd,
        'root.ts',
        '/** @fileoverview Root */\nexport const root = true;\n',
      );
      await createFixture(
        cwd,
        'src/nested.ts',
        '/** @fileoverview Nested */\nexport const nested = true;\n',
      );

      const withoutInclude = await runCli(['--exclude', '*.ts'], cwd);
      const withInclude = await runCli(
        ['--exclude', '*.ts', '--include', 'src/**'],
        cwd,
      );

      expect(withoutInclude.exitCode).toBe(0);
      expect(withoutInclude.stderr).toBe('');
      expect(withoutInclude.stdout).toBe('./src/nested.ts — Nested\n');
      expect(withInclude).toEqual(withoutInclude);
    });
  });

  test('given include and exclude group flags, when both affect config files, then exclude group wins', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      await createOverviewFixture(cwd, 'src/app.ts', 'App');
      await createFixture(
        cwd,
        'vitest.config.ts',
        '/** @fileoverview Vitest config */\nexport default {};\n',
      );
      await createFixture(
        cwd,
        'test/unit.ts',
        '/** @fileoverview Unit test */\nexport const unit = true;\n',
      );

      const result = await runCli(
        ['--include-groups', 'tests', '--exclude-groups', 'config'],
        cwd,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe(
        './src/app.ts — App\n./test/unit.ts — Unit test\n',
      );
    });
  });

  test('given debug mode, when running filemap, then it writes discovery details to stderr', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      await createOverviewFixture(cwd, 'src/app.ts', 'App');
      await createFixture(
        cwd,
        'src/app.test.ts',
        '/** @fileoverview App test */\nexport const test = true;\n',
      );

      const result = await runCli(
        ['--debug', '--include', '**/*.test.ts'],
        cwd,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        './src/app.test.ts — App test\n./src/app.ts — App\n',
      );
      expect(result.stderr).toContain('filemap debug');
      expect(result.stderr).toContain('cwd: .');
      expect(result.stderr).toContain(
        [
          'filters:',
          '  extensions: ts, tsx, mts, cts, js, jsx, mjs, cjs, php, py, rb, go, rs, java, swift, kt',
          '  include: **/*.test.ts',
          '  include groups: (none)',
          '  exclude: (none)',
          '  exclude groups: (none)',
          '  default excludes: on',
          '  rescue mode: on',
        ].join('\n'),
      );
      expect(result.stderr).not.toContain('visible scan:');
      expect(result.stderr).not.toContain('git check-ignore:');
      expect(result.stderr).toContain('result: 2 files');
      expect(result.stderr).toMatch(
        /timing:\n {2}discovery: \d+ ms\n {2}map build: \d+ ms/u,
      );
    });
  });

  test('given debug mode without default excludes, when running filemap, then stderr says defaults are off', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      await createOverviewFixture(cwd, 'src/app.ts', 'App');

      const result = await runCli(['--debug', '--no-default-excludes'], cwd);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('./src/app.ts — App\n');
      expect(result.stderr).toContain('default excludes: off');
    });
  });

  test('given a depth flag, when nested files are deeper than the limit, then it collapses them', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      await createOverviewFixture(cwd, 'src/app.ts', 'App');
      await createFixture(
        cwd,
        'src/auth/login.ts',
        '/** @fileoverview Login */\nexport const login = true;\n',
      );
      await createFixture(
        cwd,
        'src/auth/utils/hash.ts',
        '/** @fileoverview Hash */\nexport const hash = true;\n',
      );

      const result = await runCli(['--depth', '1'], cwd);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('./src/app.ts — App\n./src/auth/ (2 files)\n');
    });
  });

  test('given an invalid depth with Unicode format controls, when running filemap, then stderr escapes it', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      const result = await runCli(['--depth', '1\u202e'], cwd);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        'Invalid depth "1\\u202e" — expected a non-negative decimal integer.',
      );
      expect(result.stderr).not.toContain('\u202e');
    });
  });

  test.each(['0x10', '1e3'])(
    'given non-decimal depth %s, when running filemap, then it is rejected',
    async (depth) => {
      await withWorkspace('filemap-cli-', async (cwd) => {
        const result = await runCli(['--depth', depth], cwd);

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain(
          `Invalid depth "${depth}" — expected a non-negative decimal integer.`,
        );
      });
    },
  );

  test('given non-decimal max-files, when running filemap, then it is rejected', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      const result = await runCli(['--max-files', '1e3'], cwd);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        'Invalid max-files "1e3" — expected a positive decimal integer up to 200000.',
      );
    });
  });

  test('given zero max-files, when running filemap, then it is rejected', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      const result = await runCli(['--max-files', '0'], cwd);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        'Invalid max-files "0" — expected a positive decimal integer up to 200000.',
      );
    });
  });

  test('given too many max-files, when running filemap, then it is rejected', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      const result = await runCli(['--max-files', '200001'], cwd);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        'Invalid max-files "200001" — expected a positive decimal integer up to 200000.',
      );
    });
  });

  test('given discovered files exceed max-files, when running filemap, then it fails before output', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      await createFixture(
        cwd,
        'src/a.ts',
        '/** @fileoverview A */\nexport const a = true;\n',
      );
      await createFixture(
        cwd,
        'src/b.ts',
        '/** @fileoverview B */\nexport const b = true;\n',
      );
      await createFixture(
        cwd,
        'src/c.ts',
        '/** @fileoverview C */\nexport const c = true;\n',
      );

      const result = await runCli(['--max-files', '2'], cwd);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(getFirstStderrLine(result.stderr)).toContain(
        'Filemap found 3 discovered or visible files before Git ignore filtering',
      );
      expect(result.stderr).toContain(
        'Filemap found 3 discovered or visible files before Git ignore filtering, which exceeds the max-files limit of 2.',
      );
      expect(result.stderr).toContain('Re-run with --max-files 3');
    });
  });

  test('given debug and max-files fails during discovery, when running filemap, then stderr includes a short summary', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      await createFixture(
        cwd,
        'src/a.ts',
        '/** @fileoverview A */\nexport const a = true;\n',
      );
      await createFixture(
        cwd,
        'src/b.ts',
        '/** @fileoverview B */\nexport const b = true;\n',
      );
      await createFixture(
        cwd,
        'src/c.ts',
        '/** @fileoverview C */\nexport const c = true;\n',
      );

      const result = await runCli(['--debug', '--max-files', '2'], cwd);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(getFirstStderrLine(result.stderr)).toContain(
        'Filemap found 3 discovered or visible files before Git ignore filtering',
      );
      expect(result.stderr).toContain('filemap debug');
      expect(result.stderr).toContain('result: failed before file count');
    });
  });

  test('given visible files stay below max-files, when running filemap, then it passes the limit to map building', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      await createFixture(
        cwd,
        'src/a.ts',
        '/** @fileoverview A */\nexport const a = true;\n',
      );
      await createFixture(
        cwd,
        'src/b.ts',
        '/** @fileoverview B */\nexport const b = true;\n',
      );

      const result = await runCli(['--max-files', '2'], cwd);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('./src/a.ts — A\n./src/b.ts — B\n');
    });
  });

  test(
    'given a large collapsed tree, when max-files is raised, then depth can reduce visible output',
    async () => {
      await withWorkspace('filemap-cli-', async (cwd) => {
        await createLargeCollapsedTree(cwd);

        const result = await runCli(
          ['--depth', '0', '--max-files', '10002'],
          cwd,
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toBe(
          `./src/ (${String(LARGE_COLLAPSED_TREE_FILE_COUNT)} files)\n`,
        );
      });
    },
    LARGE_COLLAPSED_TREE_TEST_TIMEOUT_MS,
  );

  test('given depth hides discovered files, when running filemap, then only visible files are validated', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      await createOverviewFixture(cwd, 'src/app.ts', 'App');
      await createFixture(
        cwd,
        'src/auth/login.ts',
        'export const login = true;\n',
      );
      await createFixture(
        cwd,
        'src/auth/logout.ts',
        'export const logout = true;\n',
      );
      const validatedSourcePaths: string[] = [];

      await withMockedFsPromises(
        (actualFs) => ({
          lstat: async (
            path: Parameters<typeof actualFs.lstat>[0],
            options?: Parameters<typeof actualFs.lstat>[1],
          ): Promise<Awaited<ReturnType<typeof actualFs.lstat>>> => {
            if (String(path).endsWith('.ts')) {
              validatedSourcePaths.push(String(path));
            }

            return actualFs.lstat(path, options);
          },
        }),
        async () => {
          const { runCli: runCliWithMockedFs } = await import('@/cli.js');
          const result = await runCliWithSourceModule(
            runCliWithMockedFs,
            ['--depth', '1'],
            cwd,
          );

          expect(result.exitCode).toBe(0);
          expect(result.stderr).toBe('');
          expect(result.stdout).toBe(
            './src/app.ts — App\n./src/auth/ (2 files)\n',
          );
          expect([...validatedSourcePaths].sort()).toEqual([
            join(cwd, 'src/app.ts'),
          ]);
        },
      );
    });
  });

  test('given git ls-files fails, when running filemap, then stderr hides the full cwd', async () => {
    await withMockedGitLsFilesFailure(async () => {
      const { runCli: runCliWithMockedGit } = await import('@/cli.js');

      await withWorkspace('filemap-cli-', async (cwd) => {
        await mkdir(join(cwd, '.git'), { recursive: true });
        await createOverviewFixture(cwd, 'src/app.ts', 'App');

        const result = await runCliWithSourceModule(
          runCliWithMockedGit,
          [],
          cwd,
        );

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe('');
        expect(getFirstStderrLine(result.stderr)).toContain(
          'Failed to run git ls-files in cwd "."',
        );
        expect(result.stderr).toContain(
          'Failed to run git ls-files in cwd "."',
        );
        expect(result.stderr).toContain(
          'Git exited with code 2: fatal: bad git state',
        );
        expect(result.stderr).not.toContain(cwd);
      });
    });
  });

  test('given map building throws a non-error, when running filemap, then it formats the failure', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      await createOverviewFixture(cwd, 'src/app.ts', 'App');
      const actualPipeline = await vi.importActual<
        typeof import('@/pipeline/index.js')
      >('@/pipeline/index.js');

      vi.resetModules();
      vi.doMock('@/pipeline/index.js', () => ({
        ...actualPipeline,
        buildMapFromDiscoveredFiles: (): Promise<never> => {
          const rejectedValue: unknown = 'mock map build failed';

          return Promise.reject(rejectedValue);
        },
      }));

      try {
        const { runCli: runCliWithMockedPipeline } = await import('@/cli.js');
        const result = await runCliWithSourceModule(
          runCliWithMockedPipeline,
          [],
          cwd,
        );

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain(
          'Caught non-Error value "mock map build failed".',
        );
      } finally {
        vi.doUnmock('@/pipeline/index.js');
        vi.resetModules();
      }
    });
  });

  test('given a gitignore file, when running filemap, then ignored files stay hidden', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      initializeGitRepository(cwd);
      await createFixture(cwd, '.gitignore', 'src/ignored.ts\n');
      await createOverviewFixture(cwd, 'src/app.ts', 'App');
      await createFixture(
        cwd,
        'src/ignored.ts',
        '/** @fileoverview Ignored */\nexport const ignored = true;\n',
      );

      const result = await runCli([], cwd);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('./src/app.ts — App\n');
    });
  });

  test('given no-default-excludes, when default-hidden files exist, then it includes them', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      await createOverviewFixture(cwd, 'src/app.ts', 'App');
      await createFixture(
        cwd,
        'src/app.test.ts',
        '/** @fileoverview App test */\nexport const test = true;\n',
      );

      const result = await runCli(['--no-default-excludes'], cwd);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe(
        './src/app.test.ts — App test\n./src/app.ts — App\n',
      );
    });
  });

  test('given the removed default-excludes flag, when running filemap, then it is rejected', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      await createOverviewFixture(cwd, 'src/app.ts', 'App');
      await createFixture(
        cwd,
        'src/app.test.ts',
        '/** @fileoverview App test */\nexport const test = true;\n',
      );

      const result = await runCli(['--default-excludes'], cwd);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        "error: unknown option '--default-excludes'",
      );
      expect(result.stderr).toContain(
        "error: unknown option '--default-excludes'\n(Did you mean --no-default-excludes?)",
      );
      expect(result.stderr).not.toContain('\\u000a');
    });
  });

  test('given undocumented files, when running strict mode, then it explains how to fix them', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      await createFixture(cwd, 'src/app.ts', 'export const app = true;\n');

      const result = await runCli(['--strict'], cwd);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(STRICT_OVERVIEW_TAG_FAILURE);
      expect(result.stderr).toContain('- src/app.ts');
      expect(result.stderr).toContain(STRICT_FILE_RECOVERY);
    });
  });

  test('given many undocumented files, when running strict mode, then it caps missing file paths', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      const missingFileCount = 52;

      for (let index = 1; index <= missingFileCount; index += 1) {
        const fileNumber = String(index).padStart(2, '0');
        await createFixture(
          cwd,
          `src/file-${fileNumber}.ts`,
          'export const value = true;\n',
        );
      }

      const result = await runCli(['--strict'], cwd);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('- src/file-01.ts');
      expect(result.stderr).toContain('- src/file-50.ts');
      expect(result.stderr).not.toContain('- src/file-51.ts');
      expect(result.stderr).not.toContain('- src/file-52.ts');
      expect(result.stderr).toContain(
        '2 more missing paths not shown. Run with --debug to show all missing paths.',
      );
    });
  });

  test('given debug strict mode with many undocumented files, when running filemap, then it prints every missing file path', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      const missingFileCount = 52;

      for (let index = 1; index <= missingFileCount; index += 1) {
        const fileNumber = String(index).padStart(2, '0');
        await createFixture(
          cwd,
          `src/file-${fileNumber}.ts`,
          'export const value = true;\n',
        );
      }

      const result = await runCli(['--debug', '--strict'], cwd);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('- src/file-01.ts');
      expect(result.stderr).toContain('- src/file-52.ts');
      expect(result.stderr).not.toContain('more missing paths not shown');
    });
  });

  test('given debug strict mode fails, when running filemap, then stderr starts with the strict code', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      await createFixture(cwd, 'src/app.ts', 'export const app = true;\n');

      const result = await runCli(['--debug', '--strict'], cwd);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(getFirstStderrLine(result.stderr)).toContain('filemap: 1 file');
      expect(result.stderr).toContain('filemap debug');
      expect(result.stderr.indexOf('filemap: 1 file')).toBeLessThan(
        result.stderr.indexOf('filemap debug'),
      );
    });
  });

  test('given all visible files are documented, when running strict mode, then it prints the map', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      await createFixture(
        cwd,
        'src/app.ts',
        '/** @fileoverview App module */\nexport const app = true;\n',
      );

      const result = await runCli(['--strict'], cwd);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('./src/app.ts — App module\n');
    });
  });

  test('given a collapsed directory with sidecar text, when running strict filemap, then it prints one directory row', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      await createFixture(
        cwd,
        'scripts/build.ts',
        '/** @fileoverview Build script */\nexport const build = true;\n',
      );
      await createFixture(
        cwd,
        'scripts/deploy.ts',
        '/** @fileoverview Deploy script */\nexport const deploy = true;\n',
      );
      await createFixture(
        cwd,
        'scripts/.overview',
        'Build, release, and local maintenance commands\n',
      );

      const result = await runCli(
        ['--strict', '--collapse-dir', 'scripts'],
        cwd,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe(
        './scripts/ — Build, release, and local maintenance commands (2 files)\n',
      );
    });
  });

  test('given a collapsed directory without sidecar text, when running strict mode, then it explains how to fix it', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      await createFixture(
        cwd,
        'scripts/build.ts',
        '/** @fileoverview Build script */\nexport const build = true;\n',
      );

      const result = await runCli(
        ['--strict', '--collapse-dir', 'scripts'],
        cwd,
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        'filemap: 1 collapsed directory missing .overview sidecar:',
      );
      expect(result.stderr).toContain('- scripts/');
      expect(result.stderr).toContain(STRICT_DIRECTORY_RECOVERY);
    });
  });

  test('given many collapsed directories without sidecars, when running strict mode, then it caps missing directory paths', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      const missingDirectoryCount = 52;
      const args = ['--strict'];

      for (let index = 1; index <= missingDirectoryCount; index += 1) {
        const directoryNumber = String(index).padStart(2, '0');
        const directoryPath = `scripts/dir-${directoryNumber}`;
        await createFixture(
          cwd,
          `${directoryPath}/build.ts`,
          '/** @fileoverview Build script */\nexport const build = true;\n',
        );
        args.push('--collapse-dir', directoryPath);
      }

      const result = await runCli(args, cwd);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('- scripts/dir-01/');
      expect(result.stderr).toContain('- scripts/dir-50/');
      expect(result.stderr).not.toContain('- scripts/dir-51/');
      expect(result.stderr).not.toContain('- scripts/dir-52/');
      expect(result.stderr).toContain(
        '2 more missing paths not shown. Run with --debug to show all missing paths.',
      );
    });
  });

  test('given a malformed sidecar, when running filemap, then stderr starts with the sidecar code', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      await createFixture(
        cwd,
        'scripts/build.ts',
        '/** @fileoverview Build script */\nexport const build = true;\n',
      );
      await createFixture(cwd, 'scripts/.overview', 'A'.repeat(64 * 1024 + 1));

      const result = await runCli(['--collapse-dir', 'scripts'], cwd);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(getFirstStderrLine(result.stderr)).toContain(
        'Invalid sidecar "scripts/.overview"',
      );
      expect(result.stderr).toContain(
        'Invalid sidecar "scripts/.overview" — expected a file no larger than 65536 bytes.',
      );
    });
  });

  test('given a sidecar read fails, when running filemap, then stderr hides the full sidecar path', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      const sidecarPath = join(cwd, 'scripts/.overview');
      await createFixture(
        cwd,
        'scripts/build.ts',
        '/** @fileoverview Build script */\nexport const build = true;\n',
      );
      await createFixture(cwd, 'scripts/.overview', 'Build scripts\n');
      const readError = Object.assign(new Error('Mock sidecar read failed.'), {
        code: 'EACCES',
      } satisfies Pick<NodeJS.ErrnoException, 'code'>);

      await withMockedFsPromises(
        (actualFs) => {
          const mockFileHandle = {
            close: vi.fn(async (): Promise<void> => {}),
            read: vi.fn(async (): Promise<never> => {
              throw readError;
            }),
            stat: vi.fn(async () => actualFs.stat(sidecarPath)),
          };

          return {
            open: async (
              path: Parameters<typeof actualFs.open>[0],
              flags?: Parameters<typeof actualFs.open>[1],
              mode?: Parameters<typeof actualFs.open>[2],
            ): Promise<
              Awaited<ReturnType<typeof actualFs.open>> | typeof mockFileHandle
            > => {
              if (String(path) === sidecarPath) {
                return mockFileHandle;
              }

              return actualFs.open(path, flags, mode);
            },
          };
        },
        async () => {
          const { runCli: runCliWithMockedFs } = await import('@/cli.js');
          const result = await runCliWithSourceModule(
            runCliWithMockedFs,
            ['--collapse-dir', 'scripts'],
            cwd,
          );

          expect(result.exitCode).toBe(1);
          expect(result.stdout).toBe('');
          expect(getFirstStderrLine(result.stderr)).toContain(
            'Failed to read sidecar "./scripts/.overview"',
          );
          expect(result.stderr).toContain(
            'Failed to read sidecar "./scripts/.overview" — check that the file is readable or remove the collapse directory.',
          );
          expect(result.stderr).not.toContain(cwd);
          expect(result.stderr).not.toContain(sidecarPath);
        },
      );
    });
  });

  test('given help output, when printing help, then it describes stdout use', async () => {
    await withWorkspace('filemap-cli-', async (cwd) => {
      const result = await runCli(['--help'], cwd);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('filemap is read-only');
      expect(result.stdout).toContain(
        'Add @fileoverview, @file, or @overview near the top',
      );
      expect(result.stdout).toContain('See README.md for setup');
      expect(result.stdout).not.toContain(
        'FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS',
      );
      expect(result.stdout).not.toContain('npx @dvyio/filemap');
      expect(result.stdout).toContain('$ filemap');
      expect(result.stdout).toContain('filemap --strict > /dev/null');
      expect(result.stdout.split('\n').length).toBeLessThanOrEqual(70);
      expect(getOverlongHelpProseLines(result.stdout)).toEqual([]);
    });
  });
});

interface CliResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

function createCliTestOutput(): {
  readonly writeStderr: (message: string) => void;
  readonly writeStdout: (message: string) => void;
} {
  return {
    writeStderr() {},
    writeStdout() {},
  };
}

function getOverlongHelpProseLines(helpText: string): readonly string[] {
  return helpText.split('\n').filter((line) => {
    return (
      line.length > HELP_TEXT_LINE_WIDTH &&
      !isCommanderOptionLine(line) &&
      !isCommandExampleLine(line)
    );
  });
}

function isCommanderOptionLine(line: string): boolean {
  return /^ {2}-/u.test(line);
}

function isCommandExampleLine(line: string): boolean {
  return line.startsWith('  $ ');
}

async function runCli(
  args: readonly string[],
  cwd: string,
): Promise<CliResult> {
  const result = await runCliWithSourceModule(runSourceCli, args, cwd);

  return {
    exitCode: result.exitCode,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

function getFirstStderrLine(stderr: string): string {
  return stderr.split('\n')[0] ?? '';
}

async function runCliWithInjectedWriters(
  args: readonly string[],
  cwd: string,
): Promise<CliResult> {
  return runCliWithSourceModule(runSourceCli, args, cwd);
}

async function runCliWithSourceModule(
  runCliModule: typeof runSourceCli,
  args: readonly string[],
  cwd: string,
): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const exitCode = await runCliModule(
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

async function createLargeCollapsedTree(cwd: string): Promise<void> {
  const sourceDirectory = join(cwd, 'src');
  await mkdir(sourceDirectory, { recursive: true });

  for (
    let fileIndex = 0;
    fileIndex < LARGE_COLLAPSED_TREE_FILE_COUNT;
    fileIndex += 1
  ) {
    await writeFile(join(sourceDirectory, `file-${String(fileIndex)}.ts`), '');
  }
}

async function withMockedGitLsFilesFailure(
  run: () => Promise<void>,
): Promise<void> {
  vi.resetModules();
  vi.doMock('node:child_process', () => ({
    spawn: () => createFailingGitLsFilesProcess(),
  }));

  try {
    await run();
  } finally {
    vi.doUnmock('node:child_process');
    vi.resetModules();
  }
}

function createFailingGitLsFilesProcess(): {
  readonly kill: () => boolean;
  readonly stderr: MockProcessStream;
  readonly stdin: MockProcessStream;
  readonly stdout: MockProcessStream;
} & EventEmitter {
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn(() => true),
    stderr: new MockProcessStream(),
    stdin: new MockProcessStream(),
    stdout: new MockProcessStream(),
  });

  queueMicrotask(() => {
    child.stderr.emit('data', 'fatal: bad git state');
    child.emit('close', 2);
  });

  return child;
}

class MockProcessStream extends EventEmitter {
  setEncoding(_encoding: BufferEncoding): this {
    return this;
  }

  write(
    _chunk: string,
    encodingOrCallback?: ((error?: Error | null) => void) | BufferEncoding,
    callback?: (error?: Error | null) => void,
  ): boolean {
    if (typeof encodingOrCallback === 'function') {
      encodingOrCallback();
    } else {
      callback?.();
    }

    return true;
  }

  end(chunkOrCallback?: (() => void) | string, callback?: () => void): this {
    if (typeof chunkOrCallback === 'function') {
      chunkOrCallback();
    } else {
      callback?.();
    }

    return this;
  }
}
