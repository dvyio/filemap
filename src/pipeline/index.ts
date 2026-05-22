/** @fileoverview Builds file and collapsed-directory map entries from discovered source paths */

import { realpath } from 'node:fs/promises';

import {
  type CwdPath,
  normalizePathInsideCwdLexically,
  type RepoPath,
  resolvePathFromCwd,
  toCwdPath,
  toRepoPath,
} from '@/paths/brands.js';
import {
  assertRealPathInsideCwd,
  type ExistingRepoScope,
  filterRepoPathsByScope,
  readPathStatsIfExists,
  type RepoScope,
  resolveCheckedExistingRepoScope,
} from '@/paths/scope.js';
import {
  type CollapsePlan,
  planCollapseDirectories,
} from '@/pipeline/collapse.js';
import { type Depth } from '@/pipeline/depth.js';
import { resolveEntryDirectoryPath } from '@/pipeline/entry-paths.js';
import {
  getInvalidSidecarErrorMessage,
  isInvalidSidecarError,
  isSidecarReadError,
  readDirectorySidecar,
} from '@/pipeline/sidecars.js';
import {
  readSourceFileOverview,
  type ValidatedFilePath,
  validateFilePaths,
} from '@/pipeline/source-files.js';
import { type OverviewTag } from '@/pipeline/tag.js';
import {
  DEFAULT_CONCURRENCY,
  mapWithConcurrency,
} from '@/shared/concurrency.js';
import { formatInvalidValueMessage } from '@/shared/error-format.js';
import {
  assertFileCountWithinLimit,
  DEFAULT_MAX_FILES,
  type MaxFiles,
} from '@/shared/max-files.js';
import { assertNever, formatDisplayValue } from '@/shared/validation.js';

/** Checked map options from the CLI path; filesystem checks still happen while building entries. */
export interface CheckedBuildMapInputOptions {
  readonly collapseDirs?: readonly string[] | undefined;
  readonly cwd: CwdPath;
  readonly depth?: Depth | undefined;
  readonly maxFiles?: MaxFiles | undefined;
  readonly scope?: RepoScope | undefined;
  readonly tag?: OverviewTag | undefined;
}

/** Describes a rendered map item; `path` may be repo-relative or scope-relative after CLI scope stripping. */
export type MapEntry =
  | {
      readonly description: string | undefined;
      readonly hiddenFileCount: number;
      readonly kind: 'directory';
      readonly path: string;
    }
  | {
      readonly description: string | undefined;
      readonly kind: 'file';
      readonly path: string;
    };

interface BuildMapOptions {
  readonly depth: Depth | undefined;
  readonly explicitCollapseDirectories: readonly RepoPath[];
  readonly maxFiles: MaxFiles;
  readonly scope: ExistingRepoScope;
  readonly tag: OverviewTag | undefined;
  readonly workingDirectory: CwdPath;
  readonly workingDirectoryRealPath: CwdPath;
}

/**
 * Builds map entries from paths returned by `discoverFiles()`.
 *
 * @param filePaths - Checked repo-relative file paths from discovery.
 * @param options - Checked CLI options for the current map run.
 * @returns A sorted list of file and directory map entries as plain data objects.
 */
export async function buildMapFromDiscoveredFiles(
  filePaths: readonly RepoPath[],
  options: CheckedBuildMapInputOptions,
): Promise<readonly MapEntry[]> {
  const preparedOptions = await resolveCheckedBuildMapOptions(options);

  return buildMapEntries(filePaths, preparedOptions);
}

async function buildMapEntries(
  filePaths: readonly RepoPath[],
  options: BuildMapOptions,
): Promise<readonly MapEntry[]> {
  const scopedFilePaths = prepareScopedFilePaths(filePaths, options);
  const collapseFileVisibilityPlan = planCollapseDirectories(
    scopedFilePaths,
    options.explicitCollapseDirectories,
    options.depth,
    getDepthRootPath(options.scope),
  );
  const validatedFilePaths = await validateFilePaths(
    collapseFileVisibilityPlan.visibleFilePathStrings,
    options.workingDirectory,
    options.workingDirectoryRealPath,
  );
  assertFileCountWithinLimit(
    collapseFileVisibilityPlan.visibleFilePathStrings.length,
    options.maxFiles,
  );

  try {
    return await readMapEntries(
      validatedFilePaths,
      collapseFileVisibilityPlan.collapsePlan,
      options,
    );
  } catch (error) {
    if (isInvalidSidecarError(error)) {
      throw new Error(getInvalidSidecarErrorMessage(error), { cause: error });
    }

    if (isSidecarReadError(error)) {
      throw error;
    }

    throw new Error(
      `Failed to build file map entries in cwd "${formatDisplayValue(options.workingDirectory)}" — fix the collapse options or file read error and try again.`,
      { cause: error },
    );
  }
}

