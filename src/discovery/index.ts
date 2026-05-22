/** @fileoverview Resolves file paths against include/exclude patterns. */

import type {
  DiscoverFilesOptions,
  DiscoveryPlan,
  PreparedDiscoveryOptions,
} from '@/discovery/types.js';

import {
  discoverGitVisibleMatches,
  filterIgnoredMatches,
} from '@/discovery/gitignore.js';
import { createScopedDiscoveryMatcher } from '@/discovery/matchers.js';
import {
  validateExtensionList,
  validateGroupList,
  validatePatternList,
} from '@/discovery/pattern-validation.js';
import {
  buildDefaultSoftExcludes,
  expandGroupPatterns,
  matchesCandidateExtension,
  normalizeGlobPatterns,
  resolveCandidatePatterns,
} from '@/discovery/patterns.js';
import { compareFilePaths } from '@/discovery/sort.js';
import { discoverWithGlob } from '@/discovery/walker.js';
import {
  assertSafeUserPathString,
  type RepoGlob,
  type RepoPath,
} from '@/paths/brands.js';
import {
  filterRepoPathsByScope,
  resolveExistingRepoScope,
} from '@/paths/scope.js';
import {
  HARD_EXCLUDE_PATTERNS,
  resolveWorkingDirectory,
} from '@/shared/defaults.js';
import {
  assertDiscoveryFileCountWithinLimit,
  assertFileCountWithinLimit,
  DEFAULT_MAX_FILES,
  type MaxFiles,
  validateMaxFiles,
} from '@/shared/max-files.js';
import {
  validateOptionalBoolean,
  validateOptionsObject,
} from '@/shared/validation.js';

export type { DiscoverFilesOptions } from '@/discovery/types.js';

/**
 * Finds source files under a working directory using the project's default
 * include and exclude rules, unless the caller overrides them. `include`
 * rescues matching files from soft excludes only; it does not broaden the
 * candidate set beyond the active extension filter.
 *
 * @param options - Optional group-or-glob filters and working directory overrides.
 * @returns A sorted list of checked relative file paths that match the effective rules.
 */
export async function discoverFiles(
  options: DiscoverFilesOptions = {},
): Promise<readonly RepoPath[]> {
  const checkedOptions = validateOptionsObject(
    options,
    'discoverFiles options',
  );

  return runDiscovery(checkedOptions);
}

async function runDiscovery(
  options: Readonly<Record<string, unknown>>,
): Promise<readonly RepoPath[]> {
  const preparedOptions = await prepareDiscoveryOptions(options);
  const plan = buildDiscoveryPlan(preparedOptions);
  const files = await runDiscoveryPlan(plan, preparedOptions);
  assertDiscoveryResultWithinLimit(files.length, preparedOptions.maxFiles);

  return files;
}

async function prepareDiscoveryOptions(
  options: Readonly<Record<string, unknown>>,
): Promise<PreparedDiscoveryOptions> {
  const workingDirectory = resolveWorkingDirectory(options['cwd']);
  const extensions = validateExtensionList(options['ext']);
  const includeGlobs = validatePatternList(options['include'], 'include') ?? [];
  const includeGroups =
    validateGroupList(options['includeGroups'], 'includeGroups') ?? [];
  const excludeGlobs = validatePatternList(options['exclude'], 'exclude') ?? [];
  const excludeGroups =
    validateGroupList(options['excludeGroups'], 'excludeGroups') ?? [];
  const maxFiles = validateMaxFiles(options['maxFiles'] ?? DEFAULT_MAX_FILES);
  const noDefaultExcludes =
    validateOptionalBoolean(
      options['noDefaultExcludes'],
      'noDefaultExcludes',
      'a boolean',
    ) ?? false;
  const scope = await resolveExistingRepoScope(
    options['scope'],
    workingDirectory,
  );

  return {
    excludeGlobs,
    excludeGroups,
    extensions,
    includeGlobs,
    includeGroups,
    maxFiles,
    noDefaultExcludes,
    scope,
    workingDirectory,
  };
}

