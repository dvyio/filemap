/** @fileoverview Builds and validates discovery glob patterns */

import { type Extension } from '@/discovery/types.js';
import {
  normalizeRepoGlobPattern,
  REPO_GLOB_PATTERN_EXPECTATION,
  type RepoGlob,
  type RepoPath,
} from '@/paths/brands.js';
import {
  DEFAULT_EXTENSIONS,
  DEFAULT_INCLUDE_PATTERNS,
  EXCLUDE_GROUP_ORDER,
  EXCLUDE_GROUPS,
} from '@/shared/defaults.js';
import { formatInvalidValueMessage } from '@/shared/error-format.js';

/**
 * Normalizes trusted include or exclude patterns.
 *
 * @param patterns - Trusted repo-relative glob patterns.
 * @param fieldName - Name used in validation errors.
 * @returns Normalized repo-relative glob patterns.
 */
export function normalizeGlobPatterns(
  patterns: readonly string[],
  fieldName: string,
): RepoGlob[] {
  return patterns.map((pattern) =>
    normalizeRepoGlobPattern(pattern, fieldName, REPO_GLOB_PATTERN_EXPECTATION),
  );
}

/**
 * Builds candidate include patterns for the active extension filter.
 *
 * @param extensions - Optional literal extensions supplied by the caller.
 * @returns Repo-relative glob patterns used for candidate scans.
 */
export function resolveCandidatePatterns(
  extensions: readonly Extension[] | undefined,
): RepoGlob[] {
  if (extensions === undefined) {
    return normalizeGlobPatterns(DEFAULT_INCLUDE_PATTERNS, 'include pattern');
  }

  if (extensions.length === 1) {
    return [
      normalizeRepoGlobPattern(
        `**/*.${extensions[0]}`,
        'include pattern',
        REPO_GLOB_PATTERN_EXPECTATION,
      ),
    ];
  }

  return [
    normalizeRepoGlobPattern(
      `**/*.{${extensions.join(',')}}`,
      'include pattern',
      REPO_GLOB_PATTERN_EXPECTATION,
    ),
  ];
}

/**
 * Builds default soft-exclude patterns unless the caller disabled them.
 *
 * @param noDefaultExcludes - Whether default soft excludes are disabled.
 * @returns Repo-relative exclude patterns.
 */
export function buildDefaultSoftExcludes(
  noDefaultExcludes: boolean | undefined,
): RepoGlob[] {
  if (noDefaultExcludes === true) {
    return [];
  }

  const defaultExcludePatterns = EXCLUDE_GROUP_ORDER.map(
    (groupName) => EXCLUDE_GROUPS[groupName],
  )
    .filter((group) => group.defaultOn)
    .flatMap((group) => group.patterns);

  return normalizeGlobPatterns(defaultExcludePatterns, 'exclude pattern');
}

/**
 * Expands named exclude groups into repo-relative patterns.
 *
 * @param groups - Checked group names from user options.
 * @returns Repo-relative patterns for those groups.
 */
export function expandGroupPatterns(groups: readonly string[]): RepoGlob[] {
  return groups.flatMap((group) => {
    if (!isExcludeGroupName(group)) {
      const available = EXCLUDE_GROUP_ORDER.join(', ');

      throw new Error(
        formatInvalidValueMessage('group', group, `one of: ${available}`),
      );
    }

    return normalizeGlobPatterns(
      EXCLUDE_GROUPS[group].patterns,
      'group pattern',
    );
  });
}

/**
 * Checks whether a path matches the active candidate extension list.
 *
 * @param filePath - Repo-relative file path.
 * @param extensions - Optional literal extensions supplied by the caller.
 * @returns `true` when the file path uses an active extension.
 */
export function matchesCandidateExtension(
  filePath: RepoPath,
  extensions: readonly Extension[] | undefined,
): boolean {
  const activeExtensions: readonly string[] = extensions ?? DEFAULT_EXTENSIONS;
  const fileExtension = getFileExtension(filePath);

  /* v8 ignore next 3 */
  if (fileExtension === undefined) {
    return false;
  }

  return activeExtensions.includes(fileExtension);
}

function getFileExtension(filePath: string): string | undefined {
  const fileName = filePath.split('/').at(-1);

  /* v8 ignore next 3 */
  if (fileName === undefined) {
    return undefined;
  }

  const lastDotIndex = fileName.lastIndexOf('.');

  /* v8 ignore next 3 */
  if (lastDotIndex === -1 || lastDotIndex === fileName.length - 1) {
    return undefined;
  }

  return fileName.slice(lastDotIndex + 1);
}

function isExcludeGroupName(
  value: string,
): value is keyof typeof EXCLUDE_GROUPS {
  return Object.hasOwn(EXCLUDE_GROUPS, value);
}
