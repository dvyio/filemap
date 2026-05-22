/** @fileoverview Formats CLI debug summaries and strict-mode failures */

import { homedir } from 'node:os';
import { basename, isAbsolute, relative } from 'node:path';

import type { DiscoverFilesOptions } from '@/discovery/index.js';
import type { MapEntry } from '@/pipeline/index.js';

import {
  replacePathPrefixCandidates,
  resolveReadablePath,
} from '@/cli/path-prefix.js';
import { type CwdPath, normalizeToPosixPath } from '@/paths/brands.js';
import { DEFAULT_OVERVIEW_TAGS, type OverviewTag } from '@/pipeline/tag.js';
import { DEFAULT_EXTENSIONS } from '@/shared/defaults.js';
import { DEFAULT_MAX_FILES } from '@/shared/max-files.js';
import { assertNever, formatDisplayValue } from '@/shared/validation.js';

const DEFAULT_OVERVIEW_TAG_LABEL = formatDefaultOverviewTagLabel();
const STRICT_DIRECTORY_RECOVERY =
  'Add a .overview file to each collapsed directory, remove the collapse flag, or run without --strict.';
const STRICT_MISSING_PATH_DISPLAY_LIMIT = 50;

/** Output writer for CLI messages that only need stderr. */
export interface CliReportOutput {
  readonly writeStderr: (message: string) => void;
}

/** Discovery inputs and the file count written when `--debug` is on. */
export interface DiscoveryDebugSummary {
  /** Working directory used for discovery. */
  readonly cwd: CwdPath;
  /** Discovery options passed to the file finder. */
  readonly discoverOptions: DiscoverFilesOptions;
  /** Number of files found, or `undefined` when discovery failed before counting. */
  readonly resultCount: number | undefined;
  /** Timings for discovery and map building when the run reached those steps. */
  readonly timings: DiscoveryDebugTimings | undefined;
}

interface DiscoveryDebugTimings {
  readonly discoveryMs: number;
  readonly mapBuildMs: number;
}

interface DebugPathRedactor {
  readonly redactCwd: (path: string) => string;
  readonly redactListValue: (path: string) => string;
}

interface MissingStrictFailureOptions {
  readonly entries: readonly MapEntry[];
  readonly formatPath: (entry: MapEntry) => string | undefined;
  readonly formatPrefix: (count: number, noun: string) => string;
  readonly pluralNoun: string;
  readonly recovery: string;
  readonly showAllMissingPaths: boolean;
  readonly singularNoun: string;
}

/**
 * Writes a short discovery summary when debug mode is on.
 *
 * @param summary - Debug summary for this run, or undefined when debug mode was off.
 * @param output - Stderr writer owned by the CLI boundary.
 * @param invocationCwd - Directory where the user ran the CLI.
 */
export function reportDiscoveryDebugSummary(
  summary: DiscoveryDebugSummary | undefined,
  output: CliReportOutput,
  invocationCwd: CwdPath,
): void {
  if (summary === undefined) {
    return;
  }

  output.writeStderr(formatDiscoveryDebugSummary(summary, invocationCwd));
}

/**
 * Returns strict-mode failures for missing file and directory descriptions.
 *
 * @param results - Map entries that will be rendered for the current scope.
 * @param tag - Optional custom overview tag used for this run.
 * @param strict - Whether strict mode is enabled.
 * @param showAllMissingPaths - Whether to show every missing path.
 * @returns Human-readable failure messages for stderr.
 */
export function getStrictValidationFailures(
  results: readonly MapEntry[],
  tag: OverviewTag | undefined,
  strict: boolean,
  showAllMissingPaths: boolean,
): readonly string[] {
  if (!strict) {
    return [];
  }

  const failures: string[] = [];
  const missingFileFailure = formatMissingFileStrictFailure(
    results,
    tag,
    showAllMissingPaths,
  );
  const missingDirectoryFailure = formatMissingDirectoryStrictFailure(
    results,
    showAllMissingPaths,
  );

  if (missingFileFailure !== undefined) {
    failures.push(missingFileFailure);
  }

  if (missingDirectoryFailure !== undefined) {
    failures.push(missingDirectoryFailure);
  }

  return failures;
}

/**
 * Writes strict-mode failures to stderr.
 *
 * @param failures - Messages returned by `getStrictValidationFailures()`.
 * @param output - Stderr writer owned by the CLI boundary.
 */
export function reportStrictFailures(
  failures: readonly string[],
  output: CliReportOutput,
): void {
  for (const failure of failures) {
    writeErrorLine(output, failure);
  }
}

