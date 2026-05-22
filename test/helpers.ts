/** @fileoverview Provides isolated fixture helpers for filesystem tests */

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, open, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { vi } from 'vitest';

import {
  type RepoPath,
  toCwdPath,
  toDiscoveredRepoPath,
} from '@/paths/brands.js';
import { normalizeRepoScope } from '@/paths/scope.js';
import { type Depth, validateDepth } from '@/pipeline/depth.js';
import {
  buildMapFromDiscoveredFiles,
  type CheckedBuildMapInputOptions,
  type MapEntry,
} from '@/pipeline/index.js';
import { type OverviewTag, validateTag } from '@/pipeline/tag.js';
import { createNonErrorThrownValueError } from '@/shared/error-format.js';
import { type MaxFiles, validateMaxFiles } from '@/shared/max-files.js';
import { formatDisplayValue } from '@/shared/validation.js';

const DEFAULT_SYNC_COMMAND_TIMEOUT_MS = 10_000;

type FsPromisesModule = typeof import('node:fs/promises');
type FsPromisesOverrides = Partial<
  Readonly<Record<keyof FsPromisesModule, unknown>>
>;
type FsPromisesOverrideFactory = (
  actualFs: FsPromisesModule,
) => FsPromisesOverrides | Promise<FsPromisesOverrides>;

interface SyncCommandResult {
  readonly command: string;
  readonly status: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface SyncCommandOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
}

interface BuildDiscoveredMapOptions {
  readonly collapseDirs?: readonly string[] | undefined;
  readonly cwd: string;
  readonly depth?: Depth | number | undefined;
  readonly maxFiles?: MaxFiles | number | undefined;
  readonly scope?: string | undefined;
  readonly tag?: OverviewTag | string | undefined;
}

type PipelineModule = typeof import('@/pipeline/index.js');

/**
 * Builds map entries from paths shaped like discovery output.
 *
 * @param filePaths - Repo-relative file paths for the test fixture.
 * @param options - CLI-shaped map options for the test fixture.
 * @returns Map entries built by the discovered-path pipeline.
 */
export async function buildDiscoveredMap(
  filePaths: readonly string[],
  options: BuildDiscoveredMapOptions,
): Promise<readonly MapEntry[]> {
  return buildDiscoveredMapWithModule(
    { buildMapFromDiscoveredFiles },
    filePaths,
    options,
  );
}

/**
 * Builds map entries from a dynamically imported pipeline module.
 *
 * @param pipelineModule - Pipeline module imported after a test mock is installed.
 * @param filePaths - Repo-relative file paths for the test fixture.
 * @param options - CLI-shaped map options for the test fixture.
 * @returns Map entries built by the discovered-path pipeline.
 */
export async function buildDiscoveredMapWithModule(
  pipelineModule: Pick<PipelineModule, 'buildMapFromDiscoveredFiles'>,
  filePaths: readonly string[],
  options: BuildDiscoveredMapOptions,
): Promise<readonly MapEntry[]> {
  return pipelineModule.buildMapFromDiscoveredFiles(
    toDiscoveredRepoPaths(filePaths),
    toCheckedBuildMapOptions(options),
  );
}

/**
 * Converts CLI-shaped test options into checked map options.
 *
 * @param options - CLI-shaped options used in pipeline tests.
 * @returns Checked options accepted by the discovered-path pipeline.
 */
function toCheckedBuildMapOptions(
  options: BuildDiscoveredMapOptions,
): CheckedBuildMapInputOptions {
  return {
    cwd: toCwdPath(options.cwd),
    ...(options.collapseDirs !== undefined
      ? { collapseDirs: options.collapseDirs }
      : {}),
    ...(options.depth !== undefined
      ? { depth: validateDepth(options.depth) }
      : {}),
    ...(options.maxFiles !== undefined
      ? { maxFiles: validateMaxFiles(options.maxFiles) }
      : {}),
    ...(options.scope !== undefined
      ? { scope: normalizeRepoScope(options.scope) }
      : {}),
    ...(options.tag !== undefined ? { tag: validateTag(options.tag) } : {}),
  };
}