function assertDiscoveryResultWithinLimit(
  count: number,
  maxFiles: MaxFiles,
): void {
  assertFileCountWithinLimit(count, maxFiles);
}

function buildDiscoveryPlan(options: PreparedDiscoveryOptions): DiscoveryPlan {
  const includePatterns = resolveCandidatePatterns(options.extensions);
  const includeGroupPatterns = expandGroupPatterns(options.includeGroups);
  const excludeGroupPatterns = expandGroupPatterns(options.excludeGroups);
  const defaultSoftExcludes = buildDefaultSoftExcludes(
    options.noDefaultExcludes,
  );
  const rescuePatterns = [...options.includeGlobs, ...includeGroupPatterns];
  const explicitExcludePatterns = [
    ...options.excludeGlobs,
    ...excludeGroupPatterns,
  ];

  return {
    explicitExcludePatterns,
    hardExcludePatterns: normalizeGlobPatterns(
      HARD_EXCLUDE_PATTERNS,
      'exclude pattern',
    ),
    hasRescues: rescuePatterns.length > 0,
    includePatterns,
    rescuePatterns,
    softExcludePatterns: defaultSoftExcludes,
    walkDirectory: getDiscoveryWalkDirectory(options.scope),
  };
}

async function runDiscoveryPlan(
  plan: DiscoveryPlan,
  options: PreparedDiscoveryOptions,
): Promise<readonly RepoPath[]> {
  if (options.scope.kind === 'file') {
    return discoverSingleScopedFile(plan, options.scope.path, options);
  }

  const gitVisibleMatchesResult = await discoverGitVisibleMatches(
    options.workingDirectory,
  );

  if (gitVisibleMatchesResult.status === 'answered') {
    const filemapMatches = applyFilemapFilters(
      gitVisibleMatchesResult.matches,
      plan,
      options,
    );

    return finishGitVisibleMatches(filemapMatches, options);
  }

  if (!plan.hasRescues) {
    const visibleMatchesPromise = discoverWithGlob(
      plan.includePatterns,
      getVisibleIgnorePatterns(plan),
      options.workingDirectory,
      options.maxFiles,
      plan.walkDirectory,
    );

    return runDiscoveryPlanWithoutRescues(options, visibleMatchesPromise);
  }

  return runDiscoveryPlanWithRescues(plan, options);
}

async function discoverSingleScopedFile(
  plan: DiscoveryPlan,
  scopePath: RepoPath,
  options: PreparedDiscoveryOptions,
): Promise<readonly RepoPath[]> {
  const filemapMatches = applyFilemapFilters([scopePath], plan, options);

  return finishDiscoveredMatches(filemapMatches, options);
}

async function runDiscoveryPlanWithoutRescues(
  options: PreparedDiscoveryOptions,
  visibleMatchesPromise: Promise<readonly RepoPath[]>,
): Promise<readonly RepoPath[]> {
  const visibleMatches = await visibleMatchesPromise;
  const visibleMatchesWithoutRescues = visibleMatches.filter((match) =>
    matchesCandidateExtension(match, options.extensions),
  );

  return finishDiscoveredMatches(visibleMatchesWithoutRescues, options);
}

/**
 * Keeps visible candidates and soft-excluded candidates rescued by include rules.
 */
