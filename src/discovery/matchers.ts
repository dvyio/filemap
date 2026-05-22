/** @fileoverview Builds glob matchers for discovery rules */

import picomatch from 'picomatch';

import {
  isRepoPathAtOrInside,
  type RepoGlob,
  type RepoPath,
} from '@/paths/brands.js';
import { type ExistingRepoScope } from '@/paths/scope.js';

const PICOMATCH_OPTIONS = { dot: true } as const;

export type PathMatcher = (path: string) => boolean;

function createDiscoveryMatcher(patterns: readonly RepoGlob[]): PathMatcher {
  if (patterns.length === 0) {
    /* v8 ignore next */
    return () => false;
  }

  return picomatch(patterns, PICOMATCH_OPTIONS);
}

/**
 * Builds a matcher that also accepts paths relative to the active directory scope.
 *
 * @param patterns - Repo-relative glob patterns.
 * @param scope - Checked discovery scope.
 * @returns A path matcher for repo paths and scope-relative paths.
 */
export function createScopedDiscoveryMatcher(
  patterns: readonly RepoGlob[],
  scope: ExistingRepoScope,
): PathMatcher {
  if (scope.kind !== 'directory') {
    return createDiscoveryMatcher(patterns);
  }

  return createRootedDiscoveryMatcher(patterns, scope.path);
}

/**
 * Builds a matcher that accepts repo paths and paths relative to a walk root.
 *
 * @param patterns - Repo-relative glob patterns.
 * @param rootPath - Repo-relative walk root.
 * @returns A path matcher for repo paths and root-relative paths.
 */
export function createRootedDiscoveryMatcher(
  patterns: readonly RepoGlob[],
  rootPath: '' | RepoPath,
): PathMatcher {
  const matcher = createDiscoveryMatcher(patterns);

  if (rootPath === '') {
    return matcher;
  }

  return (path: string): boolean => {
    if (matcher(path)) {
      return true;
    }

    const relativePath = getPathRelativeToDirectoryScope(path, rootPath);

    return relativePath !== undefined && matcher(relativePath);
  };
}

function getPathRelativeToDirectoryScope(
  path: string,
  scopePath: RepoPath,
): string | undefined {
  if (path === scopePath) {
    return '';
  }

  if (!isRepoPathAtOrInside(path, scopePath)) {
    return undefined;
  }

  return path.slice(scopePath.length + 1);
}
