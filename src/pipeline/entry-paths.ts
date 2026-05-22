/** @fileoverview Sorts map entries and finds parent paths for map planning */

import { type RepoPath, toRepoPath } from '@/paths/brands.js';

interface EntryPath {
  readonly path: string;
}

/**
 * Sorts map entries by parent directory and then by file or directory name.
 *
 * @param left - First entry being sorted.
 * @param right - Second entry being sorted.
 * @returns The order value for `Array.prototype.sort()`.
 */
export function compareMapEntries(left: EntryPath, right: EntryPath): number {
  const leftDirectory = resolveEntryDirectory(left.path);
  const rightDirectory = resolveEntryDirectory(right.path);

  let directoryComparison = 0;

  if (leftDirectory < rightDirectory) {
    directoryComparison = -1;
  }

  if (leftDirectory > rightDirectory) {
    directoryComparison = 1;
  }

  if (directoryComparison !== 0) {
    return directoryComparison;
  }

  const leftName = resolveEntryName(left.path);
  const rightName = resolveEntryName(right.path);

  if (leftName < rightName) {
    return -1;
  }

  if (leftName > rightName) {
    return 1;
  }

  return 0;
}

/**
 * Returns the parent directory part of a slash-separated path.
 *
 * @param entryPath - File or directory path to inspect.
 * @returns The parent directory, or `.` when the path has no slash.
 */
function resolveEntryDirectory(entryPath: string): string {
  const lastSlashIndex = entryPath.lastIndexOf('/');

  if (lastSlashIndex === -1) {
    return '.';
  }

  return entryPath.slice(0, lastSlashIndex);
}

/**
 * Returns the repo-relative parent directory for a repo path.
 *
 * @param entryPath - Repo-relative file or directory path.
 * @returns The parent directory path, or `undefined` for root children.
 */
export function resolveEntryDirectoryPath(
  entryPath: RepoPath,
): RepoPath | undefined {
  const directoryPath = resolveEntryDirectory(entryPath);

  if (directoryPath === '.') {
    return undefined;
  }

  return toRepoPath(directoryPath, 'directoryPath');
}

function resolveEntryName(entryPath: string): string {
  const lastSlashIndex = entryPath.lastIndexOf('/');

  if (lastSlashIndex === -1) {
    return entryPath;
  }

  return entryPath.slice(lastSlashIndex + 1);
}
