/** @fileoverview Validates source file paths and reads their overview tags safely */

import { lstat, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  type CwdPath,
  type RepoPath,
  type ResolvedPath,
  resolvePathFromCwd,
  toResolvedPath,
} from '@/paths/brands.js';
import { isRealPathInsideDirectory } from '@/paths/platform.js';
import { readPathStatsIfExists } from '@/paths/scope.js';
import { extractFileoverviewFromHandle } from '@/pipeline/read-file.js';
import { type OverviewTag } from '@/pipeline/tag.js';
import {
  DEFAULT_CONCURRENCY,
  mapWithConcurrency,
} from '@/shared/concurrency.js';
import { formatInvalidValueMessage } from '@/shared/error-format.js';
import {
  hasSameFileIdentity,
  readFileWithHandle,
  readOptionalFileSystemValueOrFail,
} from '@/shared/file-io.js';
import { formatDisplayValue } from '@/shared/validation.js';

type LinkPathStats = Awaited<ReturnType<typeof lstat>>;
type FileIdentityStats = NonNullable<
  Awaited<ReturnType<typeof readPathStatsIfExists>>
>;
type DirectoryRealPathCache = Map<ResolvedPath, Promise<ResolvedPath>>;

interface AssertFileRealPathContext {
  readonly directoryRealPathCache: DirectoryRealPathCache;
  readonly filePath: RepoPath;
  readonly isSymbolicLink: boolean;
  readonly resolvedPath: ResolvedPath;
  readonly workingDirectory: CwdPath;
  readonly workingDirectoryRealPath: CwdPath;
}

type ValidatedFileStats =
  | {
      readonly exists: false;
      readonly isSymbolicLink: boolean;
    }
  | {
      readonly exists: true;
      readonly isSymbolicLink: boolean;
      readonly stats: FileIdentityStats;
    };

export type ValidatedFilePath =
  | {
      readonly exists: false;
      readonly path: RepoPath;
    }
  | {
      readonly exists: true;
      readonly path: RepoPath;
      readonly stats: FileIdentityStats;
    };

/**
 * Checks visible source paths before they are opened for overview extraction.
 *
 * @param filePaths - Checked repo-relative file paths.
 * @param workingDirectory - Checked working directory.
 * @param workingDirectoryRealPath - Real path for the checked working directory.
 * @returns File paths marked with whether they existed during validation.
 */
export async function validateFilePaths(
  filePaths: readonly RepoPath[],
  workingDirectory: CwdPath,
  workingDirectoryRealPath: CwdPath,
): Promise<ValidatedFilePath[]> {
  const directoryRealPathCache: DirectoryRealPathCache = new Map();

  return mapWithConcurrency(
    filePaths,
    DEFAULT_CONCURRENCY,
    async (filePath): Promise<ValidatedFilePath> => {
      const resolvedPath = resolvePathFromCwd(workingDirectory, filePath);
      const fileStats = await readValidatedFileStats(
        filePath,
        workingDirectory,
      );
      await assertFileRealPathInsideCwd({
        directoryRealPathCache,
        filePath,
        isSymbolicLink: fileStats.isSymbolicLink,
        resolvedPath,
        workingDirectory,
        workingDirectoryRealPath,
      });

      if (!fileStats.exists) {
        return {
          exists: false,
          path: filePath,
        };
      }

      return {
        exists: true,
        path: filePath,
        stats: fileStats.stats,
      };
    },
  );
}

/**
 * Reads one source file's overview tag.
 *
 * @param workingDirectory - Checked working directory.
 * @param filePath - Checked file path.
 * @param tag - Optional overview tag name override.
 * @returns The overview description, or `undefined` when the file has no tag.
 */
export async function readSourceFileOverview(
  workingDirectory: CwdPath,
  filePath: ValidatedFilePath,
  tag: OverviewTag | undefined,
): Promise<string | undefined> {
  if (!filePath.exists) {
    throwInvalidExistingFilePath(filePath.path, workingDirectory);
  }

  const sourcePath = resolvePathFromCwd(workingDirectory, filePath.path);

  return readFileWithHandle(sourcePath, async (fileHandle) => {
    const openedStats = await fileHandle.stat();
    assertOpenedFileMatchesCheckedFile(
      filePath.stats,
      openedStats,
      filePath.path,
    );

    return extractFileoverviewFromHandle(fileHandle, tag);
  });
}

