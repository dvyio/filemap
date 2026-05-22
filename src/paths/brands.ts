/** @fileoverview Brands and normalizes repo paths before filesystem access */

import { posix, resolve } from 'node:path';

import {
  detectPathPlatform,
  isRelativePathInsideCwd,
  isWindowsAbsolutePath,
  resolveRelativePathInsideCwd,
} from '@/paths/platform.js';
import { formatInvalidValueMessage } from '@/shared/error-format.js';
import {
  formatDisplayValue,
  hasControlCharacter,
  hasUnicodeFormatControl,
  validateNonEmptyString,
} from '@/shared/validation.js';

type SafeStringKindLabel = 'glob pattern' | 'path';

declare const cwdPathBrand: unique symbol;
declare const repoGlobBrand: unique symbol;
declare const repoPathBrand: unique symbol;
declare const resolvedPathBrand: unique symbol;

export const REPO_GLOB_PATTERN_EXPECTATION =
  'a repo-relative glob pattern' as const;

/** Absolute working directory path that passed filemap's path checks. */
export type CwdPath = { readonly [cwdPathBrand]: 'CwdPath' } & string;
/** Repo-relative glob pattern that cannot escape the repo root. */
export type RepoGlob = { readonly [repoGlobBrand]: 'RepoGlob' } & string;
/** Repo-relative path that cannot escape the repo root. */
export type RepoPath = { readonly [repoPathBrand]: 'RepoPath' } & string;
/** Absolute filesystem path that passed filemap's path checks. */
export type ResolvedPath = {
  readonly [resolvedPathBrand]: 'ResolvedPath';
} & string;

/**
 * Converts path separators to POSIX `/` for stable CLI output.
 *
 * @param path - Path text to normalize.
 * @returns The path with backslashes changed to `/`.
 */
export function normalizeToPosixPath(path: string): string {
  return path.replace(/\\/gu, '/');
}

/**
 * Rejects control characters before a user path is used.
 *
 * @param value - User path text to check.
 * @param fieldName - Field name used in the error message.
 */
export function assertSafeUserPathString(
  value: string,
  fieldName: string,
): void {
  assertSafeStringForKind(value, fieldName, 'path');
}

/**
 * Rejects control characters in glob patterns while keeping glob syntax available.
 *
 * @param value - Glob pattern text to check.
 * @param fieldName - Field name used in the error message.
 */
export function assertSafeGlobPatternString(
  value: string,
  fieldName: string,
): void {
  assertSafeStringForKind(value, fieldName, 'glob pattern');
}

function assertSafeStringForKind(
  value: string,
  fieldName: string,
  kindLabel: SafeStringKindLabel,
): void {
  if (!hasControlCharacter(value)) {
    if (!hasUnicodeFormatControl(value)) {
      return;
    }

    throw new Error(
      formatInvalidValueMessage(
        fieldName,
        value,
        `a ${kindLabel} without Unicode format characters`,
      ),
    );
  }

  throw new Error(
    formatInvalidValueMessage(
      fieldName,
      value,
      `a ${kindLabel} without control characters`,
    ),
  );
}

/**
 * Normalizes a repo-relative glob pattern without collapsing glob path parts.
 *
 * @param pattern - Glob pattern supplied by a caller.
 * @param fieldName - Field name used in the error message.
 * @param expectedDescription - Plain rule shown when the pattern is invalid.
 * @returns A checked repo-relative glob pattern.
 */
export function normalizeRepoGlobPattern(
  pattern: string,
  fieldName: string,
  expectedDescription: string,
): RepoGlob {
  const trimmedPattern = validateNonEmptyString(
    pattern,
    fieldName,
    expectedDescription,
  ).trim();

  assertSafeGlobPatternString(trimmedPattern, fieldName);

  if (isWindowsAbsolutePath(trimmedPattern)) {
    throwInvalidGlobPattern(pattern, fieldName, expectedDescription);
  }

  const normalizedPattern = stripLeadingCurrentDirectorySegments(
    normalizeToPosixPath(trimmedPattern),
  );

  if (isUnsafeRepoRelativePathShape(normalizedPattern)) {
    throwInvalidGlobPattern(pattern, fieldName, expectedDescription);
  }

  return normalizedPattern as RepoGlob;
}

/**
 * Resolves path parts against cwd without following symlinks.
 *
 * @param value - Path supplied by a caller.
 * @param cwd - Absolute working directory that bounds the path.
 * @param fieldName - Field name used in the error message.
 * @returns A checked repo-relative path inside cwd.
 */
export function normalizePathInsideCwdLexically(
  value: string,
  cwd: CwdPath,
  fieldName: string,
): RepoPath {
  const trimmedValue = validateNonEmptyString(
    value,
    fieldName,
    `a non-empty path inside cwd "${formatDisplayValue(cwd)}"`,
  ).trim();
  const trimmedCwd = validateNonEmptyString(
    cwd,
    'cwd',
    'a non-empty string path',
  ).trim();

  assertSafeUserPathString(trimmedValue, fieldName);
  assertSafeUserPathString(trimmedCwd, 'cwd');

  const platform = detectPathPlatform(trimmedCwd);
  const relativePath = resolveRelativePathInsideCwd(
    trimmedValue,
    trimmedCwd,
    platform,
  );

  if (!isRelativePathInsideCwd(relativePath, platform)) {
    throw new Error(
      formatInvalidValueMessage(
        fieldName,
        value,
        `a path inside cwd "${formatDisplayValue(cwd)}"`,
      ),
    );
  }

  return normalizeToPosixPath(relativePath) as RepoPath;
}

