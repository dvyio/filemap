/** @fileoverview Walks directories with include and exclude glob patterns. */

import { type Dirent } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { join } from 'node:path';

import type { MaxFiles } from '@/shared/max-files.js';

import { hasGlobSyntax } from '@/discovery/glob-syntax.js';
import {
  createRootedDiscoveryMatcher,
  type PathMatcher,
} from '@/discovery/matchers.js';
import { compareFilePaths } from '@/discovery/sort.js';
import {
  type CwdPath,
  type RepoGlob,
  type RepoPath,
  toDiscoveredRepoPath,
} from '@/paths/brands.js';
import { createNonErrorThrownValueError } from '@/shared/error-format.js';
import { hasNodeErrorCode } from '@/shared/file-io.js';
import { formatDisplayValue } from '@/shared/validation.js';

interface CappedGlobOptions {
  readonly ignorePatterns: readonly RepoGlob[];
  readonly includePatterns: readonly RepoGlob[];
  readonly maxFiles: MaxFiles;
  readonly walkDirectory: '' | RepoPath;
  readonly workingDirectory: CwdPath;
}

interface WalkDirectoryOptions {
  readonly ignoreMatcher: PathMatcher;
  readonly includeMatcher: PathMatcher;
  readonly matches: string[];
  readonly maxFiles: MaxFiles;
  readonly relativeDirectory: string;
  readonly workingDirectory: CwdPath;
}

/**
 * Finds matching repo paths by walking a scope root or shared search directory.
 *
 * @param includePatterns - Glob patterns that mark files as candidates.
 * @param ignorePatterns - Glob patterns that hide files and directories.
 * @param workingDirectory - Directory to walk from.
 * @param maxFiles - Optional candidate cap checked during the walk.
 * @param walkDirectory - Repo-relative directory to start from.
 * @returns Sorted repo-relative paths that matched the include rules.
 */
export async function discoverWithGlob(
  includePatterns: readonly RepoGlob[],
  ignorePatterns: readonly RepoGlob[],
  workingDirectory: CwdPath,
  maxFiles: MaxFiles,
  walkDirectory: '' | RepoPath = '',
): Promise<readonly RepoPath[]> {
  try {
    return await discoverWithGlobUntilLimit({
      ignorePatterns,
      includePatterns,
      maxFiles,
      walkDirectory,
      workingDirectory,
    });
  } catch (error) {
    throw new Error(
      `Failed to discover files in cwd "${formatDisplayValue(workingDirectory)}" — check that the directory exists and the glob patterns are valid.`,
      { cause: error },
    );
  }
}

async function discoverWithGlobUntilLimit(
  options: CappedGlobOptions,
): Promise<readonly RepoPath[]> {
  const matches: string[] = [];
  const searchDirectory = getWalkSearchDirectory(options);
  const includeMatcher = createRootedDiscoveryMatcher(
    options.includePatterns,
    searchDirectory,
  );
  const ignoreMatcher = createRootedDiscoveryMatcher(
    options.ignorePatterns,
    searchDirectory,
  );

  await walkDirectory({
    ignoreMatcher,
    includeMatcher,
    matches,
    maxFiles: options.maxFiles,
    relativeDirectory: searchDirectory,
    workingDirectory: options.workingDirectory,
  });

  return matches
    .map((match) => normalizeDiscoveredPath(match))
    .sort(compareFilePaths);
}

/**
 * Walks a directory and returns `true` after the match count passes the cap.
 */
async function walkDirectory(options: WalkDirectoryOptions): Promise<boolean> {
  const directoryPath = resolveWalkDirectoryPath(
    options.workingDirectory,
    options.relativeDirectory,
  );

  let directory: Awaited<ReturnType<typeof opendir>>;

  try {
    directory = await opendir(directoryPath);
  } catch (error) {
    if (isExpectedNestedDirectoryRace(error, options.relativeDirectory)) {
      return false;
    }

    if (error instanceof Error) {
      throw error;
    }

    /* v8 ignore next */
    throw createNonErrorThrownValueError(error);
  }

  return walkDirectoryEntries(directory, options);
}

