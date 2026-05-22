/** @fileoverview Plans which directories replace their hidden file entries */

import { isRepoPathAtOrInside, type RepoPath } from '@/paths/brands.js';
import { type Depth } from '@/pipeline/depth.js';
import { resolveEntryDirectoryPath } from '@/pipeline/entry-paths.js';

interface CollapsedDirectory {
  readonly hiddenFileCount: number;
  readonly path: RepoPath;
}

export interface CollapsePlan {
  readonly collapsedDirectories: readonly CollapsedDirectory[];
}

export interface CollapseFileVisibilityPlan {
  readonly collapsePlan: CollapsePlan;
  readonly visibleFilePathStrings: readonly RepoPath[];
}

interface CollapseFileVisibility {
  readonly collapsedDirectories: readonly CollapsedDirectory[];
  readonly visibleFilePathStrings: readonly RepoPath[];
}

/**
 * Plans collapsed directory entries and visible files in one pass.
 *
 * @param visibleFilePathStrings - Scoped, normalized file paths before collapse filtering.
 * @param explicitCollapseDirectories - Directories the caller asked to collapse.
 * @param depth - Maximum visible directory depth.
 * @param depthRootPath - Scope-relative root used for depth checks.
 * @returns The directory collapse plan and file paths that should stay visible.
 */
export function planCollapseDirectories(
  visibleFilePathStrings: readonly RepoPath[],
  explicitCollapseDirectories: readonly RepoPath[],
  depth: Depth | undefined,
  depthRootPath: '' | RepoPath,
): CollapseFileVisibilityPlan {
  const collapseDirectories = pruneNestedDirectories([
    ...explicitCollapseDirectories,
    ...collectDepthCollapseDirectories(
      visibleFilePathStrings,
      depth,
      depthRootPath,
    ),
  ]);
  const collapseFileVisibility = collectCollapseFileVisibility(
    visibleFilePathStrings,
    collapseDirectories,
  );

  return {
    collapsePlan: {
      collapsedDirectories: collapseFileVisibility.collapsedDirectories,
    },
    visibleFilePathStrings: collapseFileVisibility.visibleFilePathStrings,
  };
}

function collectCollapseFileVisibility(
  filePaths: readonly RepoPath[],
  collapseDirectories: readonly RepoPath[],
): CollapseFileVisibility {
  const collapseDirectorySet = new Set(collapseDirectories);
  const hiddenCounts = new Map<RepoPath, number>();
  const visibleFilePathStrings: RepoPath[] = [];

  for (const collapseDirectory of collapseDirectories) {
    hiddenCounts.set(collapseDirectory, 0);
  }

  for (const filePath of filePaths) {
    const matchingDirectory = findMatchingCollapseDirectory(
      filePath,
      collapseDirectorySet,
    );

    if (matchingDirectory === undefined) {
      visibleFilePathStrings.push(filePath);
      continue;
    }

    const currentCount = hiddenCounts.get(matchingDirectory) ?? 0;
    hiddenCounts.set(matchingDirectory, currentCount + 1);
  }

  return {
    collapsedDirectories: collapseDirectories
      .map((directoryPath) => {
        return {
          hiddenFileCount: hiddenCounts.get(directoryPath) ?? 0,
          path: directoryPath,
        } satisfies CollapsedDirectory;
      })
      .filter((directory) => directory.hiddenFileCount > 0),
    visibleFilePathStrings,
  };
}

function findMatchingCollapseDirectory(
  filePath: RepoPath,
  collapseDirectorySet: ReadonlySet<RepoPath>,
): RepoPath | undefined {
  let currentDirectory = resolveEntryDirectoryPath(filePath);

  while (currentDirectory !== undefined) {
    if (collapseDirectorySet.has(currentDirectory)) {
      return currentDirectory;
    }

    currentDirectory = resolveEntryDirectoryPath(currentDirectory);
  }

  return undefined;
}

function collectDepthCollapseDirectories(
  filePaths: readonly RepoPath[],
  depth: Depth | undefined,
  depthRootPath: '' | RepoPath,
): RepoPath[] {
  if (depth === undefined) {
    return [];
  }

  const depthCollapseDirectories: RepoPath[] = [];

  for (const directoryPath of collectAllDirectories(filePaths)) {
    if (!isInsideDepthRoot(directoryPath, depthRootPath)) {
      continue;
    }

    const relativeDepth = computeRelativeDepth(directoryPath, depthRootPath);

    if (relativeDepth <= depth) {
      continue;
    }

    depthCollapseDirectories.push(directoryPath);
  }

  return depthCollapseDirectories;
}

function isInsideDepthRoot(
  directoryPath: RepoPath,
  depthRootPath: '' | RepoPath,
): boolean {
  if (depthRootPath === '') {
    return true;
  }

  return isRepoPathAtOrInside(directoryPath, depthRootPath);
}

function collectAllDirectories(filePaths: readonly RepoPath[]): RepoPath[] {
  const directories = new Set<RepoPath>();

  for (const filePath of filePaths) {
    let currentDirectory = resolveEntryDirectoryPath(filePath);

    while (currentDirectory !== undefined) {
      directories.add(currentDirectory);
      currentDirectory = resolveEntryDirectoryPath(currentDirectory);
    }
  }

  return [...directories].sort();
}

function computeRelativeDepth(
  directoryPath: RepoPath,
  depthRootPath: '' | RepoPath,
): number {
  const relativeDirectoryPath = stripDepthRootPrefix(
    directoryPath,
    depthRootPath,
  );

  if (relativeDirectoryPath === '') {
    return 0;
  }

  return relativeDirectoryPath.split('/').length;
}

function stripDepthRootPrefix(
  directoryPath: RepoPath,
  depthRootPath: '' | RepoPath,
): string {
  if (depthRootPath === '') {
    return directoryPath;
  }

  if (directoryPath === depthRootPath) {
    return '';
  }

  if (directoryPath.startsWith(`${depthRootPath}/`)) {
    return directoryPath.slice(depthRootPath.length + 1);
  }

  return directoryPath;
}

function pruneNestedDirectories(
  directoryPaths: readonly RepoPath[],
): RepoPath[] {
  const deduplicatedDirectories = [...new Set(directoryPaths)].sort();
  const prunedDirectorySet = new Set<RepoPath>();
  const prunedDirectories: RepoPath[] = [];

  for (const directoryPath of deduplicatedDirectories) {
    if (
      findAncestorDirectory(directoryPath, prunedDirectorySet) !== undefined
    ) {
      continue;
    }

    prunedDirectories.push(directoryPath);
    prunedDirectorySet.add(directoryPath);
  }

  return prunedDirectories;
}

function findAncestorDirectory(
  directoryPath: RepoPath,
  directorySet: ReadonlySet<RepoPath>,
): RepoPath | undefined {
  let currentDirectory = resolveEntryDirectoryPath(directoryPath);

  while (currentDirectory !== undefined) {
    if (directorySet.has(currentDirectory)) {
      return currentDirectory;
    }

    currentDirectory = resolveEntryDirectoryPath(currentDirectory);
  }

  return undefined;
}