async function resolveCheckedBuildMapOptions(
  options: CheckedBuildMapInputOptions,
): Promise<BuildMapOptions> {
  const workingDirectory = options.cwd;
  const workingDirectoryRealPath = toCwdPath(await realpath(workingDirectory));
  const scope = await resolveCheckedExistingRepoScope(
    options.scope,
    workingDirectory,
    workingDirectoryRealPath,
  );
  const explicitCollapseDirectories = await normalizeCheckedDirectoryPaths(
    options.collapseDirs ?? [],
    workingDirectory,
    workingDirectoryRealPath,
  );

  return {
    depth: options.depth,
    explicitCollapseDirectories,
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
    scope,
    tag: options.tag,
    workingDirectory,
    workingDirectoryRealPath,
  };
}

function prepareScopedFilePaths(
  filePaths: readonly RepoPath[],
  context: BuildMapOptions,
): readonly RepoPath[] {
  return filterRepoPathsByScope(filePaths, context.scope);
}

function getDepthRootPath(scope: ExistingRepoScope): '' | RepoPath {
  switch (scope.kind) {
    case 'all':
      return '';

    case 'directory':
      return scope.path;

    case 'file':
      return resolveEntryDirectoryPath(scope.path) ?? '';

    default:
      return assertNever(scope, 'repo scope', 'all, directory, or file');
  }
}

async function readMapEntries(
  visibleFilePaths: readonly ValidatedFilePath[],
  collapsePlan: CollapsePlan,
  context: BuildMapOptions,
): Promise<readonly MapEntry[]> {
  const [visibleEntries, directoryEntries] = await Promise.all([
    readVisibleFileEntries(visibleFilePaths, context),
    readCollapsedDirectoryEntries(collapsePlan, context),
  ]);

  return [...visibleEntries, ...directoryEntries];
}

async function readVisibleFileEntries(
  visibleFilePaths: readonly ValidatedFilePath[],
  context: BuildMapOptions,
): Promise<readonly MapEntry[]> {
  return mapWithConcurrency(
    visibleFilePaths,
    DEFAULT_CONCURRENCY,
    async (filePath): Promise<MapEntry> => {
      return {
        description: await readSourceFileOverview(
          context.workingDirectory,
          filePath,
          context.tag,
        ),
        kind: 'file',
        path: filePath.path,
      };
    },
  );
}

async function readCollapsedDirectoryEntries(
  collapsePlan: CollapsePlan,
  context: BuildMapOptions,
): Promise<readonly MapEntry[]> {
  return mapWithConcurrency(
    collapsePlan.collapsedDirectories,
    DEFAULT_CONCURRENCY,
    async (directory): Promise<MapEntry> => {
      return {
        description: await readDirectorySidecar(
          context.workingDirectory,
          context.workingDirectoryRealPath,
          directory.path,
        ),
        hiddenFileCount: directory.hiddenFileCount,
        kind: 'directory',
        path: directory.path,
      };
    },
  );
}

async function normalizeCheckedDirectoryPaths(
  directoryPathList: readonly string[],
  workingDirectory: CwdPath,
  workingDirectoryRealPath: CwdPath,
): Promise<RepoPath[]> {
  const normalizedDirectories: RepoPath[] = [];

  for (const directoryPath of directoryPathList) {
    normalizedDirectories.push(
      await normalizeDirectoryPath(
        directoryPath,
        workingDirectory,
        workingDirectoryRealPath,
      ),
    );
  }

  return [...new Set(normalizedDirectories)].sort();
}

async function normalizeDirectoryPath(
  directoryPath: string,
  workingDirectory: CwdPath,
  workingDirectoryRealPath: CwdPath,
): Promise<RepoPath> {
  const optionLabel = 'collapseDir';
  const relativeDirectoryPath = toRepoPath(
    normalizePathInsideCwdLexically(
      directoryPath,
      workingDirectory,
      optionLabel,
    ).replace(/\/+$/u, ''),
    optionLabel,
  );

  const resolvedDirectoryPath = resolvePathFromCwd(
    workingDirectory,
    relativeDirectoryPath,
  );
  const directoryStats = await readPathStatsIfExists(
    resolvedDirectoryPath,
    optionLabel,
    directoryPath,
  );

  if (directoryStats === undefined || !directoryStats.isDirectory()) {
    throw new Error(
      formatInvalidValueMessage(
        optionLabel,
        directoryPath,
        `an existing directory relative to cwd "${formatDisplayValue(workingDirectory)}"`,
      ),
    );
  }

  await assertRealPathInsideCwd({
    cwd: workingDirectory,
    cwdRealPath: workingDirectoryRealPath,
    expectedKind: 'directory',
    fieldName: optionLabel,
    originalPath: directoryPath,
    resolvedPath: resolvedDirectoryPath,
  });

  return relativeDirectoryPath;
}