function isExpectedNestedDirectoryRace(
  error: unknown,
  relativeDirectory: string,
): boolean {
  return (
    relativeDirectory !== '' &&
    (hasNodeErrorCode(error, 'ENOENT') || hasNodeErrorCode(error, 'ENOTDIR'))
  );
}

async function walkDirectoryEntries(
  directory: Awaited<ReturnType<typeof opendir>>,
  options: WalkDirectoryOptions,
): Promise<boolean> {
  for await (const entry of directory) {
    if (await handleWalkDirectoryEntry(entry, options)) {
      return true;
    }
  }

  return false;
}

async function handleWalkDirectoryEntry(
  entry: Dirent,
  options: WalkDirectoryOptions,
): Promise<boolean> {
  const relativePath = joinRelativePath(options.relativeDirectory, entry.name);

  if (entry.isDirectory()) {
    return handleDirectoryEntry(relativePath, options);
  }

  if (!entry.isFile()) {
    return false;
  }

  return handleFileEntry(relativePath, options);
}

async function handleDirectoryEntry(
  relativePath: string,
  options: WalkDirectoryOptions,
): Promise<boolean> {
  if (isIgnoredDirectory(options.ignoreMatcher, relativePath)) {
    return false;
  }

  return walkDirectory({
    ...options,
    relativeDirectory: relativePath,
  });
}

function handleFileEntry(
  relativePath: string,
  options: WalkDirectoryOptions,
): boolean {
  if (!options.includeMatcher(relativePath)) {
    return false;
  }

  if (options.ignoreMatcher(relativePath)) {
    return false;
  }

  options.matches.push(relativePath);

  return isWalkLimitExceeded(options);
}

function isWalkLimitExceeded(options: WalkDirectoryOptions): boolean {
  return options.matches.length > options.maxFiles;
}

function isIgnoredDirectory(
  ignoreMatcher: PathMatcher,
  relativePath: string,
): boolean {
  return ignoreMatcher(relativePath) || ignoreMatcher(`${relativePath}/`);
}

function resolveWalkDirectoryPath(
  workingDirectory: CwdPath,
  relativeDirectory: string,
): string {
  if (relativeDirectory === '') {
    return workingDirectory;
  }

  return join(workingDirectory, ...relativeDirectory.split('/'));
}

function getWalkSearchDirectory(options: CappedGlobOptions): '' | RepoPath {
  if (options.walkDirectory !== '') {
    return options.walkDirectory;
  }

  const searchDirectory = getCommonSearchDirectory(options.includePatterns);

  if (searchDirectory === '') {
    return '';
  }

  return toDiscoveredRepoPath(searchDirectory, 'searchDirectory');
}

function getCommonSearchDirectory(patterns: readonly RepoGlob[]): string {
  let commonParts: readonly string[] | undefined;

  for (const pattern of patterns) {
    const searchDirectory = getPatternSearchDirectory(pattern);
    const searchParts =
      searchDirectory === '' ? [] : searchDirectory.split('/');

    if (commonParts === undefined) {
      commonParts = searchParts;
      continue;
    }

    commonParts = getCommonPathParts(commonParts, searchParts);
  }

  return commonParts?.join('/') ?? '';
}

function getPatternSearchDirectory(pattern: RepoGlob): string {
  const patternParts = pattern.split('/');
  const literalParts: string[] = [];

  for (const patternPart of patternParts) {
    if (hasGlobSyntax(patternPart)) {
      break;
    }

    literalParts.push(patternPart);
  }

  if (literalParts.length === patternParts.length) {
    literalParts.pop();
  }

  return literalParts.join('/');
}

function getCommonPathParts(
  leftParts: readonly string[],
  rightParts: readonly string[],
): string[] {
  const commonParts: string[] = [];
  const commonLength = Math.min(leftParts.length, rightParts.length);

  for (let index = 0; index < commonLength; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      break;
    }

    const commonPart = leftParts[index];

    /* v8 ignore next 3 */
    if (commonPart === undefined) {
      break;
    }

    commonParts.push(commonPart);
  }

  return commonParts;
}

function joinRelativePath(directory: string, entryName: string): string {
  if (directory === '') {
    return entryName;
  }

  return `${directory}/${entryName}`;
}

function normalizeDiscoveredPath(path: string): RepoPath {
  return toDiscoveredRepoPath(path, 'filePath');
}