function toDiscoveredRepoPaths(
  filePaths: readonly string[],
): readonly RepoPath[] {
  return filePaths.map((filePath) => {
    return toDiscoveredRepoPath(filePath, 'filePath');
  });
}

/**
 * Runs a test subprocess with a timeout and checked text output.
 *
 * @param command - Program to run.
 * @param args - Arguments to pass to the program.
 * @param options - Working directory and optional timeout.
 * @returns The exit code, stdout, and stderr from the finished process.
 */
export function runSyncCommand(
  command: string,
  args: readonly string[],
  options: SyncCommandOptions,
): SyncCommandResult {
  const commandText = [command, ...args].join(' ');
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? DEFAULT_SYNC_COMMAND_TIMEOUT_MS,
  });
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';

  if (result.error !== undefined) {
    throw new Error(
      `Failed to run "${commandText}" — expected the command to finish before the timeout.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      {
        cause: result.error,
      },
    );
  }

  if (result.status === null) {
    throw new Error(
      `Failed to run "${commandText}" — expected the command to return an exit code.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }

  if (typeof result.stdout !== 'string') {
    throw new Error(
      `Failed to run "${commandText}" — expected stdout to be a string.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }

  if (typeof result.stderr !== 'string') {
    throw new Error(
      `Failed to run "${commandText}" — expected stderr to be a string.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }

  return {
    command: commandText,
    status: result.status,
    stderr,
    stdout,
  };
}

/**
 * Creates an empty Git repository in a test workspace.
 *
 * @param cwd - Test workspace where Git should be initialized.
 */
export function initializeGitRepository(cwd: string): void {
  const result = runSyncCommand('git', ['init'], {
    cwd,
  });

  if (result.status !== 0) {
    throw new Error(
      `Failed to initialize Git repository in test workspace — Git exited with code ${String(result.status)}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

/**
 * Runs an async function and returns the error it throws.
 *
 * @param run - The async function that should fail.
 * @returns The thrown error.
 */
export async function getThrownError(
  run: () => Promise<unknown>,
): Promise<Error> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }

    throw new Error(`Expected an Error, got "${String(error)}".`, {
      cause: error,
    });
  }

  throw new Error('Expected the function to throw an Error.');
}

/**
 * Reads the Node filesystem error code from an unknown error.
 *
 * @param error - The value thrown by Node or used as an error cause.
 * @returns The error code, or `undefined` when the value has no string code.
 */
export function getNodeErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) {
    return undefined;
  }

  if (typeof error.code !== 'string') {
    return undefined;
  }

  return error.code;
}

/**
 * Mocks `node:fs/promises` for one module-import test and always restores it.
 *
 * @param overridesOrCreate - Mocked filesystem functions, or a factory that can wrap the real module.
 * @param run - Callback that imports and tests the module that should see the mock.
 * @returns The callback result after the mock is restored.
 */
export async function withMockedFsPromises<TResult>(
  overridesOrCreate: FsPromisesOverrideFactory | FsPromisesOverrides,
  run: () => Promise<TResult>,
): Promise<TResult> {
  const actualFs = await vi.importActual<FsPromisesModule>('node:fs/promises');
  const overrides =
    typeof overridesOrCreate === 'function'
      ? await overridesOrCreate(actualFs)
      : overridesOrCreate;

  vi.resetModules();
  vi.doMock('node:fs/promises', () => ({
    ...actualFs,
    ...overrides,
  }));

  try {
    return await run();
  } finally {
    vi.doUnmock('node:fs/promises');
    vi.resetModules();
  }
}

/**
 * Creates a temporary workspace for a filesystem-based test and removes it
 * afterwards so test cases stay isolated.
 *
 * @param prefix - Prefix used for the temporary directory name.
 * @param run - Async callback that receives the workspace path.
 * @returns A promise that resolves after the callback and cleanup complete.
 */
export async function withWorkspace(
  prefix: string,
  run: (cwd: string) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), prefix));

  try {
    await run(cwd);
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
}

/**
 * Prepares one fixture path inside an isolated test workspace.
 *
 * @param cwd - Root directory for the test workspace.
 * @param relativePath - Path relative to the workspace root.
 * @param contents - Fixture text.
 * @returns A promise that resolves after the fixture is ready.
 */
export async function createFixture(
  cwd: string,
  relativePath: string,
  contents = '',
): Promise<void> {
  const filePath = resolve(cwd, relativePath);

  if (!isPathInsideDirectory(cwd, filePath)) {
    throw new Error(
      `Invalid fixture path "${formatDisplayValue(relativePath)}" — expected a path inside workspace "${formatDisplayValue(cwd)}".`,
    );
  }

  await mkdir(dirname(filePath), { recursive: true });
  const fileHandle = await open(filePath, 'w');

  try {
    await fileHandle.write(contents);
  } finally {
    await fileHandle.close();
  }
}

/**
 * Creates a source file with a single `@fileoverview` tag.
 *
 * @param cwd - Root directory for the test workspace.
 * @param relativePath - Source file path relative to the workspace root.
 * @param description - Overview text written into the file.
 */
export async function createOverviewFixture(
  cwd: string,
  relativePath: string,
  description: string,
): Promise<void> {
  await createFixture(
    cwd,
    relativePath,
    `/** @fileoverview ${description} */\n`,
  );
}

function isPathInsideDirectory(
  directoryPath: string,
  filePath: string,
): boolean {
  const relativeFilePath = relative(directoryPath, filePath);

  return (
    relativeFilePath !== '' &&
    !relativeFilePath.startsWith('..') &&
    !isAbsolute(relativeFilePath)
  );
}

/**
 * Creates a directory symlink when the host platform allows it.
 *
 * @param cwd - Root directory for the test workspace.
 * @param relativePath - Symlink path relative to the workspace root.
 * @param targetPath - Absolute path the symlink should point to.
 * @returns `true` when the symlink was created, or `false` when the platform blocks symlinks.
 */
export async function createDirectorySymlink(
  cwd: string,
  relativePath: string,
  targetPath: string,
): Promise<boolean> {
  const symlinkPath = join(cwd, relativePath);
  await mkdir(dirname(symlinkPath), { recursive: true });

  try {
    await symlink(targetPath, symlinkPath, 'dir');
    return true;
  } catch (error) {
    if (isUnsupportedSymlinkError(error)) {
      return false;
    }

    if (error instanceof Error) {
      throw error;
    }

    throw createNonErrorThrownValueError(error);
  }
}

/**
 * Creates a file symlink when the host platform allows it.
 *
 * @param cwd - Root directory for the test workspace.
 * @param relativePath - Symlink path relative to the workspace root.
 * @param targetPath - Absolute file path the symlink should point to.
 * @returns `true` when the symlink was created, or `false` when the platform blocks symlinks.
 */
export async function createFixtureSymlink(
  cwd: string,
  relativePath: string,
  targetPath: string,
): Promise<boolean> {
  const symlinkPath = join(cwd, relativePath);
  await mkdir(dirname(symlinkPath), { recursive: true });

  try {
    await symlink(targetPath, symlinkPath, 'file');
    return true;
  } catch (error) {
    if (isUnsupportedSymlinkError(error)) {
      return false;
    }

    if (error instanceof Error) {
      throw error;
    }

    throw createNonErrorThrownValueError(error);
  }
}

function isUnsupportedSymlinkError(
  error: unknown,
): error is NodeJS.ErrnoException {
  if (!(error instanceof Error) || !('code' in error)) {
    return false;
  }

  return (
    error.code === 'EACCES' ||
    error.code === 'ENOSYS' ||
    error.code === 'ENOTSUP' ||
    error.code === 'EPERM'
  );
}