async function runDiscoveryPlanWithRescues(
  plan: DiscoveryPlan,
  options: PreparedDiscoveryOptions,
): Promise<readonly RepoPath[]> {
  const candidateMatches = await discoverWithGlob(
    plan.includePatterns,
    plan.hardExcludePatterns,
    options.workingDirectory,
    options.maxFiles,
    plan.walkDirectory,
  );

  const candidateSet = new Set(
    candidateMatches.filter((match) =>
      matchesCandidateExtension(match, options.extensions),
    ),
  );
  assertDiscoveryFileCountWithinLimit(candidateSet.size, options.maxFiles);

  const isVisibleIgnored = createScopedDiscoveryMatcher(
    getVisibleIgnorePatterns(plan),
    options.scope,
  );
  const isExplicitlyExcluded = createScopedDiscoveryMatcher(
    plan.explicitExcludePatterns,
    options.scope,
  );
  const isRescued = createScopedDiscoveryMatcher(
    plan.rescuePatterns,
    options.scope,
  );
  const mergedMatches: RepoPath[] = [];

  for (const match of candidateSet) {
    if (isExplicitlyExcluded(match)) {
      continue;
    }

    if (!isVisibleIgnored(match) || isRescued(match)) {
      mergedMatches.push(match);
    }
  }

  return finishDiscoveredMatches(mergedMatches, options);
}

function applyFilemapFilters(
  matches: readonly RepoPath[],
  plan: DiscoveryPlan,
  options: PreparedDiscoveryOptions,
): RepoPath[] {
  const isCandidate = createScopedDiscoveryMatcher(
    plan.includePatterns,
    options.scope,
  );
  const isHardExcluded = createScopedDiscoveryMatcher(
    plan.hardExcludePatterns,
    options.scope,
  );
  const isSoftExcluded = createScopedDiscoveryMatcher(
    plan.softExcludePatterns,
    options.scope,
  );
  const isExplicitlyExcluded = createScopedDiscoveryMatcher(
    plan.explicitExcludePatterns,
    options.scope,
  );
  const isRescued = createScopedDiscoveryMatcher(
    plan.rescuePatterns,
    options.scope,
  );
  const filemapMatches: RepoPath[] = [];

  for (const match of matches) {
    if (!isCandidate(match)) {
      continue;
    }

    if (!matchesCandidateExtension(match, options.extensions)) {
      continue;
    }

    if (isHardExcluded(match) || isExplicitlyExcluded(match)) {
      continue;
    }

    if (isSoftExcluded(match) && (!plan.hasRescues || !isRescued(match))) {
      continue;
    }

    filemapMatches.push(match);
  }

  return filemapMatches;
}

function getVisibleIgnorePatterns(plan: DiscoveryPlan): readonly RepoGlob[] {
  return [
    ...plan.hardExcludePatterns,
    ...plan.softExcludePatterns,
    ...plan.explicitExcludePatterns,
  ];
}

function getDiscoveryWalkDirectory(
  scope: PreparedDiscoveryOptions['scope'],
): '' | RepoPath {
  if (scope.kind === 'directory') {
    return scope.path;
  }

  return '';
}

async function finishDiscoveredMatches(
  matches: readonly RepoPath[],
  options: PreparedDiscoveryOptions,
): Promise<readonly RepoPath[]> {
  const filteredMatches = filterRepoPathsByScope(matches, options.scope);
  assertDiscoveryFileCountWithinLimit(filteredMatches.length, options.maxFiles);
  const gitVisibleMatches = await filterIgnoredMatches(
    filteredMatches,
    options.workingDirectory,
  );

  return rejectUnsafeDiscoveredPaths(gitVisibleMatches).sort(compareFilePaths);
}

function finishGitVisibleMatches(
  matches: readonly RepoPath[],
  options: PreparedDiscoveryOptions,
): readonly RepoPath[] {
  const filteredMatches = filterRepoPathsByScope(matches, options.scope);
  assertDiscoveryResultWithinLimit(filteredMatches.length, options.maxFiles);

  return rejectUnsafeDiscoveredPaths(filteredMatches).sort(compareFilePaths);
}

function rejectUnsafeDiscoveredPaths(
  filePaths: readonly RepoPath[],
): RepoPath[] {
  return filePaths.map((filePath) => {
    assertSafeUserPathString(filePath, 'filePath');

    return filePath;
  });
}
