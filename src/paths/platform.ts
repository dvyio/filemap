/** @fileoverview Detects path platforms and checks cwd-relative path math */

import { posix, win32 } from 'node:path';

import { validateNonEmptyString } from '@/shared/validation.js';

type PathPlatform = 'posix' | 'windows';

/**
 * Resolves a caller path against cwd without following symlinks.
 *
 * @param value - Path supplied by a caller.
 * @param cwd - Absolute working directory that bounds the path.
 * @param platform - Path rules to use for the calculation.
 * @returns A relative path from cwd to value.
 */
export function resolveRelativePathInsideCwd(
  value: string,
  cwd: string,
  platform: PathPlatform,
): string {
  if (platform === 'windows') {
    return win32.relative(win32.resolve(cwd), win32.resolve(cwd, value));
  }

  /* v8 ignore next 3 */
  if (isWindowsAbsolutePath(value)) {
    return value;
  }

  const normalizedValue = normalizePathSeparators(value);

  return posix.relative(
    posix.resolve(cwd),
    posix.resolve(cwd, normalizedValue),
  );
}

/**
 * Checks whether a relative path stays below cwd.
 *
 * @param relativePath - Path returned by a relative path calculation.
 * @param platform - Path rules to use for the check.
 * @returns `true` when the path stays inside cwd.
 */
export function isRelativePathInsideCwd(
  relativePath: string,
  platform: PathPlatform,
): boolean {
  if (relativePath === '' || relativePath === '.' || relativePath === '..') {
    return false;
  }

  if (relativePath.startsWith('../') || relativePath.startsWith('..\\')) {
    return false;
  }

  if (platform === 'windows') {
    return !win32.isAbsolute(relativePath);
  }

  return (
    !posix.isAbsolute(relativePath) && !isWindowsAbsolutePath(relativePath)
  );
}

/**
 * Checks whether one resolved real path is inside another real directory path.
 *
 * @param directory - Real directory path that bounds the check.
 * @param realPath - Real path to test against the directory.
 * @returns `true` when `realPath` is the directory itself or a child path.
 */
export function isRealPathInsideDirectory(
  directory: string,
  realPath: string,
): boolean {
  validateNonEmptyString(directory, 'directory', 'a non-empty string path');
  validateNonEmptyString(realPath, 'realPath', 'a non-empty string path');

  const platform = detectPathPlatform(directory);
  let relativePath: string;

  if (platform === 'windows') {
    relativePath = win32.relative(directory, realPath);
  } else {
    relativePath = posix.relative(directory, realPath);
  }

  if (relativePath === '' || relativePath === '.') {
    return true;
  }

  return isRelativePathInsideCwd(relativePath, platform);
}

/**
 * Chooses POSIX or Windows path rules from an absolute-looking path.
 *
 * @param path - Path used to choose the platform.
 * @returns The matching path platform.
 */
export function detectPathPlatform(path: string): PathPlatform {
  if (isWindowsAbsolutePath(path)) {
    return 'windows';
  }

  return 'posix';
}

/**
 * Checks whether a path is an absolute Windows path.
 *
 * @param path - Path to check.
 * @returns `true` when the path is absolute by Windows rules.
 */
export function isWindowsAbsolutePath(path: string): boolean {
  return win32.isAbsolute(path.trim());
}

function normalizePathSeparators(path: string): string {
  return path.replace(/\\/gu, '/');
}