async function readValidatedFileStats(
  filePath: RepoPath,
  workingDirectory: CwdPath,
): Promise<ValidatedFileStats> {
  const resolvedPath = resolvePathFromCwd(workingDirectory, filePath);
  const linkStats = await readLinkStatsIfExists(
    resolvedPath,
    'filePath',
    filePath,
  );

  if (linkStats === undefined) {
    return {
      exists: false,
      isSymbolicLink: false,
    };
  }

  if (linkStats.isSymbolicLink()) {
    return readValidatedSymbolicLinkFileStats(
      filePath,
      resolvedPath,
      workingDirectory,
    );
  }

  if (linkStats.isFile()) {
    return {
      exists: true,
      isSymbolicLink: false,
      stats: linkStats,
    };
  }

  throwInvalidExistingFilePath(filePath, workingDirectory);
}

async function readValidatedSymbolicLinkFileStats(
  filePath: RepoPath,
  resolvedPath: ResolvedPath,
  workingDirectory: CwdPath,
): Promise<ValidatedFileStats> {
  const fileStats = await readPathStatsIfExists(
    resolvedPath,
    'filePath',
    filePath,
  );

  if (fileStats === undefined) {
    return {
      exists: false,
      isSymbolicLink: true,
    };
  }

  if (fileStats.isFile()) {
    return {
      exists: true,
      isSymbolicLink: true,
      stats: fileStats,
    };
  }

  throwInvalidExistingFilePath(filePath, workingDirectory);
}

async function readLinkStatsIfExists(
  filePath: ResolvedPath,
  fieldName: string,
  originalPath: string,
): Promise<LinkPathStats | undefined> {
  return readOptionalFileSystemValueOrFail(
    () => lstat(filePath),
    'inspect',
    fieldName,
    originalPath,
  );
}

function throwInvalidExistingFilePath(
  filePath: RepoPath,
  workingDirectory: CwdPath,
): never {
  throw new Error(
    formatInvalidValueMessage(
      'filePath',
      filePath,
      `an existing file relative to cwd "${formatDisplayValue(workingDirectory)}"`,
    ),
  );
}

function assertOpenedFileMatchesCheckedFile(
  checkedStats: FileIdentityStats,
  openedStats: FileIdentityStats,
  filePath: RepoPath,
): void {
  if (hasSameFileIdentity(checkedStats, openedStats)) {
    return;
  }

  throw new Error(
    formatInvalidValueMessage(
      'filePath',
      filePath,
      'the same file before and after opening it',
    ),
  );
}

async function assertFileRealPathInsideCwd(
  context: AssertFileRealPathContext,
): Promise<void> {
  if (
    await canTrustLexicalFilePath(
      context.resolvedPath,
      context.workingDirectoryRealPath,
      context.directoryRealPathCache,
      context.isSymbolicLink,
    )
  ) {
    return;
  }

  const resolvedRealPath = await readOptionalFileSystemValueOrFail(
    () => realpath(context.resolvedPath),
    'resolve real path for',
    undefined,
    context.resolvedPath,
  );

  if (resolvedRealPath === undefined) {
    return;
  }

  if (
    isRealPathInsideDirectory(
      context.workingDirectoryRealPath,
      resolvedRealPath,
    )
  ) {
    return;
  }

  throw new Error(
    formatInvalidValueMessage(
      'filePath',
      context.filePath,
      `a file that resolves inside cwd "${formatDisplayValue(context.workingDirectory)}"`,
    ),
  );
}

async function canTrustLexicalFilePath(
  resolvedPath: ResolvedPath,
  workingDirectoryRealPath: CwdPath,
  directoryRealPathCache: DirectoryRealPathCache,
  isSymbolicLink: boolean,
): Promise<boolean> {
  if (!isRealPathInsideDirectory(workingDirectoryRealPath, resolvedPath)) {
    return false;
  }

  if (isSymbolicLink) {
    return false;
  }

  const directoryPath = toResolvedPath(dirname(resolvedPath), 'filePath');
  let directoryRealPath: ResolvedPath;

  try {
    directoryRealPath = await readDirectoryRealPath(
      directoryPath,
      directoryRealPathCache,
    );
  } catch {
    return false;
  }

  return directoryRealPath === directoryPath;
}

async function readDirectoryRealPath(
  directoryPath: ResolvedPath,
  directoryRealPathCache: DirectoryRealPathCache,
): Promise<ResolvedPath> {
  const cachedRealPath = directoryRealPathCache.get(directoryPath);

  if (cachedRealPath !== undefined) {
    return cachedRealPath;
  }

  const realPathPromise = realpath(directoryPath).then((value) => {
    return toResolvedPath(value, 'filePath');
  });

  directoryRealPathCache.set(directoryPath, realPathPromise);

  return realPathPromise;
}