function formatDiscoveryDebugSummary(
  summary: DiscoveryDebugSummary,
  invocationCwd: CwdPath,
): string {
  const redactor = createDebugPathRedactor(summary.cwd, invocationCwd);
  const options = summary.discoverOptions;
  const lines = [
    'filemap debug',
    `cwd: ${formatDebugCwd(summary.cwd, redactor)}; scope: ${formatDisplayValue(options.scope ?? '(all)')}`,
    ...formatDiscoveryFilterDebugLines(options, redactor),
    `limits: max files ${String(options.maxFiles ?? DEFAULT_MAX_FILES)}`,
    `result: ${formatDiscoveryResultCount(summary.resultCount)}`,
    ...formatDiscoveryTimingDebugLines(summary.timings),
    '',
  ];

  return lines.join('\n');
}

function formatDiscoveryTimingDebugLines(
  timings: DiscoveryDebugTimings | undefined,
): readonly string[] {
  if (timings === undefined) {
    return [];
  }

  return [
    'timing:',
    `  discovery: ${formatDebugMilliseconds(timings.discoveryMs)}`,
    `  map build: ${formatDebugMilliseconds(timings.mapBuildMs)}`,
  ];
}

function formatDebugMilliseconds(milliseconds: number): string {
  return `${String(milliseconds)} ms`;
}

function formatDiscoveryFilterDebugLines(
  options: DiscoverFilesOptions,
  redactor: DebugPathRedactor,
): readonly string[] {
  return [
    'filters:',
    `  extensions: ${formatDebugList(options.ext ?? DEFAULT_EXTENSIONS)}`,
    `  include: ${formatDebugList(options.include ?? [], redactor)}`,
    `  include groups: ${formatDebugList(options.includeGroups ?? [])}`,
    `  exclude: ${formatDebugList(options.exclude ?? [], redactor)}`,
    `  exclude groups: ${formatDebugList(options.excludeGroups ?? [])}`,
    `  default excludes: ${options.noDefaultExcludes === true ? 'off' : 'on'}`,
    `  rescue mode: ${hasRescuePatterns(options) ? 'on' : 'off'}`,
  ];
}

function hasRescuePatterns(options: DiscoverFilesOptions): boolean {
  return (
    (options.include ?? []).length > 0 ||
    (options.includeGroups ?? []).length > 0
  );
}

function createDebugPathRedactor(
  cwd: CwdPath,
  invocationCwd: CwdPath,
): DebugPathRedactor {
  const homeDirectory = homedir();
  const invocationDirectory = resolveReadablePath(invocationCwd);
  const resolvedCwd = resolveReadablePath(cwd);

  return {
    redactCwd(path) {
      const relativeCwd = getRelativeDebugPath(
        resolvedCwd,
        invocationDirectory,
      );

      if (relativeCwd !== undefined) {
        return relativeCwd;
      }

      const homeRedactedCwd = replacePathPrefixCandidates(path, [
        { prefixCandidates: [homeDirectory], replacement: '~' },
      ]);

      if (homeRedactedCwd !== undefined) {
        return homeRedactedCwd;
      }

      if (isAbsolute(path)) {
        return `<cwd:${basename(path)}>`;
      }

      return path;
    },
    redactListValue(path) {
      const redactedValue = replacePathPrefixCandidates(path, [
        { prefixCandidates: [cwd, resolvedCwd], replacement: '<cwd>' },
        { prefixCandidates: [homeDirectory], replacement: '~' },
      ]);

      if (redactedValue !== undefined) {
        return redactedValue;
      }

      return path;
    },
  };
}

function formatDebugCwd(cwd: CwdPath, redactor: DebugPathRedactor): string {
  return formatDisplayValue(redactor.redactCwd(cwd));
}

function formatDebugList(
  values: readonly string[],
  redactor?: DebugPathRedactor,
): string {
  if (values.length === 0) {
    return '(none)';
  }

  return values
    .map((value) => formatDebugListValue(value, redactor))
    .join(', ');
}

function formatDebugListValue(
  value: string,
  redactor: DebugPathRedactor | undefined,
): string {
  if (redactor === undefined) {
    return formatDisplayValue(value);
  }

  return formatDisplayValue(redactor.redactListValue(value));
}

function getRelativeDebugPath(
  value: string,
  baseDirectory: string,
): string | undefined {
  const relativePath = relative(baseDirectory, value);

  if (relativePath === '') {
    return '.';
  }

  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return undefined;
  }

  return `./${normalizeToPosixPath(relativePath)}`;
}

function formatDiscoveryResultCount(count: number | undefined): string {
  if (count === undefined) {
    return 'failed before file count';
  }

  if (count === 1) {
    return '1 file';
  }

  return `${String(count)} files`;
}

