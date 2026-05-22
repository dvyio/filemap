/** @fileoverview Parses paths returned by git check-ignore */

import {
  type CwdPath,
  normalizeToPosixPath,
  type RepoPath,
  toDiscoveredRepoPath,
} from '@/paths/brands.js';
import { formatDisplayValue } from '@/shared/validation.js';

const GIT_CHECK_IGNORE_STDOUT_PATH_LIMIT_CHARS = 65_536;

/** Incremental parser for null-separated `git check-ignore -z` output. */
export interface GitCheckIgnoreOutputParser {
  /** Adds one stdout chunk from Git. */
  readonly addChunk: (chunk: string) => void;
  /** Returns the ignored repo paths after the final chunk. */
  readonly finish: () => ReadonlySet<RepoPath>;
}

interface ParseGitCheckIgnoreOutputChunkOptions {
  readonly addPath: (path: string) => void;
  readonly chunk: string;
  readonly pendingOutput: string;
  readonly workingDirectory: CwdPath;
}

interface CompletePathFromSegmentOptions {
  readonly pendingOutput: string;
  readonly segment: string;
  readonly workingDirectory: CwdPath;
}

interface CompletePathFromSegmentResult {
  readonly path: string;
  readonly pendingOutput: string;
}

/**
 * Parses null-separated paths from `git check-ignore -z` output.
 *
 * @param workingDirectory - Directory used in error messages.
 * @param filePaths - Repo paths sent to Git.
 * @returns A parser that accepts output chunks and returns normalized paths.
 */
export function createGitCheckIgnoreOutputParser(
  workingDirectory: CwdPath,
  filePaths: readonly RepoPath[],
): GitCheckIgnoreOutputParser {
  const requestedPaths = new Set(filePaths);
  const ignoredPaths = new Set<RepoPath>();
  let pendingOutput = '';

  function addPath(path: string): void {
    if (path === '') {
      return;
    }

    const normalizedPath = normalizeGitCheckIgnoreOutputPath(
      path,
      workingDirectory,
    );

    if (!requestedPaths.has(normalizedPath)) {
      throwUnexpectedGitCheckIgnorePath(path, workingDirectory);
    }

    ignoredPaths.add(normalizedPath);
  }

  return {
    addChunk: (chunk: string): void => {
      pendingOutput = parseGitCheckIgnoreOutputChunk({
        addPath,
        chunk,
        pendingOutput,
        workingDirectory,
      });
    },
    finish: (): ReadonlySet<RepoPath> => {
      assertGitCheckIgnoreOutputIsComplete(pendingOutput, workingDirectory);

      return ignoredPaths;
    },
  };
}

function parseGitCheckIgnoreOutputChunk(
  options: ParseGitCheckIgnoreOutputChunkOptions,
): string {
  const { addPath, chunk, workingDirectory } = options;
  let pendingOutput = options.pendingOutput;
  let pathStartIndex = 0;
  let separatorIndex = chunk.indexOf('\0', pathStartIndex);

  while (separatorIndex !== -1) {
    const completedPath = completePathFromSegment({
      pendingOutput,
      segment: chunk.slice(pathStartIndex, separatorIndex),
      workingDirectory,
    });

    pendingOutput = completedPath.pendingOutput;
    addPath(completedPath.path);

    pathStartIndex = separatorIndex + 1;
    separatorIndex = chunk.indexOf('\0', pathStartIndex);
  }

  return appendGitCheckIgnorePendingOutput(
    pendingOutput,
    chunk.slice(pathStartIndex),
    workingDirectory,
  );
}

function completePathFromSegment(
  options: CompletePathFromSegmentOptions,
): CompletePathFromSegmentResult {
  const { pendingOutput, segment, workingDirectory } = options;

  if (pendingOutput.length === 0) {
    assertGitCheckIgnoreOutputPathLength(segment, workingDirectory);

    return {
      path: segment,
      pendingOutput,
    };
  }

  return {
    path: appendGitCheckIgnorePendingOutput(
      pendingOutput,
      segment,
      workingDirectory,
    ),
    pendingOutput: '',
  };
}

function appendGitCheckIgnorePendingOutput(
  pendingOutput: string,
  segment: string,
  workingDirectory: CwdPath,
): string {
  const nextPendingOutput = `${pendingOutput}${segment}`;

  assertGitCheckIgnoreOutputPathLength(nextPendingOutput, workingDirectory);

  return nextPendingOutput;
}

function assertGitCheckIgnoreOutputPathLength(
  path: string,
  workingDirectory: CwdPath,
): void {
  if (path.length <= GIT_CHECK_IGNORE_STDOUT_PATH_LIMIT_CHARS) {
    return;
  }

  throw new Error(
    `Failed to read git check-ignore output in cwd "${formatDisplayValue(workingDirectory)}" — Git returned a path longer than ${String(GIT_CHECK_IGNORE_STDOUT_PATH_LIMIT_CHARS)} characters.`,
  );
}

function assertGitCheckIgnoreOutputIsComplete(
  pendingOutput: string,
  workingDirectory: CwdPath,
): void {
  assertGitCheckIgnoreOutputPathLength(pendingOutput, workingDirectory);

  if (pendingOutput.length === 0) {
    return;
  }

  throw new Error(
    `Failed to read git check-ignore output in cwd "${formatDisplayValue(workingDirectory)}" — Git returned incomplete path "${formatDisplayValue(pendingOutput)}", expected null-separated paths ending with NUL.`,
  );
}

function normalizeGitCheckIgnoreOutputPath(
  path: string,
  workingDirectory: CwdPath,
): RepoPath {
  try {
    return toDiscoveredRepoPath(normalizeToPosixPath(path), 'Git path');
  } catch {
    throwUnexpectedGitCheckIgnorePath(path, workingDirectory);
  }
}

function throwUnexpectedGitCheckIgnorePath(
  path: string,
  workingDirectory: CwdPath,
): never {
  throw new Error(
    `Failed to read git check-ignore output in cwd "${formatDisplayValue(workingDirectory)}" — Git returned path "${formatDisplayValue(path)}", expected one of the paths sent to Git.`,
  );
}
