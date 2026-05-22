/** @fileoverview Applies root and nested gitignore rules to discovered files */

import ignore from 'ignore';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { findGitIgnoredPaths, findGitVisibleFiles } from '@/git/ignore.js';
import {
  type CwdPath,
  type RepoPath,
  type ResolvedPath,
  resolvePathFromCwd,
} from '@/paths/brands.js';
import { isRealPathInsideDirectory } from '@/paths/platform.js';
import { formatInvalidValueMessage } from '@/shared/error-format.js';
import {
  hasNodeErrorCode,
  readOptionalBoundedUtf8FileSafely,
  readOptionalFileSystemValueOrFail,
} from '@/shared/file-io.js';
import { formatDisplayValue } from '@/shared/validation.js';

const ROOT_GITIGNORE_FILE = '.gitignore';
const ROOT_GITIGNORE_READ_LIMIT_BYTES = 64 * 1024;
const GIT_METADATA_ENTRY = '.git';

class InvalidRootGitignoreError extends Error {}

type GitVisibleMatchesResult =
  | {
      readonly matches: readonly RepoPath[];
      readonly status: 'answered';
    }
  | {
      readonly status: 'notGitRepository';
    };

/**
 * Lists files Git considers visible when cwd owns Git metadata.
 *
 * @param workingDirectory - Checked working directory.
 * @returns Git-visible paths, or a not-repo result when filemap should use its walker.
 */
export async function discoverGitVisibleMatches(
  workingDirectory: CwdPath,
): Promise<GitVisibleMatchesResult> {
  const hasGitMetadata = await hasGitMetadataInCwd(workingDirectory);

  if (!hasGitMetadata) {
    return {
      status: 'notGitRepository',
    };
  }

  const gitVisibleFilesResult = await findGitVisibleFiles(workingDirectory);

  if (gitVisibleFilesResult.status === 'notGitRepository') {
    return {
      status: 'notGitRepository',
    };
  }

  return {
    matches: gitVisibleFilesResult.filePaths,
    status: 'answered',
  };
}

/**
 * Filters discovered paths through root `.gitignore` and Git check-ignore.
 *
 * @param filePaths - Repo-relative matches from glob discovery.
 * @param workingDirectory - Checked working directory.
 * @returns Paths that are not ignored by Git.
 */
export async function filterIgnoredMatches(
  filePaths: readonly RepoPath[],
  workingDirectory: CwdPath,
): Promise<RepoPath[]> {
  if (filePaths.length === 0) {
    return [];
  }

  const hasGitMetadata = await hasGitMetadataInCwd(workingDirectory);

  if (!hasGitMetadata) {
    return filterRootGitIgnoredMatches(filePaths, workingDirectory);
  }

  const gitIgnoredPathsResult = await findGitIgnoredPaths(
    filePaths,
    workingDirectory,
  );

  if (gitIgnoredPathsResult.status === 'notGitRepository') {
    return filterRootGitIgnoredMatches(filePaths, workingDirectory);
  }

  const ignoredPaths = gitIgnoredPathsResult.ignoredPaths;
  if (ignoredPaths.size === 0) {
    return [...filePaths];
  }

  return filePaths.filter((filePath) => !ignoredPaths.has(filePath));
}

async function filterRootGitIgnoredMatches(
  filePaths: readonly RepoPath[],
  workingDirectory: CwdPath,
): Promise<RepoPath[]> {
  const gitignore = await readRootGitignore(workingDirectory);

  if (gitignore === undefined) {
    return [...filePaths];
  }

  const matcher = ignore().add(gitignore);
  const rootVisiblePaths = filePaths.filter(
    (filePath) => !matcher.ignores(filePath),
  );

  return rootVisiblePaths;
}

/**
 * Reads the root `.gitignore` only when it is a regular file inside cwd.
 */
async function readRootGitignore(
  workingDirectory: CwdPath,
): Promise<string | undefined> {
  const rootGitignorePath = resolvePathFromCwd(
    workingDirectory,
    ROOT_GITIGNORE_FILE,
  );

  try {
    return await readOptionalBoundedUtf8FileSafely({
      byteLimit: ROOT_GITIGNORE_READ_LIMIT_BYTES,
      createInvalidFileError(expectedDescription, options) {
        return createInvalidRootGitignoreError(
          formatInvalidValueMessage(
            '.gitignore',
            rootGitignorePath,
            expectedDescription,
          ),
          options,
        );
      },
      regularFileDescription: 'a regular file',
      resolvedPath: rootGitignorePath,
      validateRealPath(rootGitignoreRealPath) {
        return assertRootGitignoreRealPathInsideCwd(
          workingDirectory,
          rootGitignorePath,
          rootGitignoreRealPath,
        );
      },
    });
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) {
      return undefined;
    }

    if (isInvalidRootGitignoreError(error)) {
      throw error;
    }

    throw new Error(
      `Failed to read .gitignore in cwd "${formatDisplayValue(workingDirectory)}" — check that the file is readable.`,
      { cause: error },
    );
  }
}

async function assertRootGitignoreRealPathInsideCwd(
  workingDirectory: CwdPath,
  rootGitignorePath: ResolvedPath,
  rootGitignoreRealPath: string,
): Promise<void> {
  const workingDirectoryRealPath = await realpath(workingDirectory);

  if (
    isRealPathInsideDirectory(workingDirectoryRealPath, rootGitignoreRealPath)
  ) {
    return;
  }

  throw createInvalidRootGitignoreError(
    formatInvalidValueMessage(
      '.gitignore',
      rootGitignorePath,
      `a file that resolves inside cwd "${formatDisplayValue(workingDirectory)}"`,
    ),
  );
}

function createInvalidRootGitignoreError(
  message: string,
  options?: ErrorOptions,
): InvalidRootGitignoreError {
  return new InvalidRootGitignoreError(message, options);
}

function isInvalidRootGitignoreError(
  error: unknown,
): error is InvalidRootGitignoreError {
  return error instanceof InvalidRootGitignoreError;
}

async function hasGitMetadataInCwd(
  workingDirectory: CwdPath,
): Promise<boolean> {
  return pathExists(join(workingDirectory, GIT_METADATA_ENTRY));
}

async function pathExists(path: string): Promise<boolean> {
  const stats = await readOptionalFileSystemValueOrFail(
    () => lstat(path),
    'inspect',
    'Git metadata',
    path,
  );

  return stats !== undefined;
}
