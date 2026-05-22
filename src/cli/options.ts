/** @fileoverview Parses shared CLI flags into checked internal options */

import { type Command, CommanderError, Option } from 'commander';

import type { DiscoverFilesOptions } from '@/discovery/index.js';
import type { CheckedBuildMapInputOptions } from '@/pipeline/index.js';

import { type CwdPath } from '@/paths/brands.js';
import { normalizeRepoScope, type RepoScope } from '@/paths/scope.js';
import { type Depth, validateDepth } from '@/pipeline/depth.js';
import { type OverviewTag, validateTag } from '@/pipeline/tag.js';
import { formatInvalidValueMessage } from '@/shared/error-format.js';
import {
  MAX_FILES,
  type MaxFiles,
  validateMaxFiles,
} from '@/shared/max-files.js';
import { parseDecimalIntegerText } from '@/shared/validation.js';

const SHARED_COMMAND_OPTION_NAMES = [
  'collapseDir',
  'debug',
  'defaultExcludes',
  'depth',
  'exclude',
  'excludeGroups',
  'ext',
  'include',
  'includeGroups',
  'maxFiles',
  'strict',
  'tag',
] as const satisfies readonly SharedCommandOptionName[];

interface SharedCliOptionValues {
  readonly collapseDir: readonly string[];
  readonly debug: boolean;
  readonly defaultExcludes: boolean;
  readonly depth: Depth;
  readonly exclude: readonly string[];
  readonly excludeGroups: readonly string[];
  readonly ext: readonly string[];
  readonly include: readonly string[];
  readonly includeGroups: readonly string[];
  readonly maxFiles: MaxFiles;
  readonly strict: boolean;
  readonly tag: string;
}

type SharedCommandOptionName = keyof SharedCliOptionValues;
type SharedCommandOptions = Partial<SharedCliOptionValues>;
type PickedCliOptions = {
  [TKey in SharedCommandOptionName]?: SharedCliOptionValues[TKey] | undefined;
};

/** Checked CLI options shared by discovery, map building, and strict mode. */
export type SharedCliOptions = Readonly<
  {
    collapseDirs: PickedCliOptions['collapseDir'];
    debug: boolean;
    noDefaultExcludes: boolean;
    scope: RepoScope | undefined;
    strict: boolean;
    tag: OverviewTag | undefined;
  } & Omit<
    PickedCliOptions,
    'collapseDir' | 'debug' | 'defaultExcludes' | 'strict' | 'tag'
  >
>;

type DiscoveryCliOptionInput = Pick<
  DiscoverFilesOptions,
  | 'exclude'
  | 'excludeGroups'
  | 'ext'
  | 'include'
  | 'includeGroups'
  | 'maxFiles'
  | 'noDefaultExcludes'
  | 'scope'
>;

type BuildMapCliOptionInput = Pick<
  SharedCliOptions,
  'collapseDirs' | 'depth' | 'maxFiles' | 'scope' | 'tag'
>;

const DISCOVERY_OPTION_KEYS = [
  'exclude',
  'excludeGroups',
  'ext',
  'include',
  'includeGroups',
  'maxFiles',
  'noDefaultExcludes',
  'scope',
] as const satisfies readonly (keyof DiscoveryCliOptionInput)[];

const BUILD_MAP_OPTION_KEYS = [
  'collapseDirs',
  'depth',
  'maxFiles',
  'scope',
  'tag',
] as const satisfies readonly (keyof BuildMapCliOptionInput)[];

/**
 * Adds all public flags that are shared by the CLI action.
 *
 * @param command - Commander command being built.
 * @returns The same command with filemap flags attached.
 */
export function addSharedOptions(command: Command): Command {
  return command
    .addOption(
      new Option(
        '--ext <extension>',
        'file extension to discover (repeat to replace defaults with multiple extensions)',
      ).argParser(collectPattern),
    )
    .addOption(
      new Option(
        '--include <pattern>',
        'glob pattern to rescue from soft excludes',
      ).argParser(collectPattern),
    )
    .addOption(
      new Option(
        '--include-groups <group>',
        'group name to rescue from soft excludes',
      ).argParser(collectPattern),
    )
    .addOption(
      new Option(
        '--exclude <pattern>',
        'glob pattern to add to soft excludes',
      ).argParser(collectPattern),
    )
    .addOption(
      new Option(
        '--exclude-groups <group>',
        'group name to add to soft excludes',
      ).argParser(collectPattern),
    )
    .addOption(
      new Option(
        '--collapse-dir <dir>',
        'collapse a directory into a single summary line',
      ).argParser(collectPattern),
    )
    .addOption(
      new Option(
        '--depth <n>',
        'auto-collapse directories deeper than N levels',
      ).argParser(parseDepth),
    )
    .addOption(
      new Option(
        '--max-files <n>',
        'maximum discovered or visible files before failing',
      ).argParser(parseMaxFiles),
    )
    .option(
      '--debug',
      'write a discovery summary to stderr without changing stdout',
    )
    .option('--tag <name>', 'custom tag to extract instead of the defaults')
    .option(
      '--strict',
      'exit non-zero if any visible file or collapsed directory lacks documentation',
    )
    .option(
      '--no-default-excludes',
      'skip the default-on soft excludes (tests, fixtures, generated files, and more)',
    );
}