/**
 * Brands a repo-relative path after checking it cannot escape the repo.
 *
 * @param value - Repo-relative path text to check.
 * @param fieldName - Field name used in the error message.
 * @returns A checked repo-relative path.
 */
export function toRepoPath(value: string, fieldName: string): RepoPath {
  const trimmedValue = validateNonEmptyString(
    value,
    fieldName,
    'a non-empty repo-relative path',
  ).trim();

  assertSafeUserPathString(trimmedValue, fieldName);

  if (
    isUnsafeRepoRelativePathShape(trimmedValue) ||
    isWindowsAbsolutePath(trimmedValue)
  ) {
    throw new Error(
      formatInvalidValueMessage(fieldName, value, 'a repo-relative path'),
    );
  }

  return normalizeToPosixPath(trimmedValue).replace(/\/+$/u, '') as RepoPath;
}

/**
 * Brands a path returned by file discovery after checking it stays repo-relative.
 *
 * @param value - Discovery path text to check.
 * @param fieldName - Field name used in the error message.
 * @returns A checked repo-relative path.
 */
export function toDiscoveredRepoPath(
  value: string,
  fieldName: string,
): RepoPath {
  validateNonEmptyString(value, fieldName, 'a non-empty repo-relative path');

  const normalizedValue = normalizeToPosixPath(value);

  if (
    isUnsafeRepoRelativePathShape(normalizedValue) ||
    isWindowsAbsolutePath(normalizedValue)
  ) {
    throw new Error(
      formatInvalidValueMessage(fieldName, value, 'a repo-relative path'),
    );
  }

  return normalizedValue.replace(/\/+$/u, '') as RepoPath;
}

/**
 * Checks whether a repo path is the root path or a child of it.
 *
 * @param path - Repo path to test.
 * @param rootPath - Repo path that should contain the path.
 * @returns `true` when `path` equals `rootPath` or starts with its directory prefix.
 */
export function isRepoPathAtOrInside(path: string, rootPath: string): boolean {
  return path === rootPath || path.startsWith(`${rootPath}/`);
}

/**
 * Brands an absolute working directory path after it has been resolved.
 *
 * @param cwd - Absolute working directory path to check.
 * @returns A checked working directory path.
 */
export function toCwdPath(cwd: string): CwdPath {
  validateNonEmptyString(cwd, 'cwd', 'a non-empty string path');

  assertSafeUserPathString(cwd, 'cwd');
  assertAbsolutePath(cwd, 'cwd');

  return cwd as CwdPath;
}

/**
 * Brands an absolute path after it has been resolved for filesystem access.
 *
 * @param value - Absolute path text to check.
 * @param fieldName - Field name used in the error message.
 * @returns A checked absolute filesystem path.
 */
export function toResolvedPath(value: string, fieldName: string): ResolvedPath {
  validateNonEmptyString(value, fieldName, 'an absolute path');

  assertSafeUserPathString(value, fieldName);
  assertAbsolutePath(value, fieldName);

  return value as ResolvedPath;
}

/**
 * Resolves path parts against cwd and brands the absolute result.
 *
 * @param cwd - Absolute working directory used as the base path.
 * @param pathParts - Path parts passed to `path.resolve`.
 * @returns A checked absolute filesystem path.
 */
export function resolvePathFromCwd(
  cwd: CwdPath,
  ...pathParts: readonly string[]
): ResolvedPath {
  return toResolvedPath(resolve(cwd, ...pathParts), 'resolvedPath');
}

function stripLeadingCurrentDirectorySegments(pattern: string): string {
  let normalizedPattern = pattern;

  while (normalizedPattern.startsWith('./')) {
    normalizedPattern = normalizedPattern.slice(2);
  }

  return normalizedPattern;
}

function isUnsafeRepoRelativePathShape(value: string): boolean {
  return (
    value === '' ||
    value === '.' ||
    value.startsWith('/') ||
    hasParentEscapingGlobPrefix(value)
  );
}

/**
 * Checks whether a path or glob pattern has a parent segment that can escape the repo.
 *
 * @param pattern - Path or glob pattern text to inspect.
 * @returns `true` when any path segment is `..`.
 */
export function hasParentEscapingGlobPrefix(pattern: string): boolean {
  for (const segment of pattern.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }

    if (segment === '..') {
      return true;
    }
  }

  return false;
}

function assertAbsolutePath(value: string, fieldName: string): void {
  const platform = detectPathPlatform(value);

  if (platform === 'windows') {
    /* v8 ignore next 5 */
    if (!isWindowsAbsolutePath(value)) {
      throwInvalidAbsolutePath(value, fieldName);
    }

    return;
  }

  if (!posix.isAbsolute(value)) {
    throwInvalidAbsolutePath(value, fieldName);
  }
}

function throwInvalidAbsolutePath(value: string, fieldName: string): never {
  throw new Error(
    formatInvalidValueMessage(fieldName, value, 'an absolute path'),
  );
}

function throwInvalidGlobPattern(
  pattern: string,
  fieldName: string,
  expectedDescription: string,
): never {
  throw new Error(
    formatInvalidValueMessage(fieldName, pattern, expectedDescription),
  );
}