function formatMissingFileStrictFailure(
  results: readonly MapEntry[],
  tag: OverviewTag | undefined,
  showAllMissingPaths: boolean,
): string | undefined {
  return formatMissingStrictFailure({
    entries: results,
    formatPath: formatMissingFileStrictPath,
    formatPrefix(count, noun): string {
      return formatMissingFileStrictPrefix(count, noun, tag);
    },
    pluralNoun: 'files',
    recovery: formatMissingFileStrictRecovery(tag),
    showAllMissingPaths,
    singularNoun: 'file',
  });
}

function formatDefaultOverviewTagLabel(): string {
  const firstTags = DEFAULT_OVERVIEW_TAGS.slice(0, -1).join(', ');
  const finalTag = DEFAULT_OVERVIEW_TAGS.at(-1);

  if (finalTag === undefined) {
    throw new Error(
      'Invalid default overview tags "[]" — expected at least one tag.',
    );
  }

  if (firstTags === '') {
    return finalTag;
  }

  return `${firstTags}, or ${finalTag}`;
}

function formatMissingDirectoryStrictFailure(
  results: readonly MapEntry[],
  showAllMissingPaths: boolean,
): string | undefined {
  return formatMissingStrictFailure({
    entries: results,
    formatPath: formatMissingDirectoryStrictPath,
    formatPrefix(count, noun): string {
      return `filemap: ${String(count)} collapsed ${noun} missing .overview sidecar:`;
    },
    pluralNoun: 'directories',
    recovery: STRICT_DIRECTORY_RECOVERY,
    showAllMissingPaths,
    singularNoun: 'directory',
  });
}

function formatMissingStrictFailure(
  options: MissingStrictFailureOptions,
): string | undefined {
  const missingPaths: string[] = [];

  for (const result of options.entries) {
    const missingPath = options.formatPath(result);

    if (missingPath !== undefined) {
      missingPaths.push(missingPath);
    }
  }

  if (missingPaths.length === 0) {
    return undefined;
  }

  const noun =
    missingPaths.length === 1 ? options.singularNoun : options.pluralNoun;
  const formattedMissingPaths = formatStrictMissingPathList(
    missingPaths,
    options.showAllMissingPaths,
  );

  return `${options.formatPrefix(missingPaths.length, noun)}\n${formattedMissingPaths}\n${options.recovery}`;
}

function formatMissingFileStrictPrefix(
  count: number,
  noun: string,
  tag: OverviewTag | undefined,
): string {
  if (tag !== undefined) {
    return `filemap: ${String(count)} ${noun} missing ${tag}:`;
  }

  return `filemap: ${String(count)} ${noun} missing an overview tag (${DEFAULT_OVERVIEW_TAG_LABEL}):`;
}

function formatMissingFileStrictRecovery(tag: OverviewTag | undefined): string {
  if (tag !== undefined) {
    return `Add ${tag} to each file, or run without --strict.`;
  }

  return 'Add an overview tag to each file, or run without --strict.';
}

function formatMissingFileStrictPath(result: MapEntry): string | undefined {
  switch (result.kind) {
    case 'directory':
      return undefined;

    case 'file':
      if (result.description !== undefined) {
        return undefined;
      }

      return `- ${formatDisplayValue(result.path)}`;

    default:
      return assertNever(result, 'map entry', 'directory or file');
  }
}

function formatMissingDirectoryStrictPath(
  result: MapEntry,
): string | undefined {
  switch (result.kind) {
    case 'directory':
      if (result.description !== undefined) {
        return undefined;
      }

      return `- ${formatDisplayValue(result.path)}/`;

    case 'file':
      return undefined;

    default:
      return assertNever(result, 'map entry', 'directory or file');
  }
}

function formatStrictMissingPathList(
  missingPaths: readonly string[],
  showAllMissingPaths: boolean,
): string {
  if (
    showAllMissingPaths ||
    missingPaths.length <= STRICT_MISSING_PATH_DISPLAY_LIMIT
  ) {
    return missingPaths.join('\n');
  }

  const shownPaths = missingPaths.slice(0, STRICT_MISSING_PATH_DISPLAY_LIMIT);
  const hiddenPathCount =
    missingPaths.length - STRICT_MISSING_PATH_DISPLAY_LIMIT;

  return [
    ...shownPaths,
    `${String(hiddenPathCount)} more missing paths not shown. Run with --debug to show all missing paths.`,
  ].join('\n');
}

/**
 * Writes one stderr line with the newline already attached.
 *
 * @param output - Stderr writer owned by the CLI boundary.
 * @param message - Text to write before the newline.
 */
export function writeErrorLine(output: CliReportOutput, message: string): void {
  output.writeStderr(`${message}\n`);
}