/**
 * Reads only CLI-supplied options from Commander and normalizes them.
 *
 * @param command - Parsed Commander command.
 * @param scope - Optional scope argument from the CLI.
 * @returns Checked option values for the run flow.
 */
export function readSharedOptions(
  command: Command,
  scope: string | undefined,
): SharedCliOptions {
  const options = pickCliOptions(command, command.opts<SharedCommandOptions>());

  return {
    collapseDirs: options.collapseDir,
    debug: options.debug === true,
    depth: options.depth,
    exclude: options.exclude,
    excludeGroups: options.excludeGroups,
    ext: options.ext,
    include: options.include,
    includeGroups: options.includeGroups,
    maxFiles: options.maxFiles,
    noDefaultExcludes: options.defaultExcludes === false,
    scope: normalizeRepoScope(scope),
    strict: options.strict === true,
    tag: options.tag === undefined ? undefined : validateTag(options.tag),
  };
}

/**
 * Picks the shared CLI fields owned by discovery.
 *
 * @param options - Checked shared CLI options.
 * @returns Only the fields that `discoverFiles()` should receive.
 */
export function toDiscoveryOptionInput(
  options: SharedCliOptions,
): DiscoveryCliOptionInput {
  const normalizedOptions = {
    ...options,
    noDefaultExcludes: options.noDefaultExcludes ? true : undefined,
  };

  return pickDefined(normalizedOptions, DISCOVERY_OPTION_KEYS);
}

/**
 * Builds discovery options from checked CLI options.
 *
 * @param input - Discovery fields supplied by CLI options.
 * @param cwd - Checked working directory used for discovery.
 * @returns Options ready for `discoverFiles()`.
 */
export function buildDiscoverOptions(
  input: DiscoveryCliOptionInput,
  cwd: CwdPath,
): DiscoverFilesOptions {
  return {
    ...pickDefined(input, DISCOVERY_OPTION_KEYS),
    cwd,
  };
}

/**
 * Builds map options from the shared CLI fields owned by map building.
 *
 * @param input - Checked shared CLI options for map building.
 * @param cwd - Checked working directory used for map building.
 * @returns Options ready for `buildMapFromDiscoveredFiles()`.
 */
export function buildMapInputOptions(
  input: BuildMapCliOptionInput,
  cwd: CwdPath,
): CheckedBuildMapInputOptions {
  return {
    ...pickDefined(input, BUILD_MAP_OPTION_KEYS),
    cwd,
  };
}

function pickDefined<TInput extends object, TKey extends keyof TInput>(
  input: TInput,
  keys: readonly TKey[],
): Partial<Pick<TInput, TKey>> {
  const output: Partial<Pick<TInput, TKey>> = {};

  for (const key of keys) {
    const value = input[key];

    if (value !== undefined) {
      output[key] = value;
    }
  }

  return output;
}

function collectPattern(
  value: string,
  previous: readonly string[] = [],
): string[] {
  return [...previous, value.trim()];
}

function parseDepth(value: string): Depth {
  try {
    const depth = parseDecimalIntegerText(
      value,
      'depth',
      'a non-negative decimal integer',
    );
    return validateDepth(depth);
  } catch (error) {
    const commanderError = new CommanderError(
      1,
      'commander.invalidArgument',
      formatInvalidValueMessage(
        'depth',
        value,
        'a non-negative decimal integer',
      ),
    );
    commanderError.cause = error;
    throw commanderError;
  }
}

function parseMaxFiles(value: string): MaxFiles {
  try {
    const maxFiles = parseDecimalIntegerText(
      value,
      'maxFiles',
      `a positive decimal integer up to ${String(MAX_FILES)}`,
    );
    return validateMaxFiles(maxFiles);
  } catch (error) {
    const commanderError = new CommanderError(
      1,
      'commander.invalidArgument',
      formatInvalidValueMessage(
        'max-files',
        value,
        `a positive decimal integer up to ${String(MAX_FILES)}`,
      ),
    );
    commanderError.cause = error;
    throw commanderError;
  }
}

function isCliSource(command: Command, optionName: string): boolean {
  return command.getOptionValueSource(optionName) === 'cli';
}

function pickCliOptions(
  command: Command,
  options: SharedCommandOptions,
): PickedCliOptions {
  const pickedOptions: PickedCliOptions = {};

  for (const optionName of SHARED_COMMAND_OPTION_NAMES) {
    setPickedCliOption(pickedOptions, command, options, optionName);
  }

  return pickedOptions;
}

function setPickedCliOption<TKey extends SharedCommandOptionName>(
  pickedOptions: PickedCliOptions,
  command: Command,
  options: SharedCommandOptions,
  optionName: TKey,
): void {
  pickedOptions[optionName] = pickCliOption(
    command,
    optionName,
    options[optionName],
  );
}

function pickCliOption<TKey extends SharedCommandOptionName>(
  command: Command,
  optionName: TKey,
  value: SharedCommandOptions[TKey],
): PickedCliOptions[TKey] {
  if (!isCliSource(command, optionName)) {
    return undefined;
  }

  return value;
}
