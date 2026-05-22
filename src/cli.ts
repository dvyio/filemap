#!/usr/bin/env node

/** @fileoverview Runs the CLI and prints read-only file maps to stdout */

import { Command, CommanderError } from 'commander';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
  type DiscoveryDebugSummary,
  getStrictValidationFailures,
  reportDiscoveryDebugSummary,
  reportStrictFailures,
  writeErrorLine,
} from '@/cli/cli-reporting.js';
import { buildExtendedHelpText } from '@/cli/help-text.js';
import {
  addSharedOptions,
  buildDiscoverOptions,
  buildMapInputOptions,
  readSharedOptions,
  type SharedCliOptions,
  toDiscoveryOptionInput,
} from '@/cli/options.js';
import { createUserFacingPathRedactor } from '@/cli/path-redaction.js';
import { discoverFiles, type DiscoverFilesOptions } from '@/discovery/index.js';
import { type CwdPath } from '@/paths/brands.js';
import {
  buildMapFromDiscoveredFiles,
  type MapEntry,
} from '@/pipeline/index.js';
import { renderFileMapChunks } from '@/pipeline/render.js';
import {
  assertWorkingDirectory,
  resolveWorkingDirectory,
} from '@/shared/defaults.js';
import {
  createNonErrorThrownValueError,
  formatErrorChain,
  formatInvalidValueMessage,
} from '@/shared/error-format.js';
import { hasNodeErrorCode } from '@/shared/file-io.js';
import {
  formatDisplayValue,
  validateNonEmptyString,
  validateNonEmptyStringArray,
  validateOptionsObject,
} from '@/shared/validation.js';

declare const FILEMAP_PACKAGE_VERSION: string;

const CLI_PACKAGE_VERSION =
  typeof FILEMAP_PACKAGE_VERSION === 'string'
    ? FILEMAP_PACKAGE_VERSION
    : '0.0.0';

interface CliOutput {
  readonly writeStderr: (message: string) => void;
  readonly writeStdout: (message: string) => void;
}

interface CliRuntime {
  readonly invocationCwd: CwdPath;
}

interface CliProgram {
  readonly getExitCode: () => number;
  readonly program: Command;
}

/* v8 ignore next 16 */
const PROCESS_OUTPUT: CliOutput = {
  writeStderr(message) {
    try {
      process.stderr.write(message);
    } catch (error) {
      handleCliProcessOutputError(error, 'stderr');
    }
  },
  writeStdout(message) {
    try {
      process.stdout.write(message);
    } catch (error) {
      handleCliProcessOutputError(error, 'stdout');
    }
  },
};

/* v8 ignore next 4 */
if (isCliEntryPoint(import.meta.url, process.argv[1])) {
  installProcessOutputErrorHandlers();
  process.exitCode = await runCli();
}

/**
 * Handles process stdout and stderr errors from the real CLI entrypoint.
 *
 * @param error - Stream error emitted by Node.
 * @param streamName - Output stream that failed.
 */
export function handleCliProcessOutputError(
  error: unknown,
  streamName: 'stderr' | 'stdout',
): void {
  if (streamName === 'stdout' && hasNodeErrorCode(error, 'EPIPE')) {
    process.exitCode = 0;
    return;
  }

  if (error instanceof Error) {
    throw error;
  }

  throw createNonErrorThrownValueError(
    error,
    `Failed to write ${streamName} — output stream failed`,
  );
}

/**
 * Runs the CLI and returns the exit code without forcing process exit.
 *
 * @param argv - Node-style argv, including the executable and script path.
 * @param output - Output functions used for stdout and stderr.
 * @param runtime - Runtime values that default to the current process.
 * @returns The exit code the CLI should report.
 */
export async function runCli(
  argv: unknown = process.argv,
  output: unknown = PROCESS_OUTPUT,
  runtime: unknown = { invocationCwd: process.cwd() },
): Promise<number> {
  const checkedRuntime = validateCliRuntime(runtime);
  const checkedOutput = validateCliOutput(output);
  const checkedArgv = validateCliArgv(argv);
  const pathRedactor = createUserFacingPathRedactor(
    checkedRuntime.invocationCwd,
  );
  let debugSummaryOnError: DiscoveryDebugSummary | undefined;

  try {
    const cliProgram = createProgram(
      checkedOutput,
      checkedRuntime,
      (summary) => {
        debugSummaryOnError = summary;
      },
    );

    await cliProgram.program.parseAsync(checkedArgv, { from: 'node' });

    return cliProgram.getExitCode();
  } catch (error) {
    if (!(error instanceof Error)) {
      writeErrorLine(
        checkedOutput,
        pathRedactor.redactText(
          formatErrorChain(createNonErrorThrownValueError(error)),
        ),
      );
      return 1;
    }

    if (error instanceof CommanderError) {
      if (
        error.code === 'commander.helpDisplayed' ||
        error.code === 'commander.version'
      ) {
        return 0;
      }

      if (error.message !== '') {
        writeErrorLine(
          checkedOutput,
          pathRedactor.redactText(formatCommanderMessage(error.message)),
        );
      }

      return error.exitCode;
    }

    writeErrorLine(
      checkedOutput,
      pathRedactor.redactText(formatErrorChain(error)),
    );
    reportDiscoveryDebugSummary(
      debugSummaryOnError,
      checkedOutput,
      checkedRuntime.invocationCwd,
    );
    return 1;
  }
}

function validateCliArgv(argv: unknown): readonly string[] {
  return validateNonEmptyStringArray(
    argv,
    'argv',
    'an array of strings',
    (index) => `argv[${String(index)}]`,
    'a non-empty string',
  );
}

function validateCliOutput(output: unknown): CliOutput {
  const checkedOutput = validateOptionsObject(output, 'output');

  return {
    writeStderr: validateCliOutputWriter(
      checkedOutput['writeStderr'],
      'output.writeStderr',
    ),
    writeStdout: validateCliOutputWriter(
      checkedOutput['writeStdout'],
      'output.writeStdout',
    ),
  };
}

function validateCliOutputWriter(
  writer: unknown,
  fieldName: string,
): (message: string) => void {
  if (!isCliOutputWriter(writer)) {
    throw new Error(formatInvalidValueMessage(fieldName, writer, 'a function'));
  }

  return writer;
}

function isCliOutputWriter(
  writer: unknown,
): writer is (message: string) => void {
  return typeof writer === 'function';
}

function validateCliRuntime(runtime: unknown): CliRuntime {
  const checkedRuntime = validateOptionsObject(runtime, 'runtime');
  const invocationCwd = validateNonEmptyString(
    checkedRuntime['invocationCwd'],
    'runtime.invocationCwd',
    'a non-empty string path',
  );

  return {
    invocationCwd: resolveWorkingDirectory(undefined, invocationCwd),
  };
}

function formatCommanderMessage(message: string): string {
  return message.split('\n').map(formatDisplayValue).join('\n');
}

function createProgram(
  output: CliOutput,
  runtime: CliRuntime,
  rememberDebugSummaryOnError: (summary: DiscoveryDebugSummary) => void,
): CliProgram {
  let exitCode = 0;
  const program = new Command();

  addSharedOptions(
    program
      .name('filemap')
      .description(
        'Read overview tags from source files and print a file map to stdout.',
      )
      .version(CLI_PACKAGE_VERSION)
      .exitOverride()
      .argument(
        '[scope]',
        'restrict output to a directory subtree or single file',
      )
      .configureOutput({
        writeErr: () => {},
        writeOut(message) {
          output.writeStdout(message);
        },
      })
      .addHelpText('after', buildExtendedHelpText())
      .action(async (scope: string | undefined) => {
        const options = readSharedOptions(program, scope);

        exitCode = await runDefaultAction(
          options,
          output,
          runtime,
          rememberDebugSummaryOnError,
        );
      }),
  );

  return {
    getExitCode() {
      return exitCode;
    },
    program,
  };
}

async function runDefaultAction(
  options: SharedCliOptions,
  output: CliOutput,
  runtime: CliRuntime,
  rememberDebugSummaryOnError: (summary: DiscoveryDebugSummary) => void,
): Promise<number> {
  const cwd = resolveWorkingDirectory(undefined, runtime.invocationCwd);
  await assertWorkingDirectory(cwd);
  const discoverOptions = buildDiscoverOptions(
    toDiscoveryOptionInput(options),
    cwd,
  );
  let result: BuildEntriesResult;

  try {
    result = await buildEntries(options, cwd, discoverOptions);
  } catch (error) {
    if (options.debug) {
      rememberDebugSummaryOnError({
        cwd,
        discoverOptions,
        resultCount: undefined,
        timings: undefined,
      });
    }

    if (error instanceof Error) {
      throw error;
    }

    throw createNonErrorThrownValueError(error);
  }
  const scopedResults = stripScopePrefix(result.entries, options.scope);
  const strictFailures = getStrictValidationFailures(
    scopedResults,
    options.tag,
    options.strict,
    options.debug,
  );

  if (strictFailures.length > 0) {
    reportStrictFailures(strictFailures, output);
    reportDiscoveryDebugSummary(
      createDiscoveryDebugSummary(options.debug, cwd, discoverOptions, result),
      output,
      runtime.invocationCwd,
    );
    return 1;
  }

  reportDiscoveryDebugSummary(
    createDiscoveryDebugSummary(options.debug, cwd, discoverOptions, result),
    output,
    runtime.invocationCwd,
  );

  for (const chunk of renderFileMapChunks(scopedResults)) {
    output.writeStdout(chunk);
  }

  return 0;
}

async function buildEntries(
  options: SharedCliOptions,
  cwd: CwdPath,
  discoverOptions: DiscoverFilesOptions,
): Promise<BuildEntriesResult> {
  const discoveryStartMs = performance.now();
  const files = await discoverFiles(discoverOptions);
  const discoveryMs = getElapsedMilliseconds(discoveryStartMs);
  const mapBuildStartMs = performance.now();
  const entries = await buildMapFromDiscoveredFiles(
    files,
    buildMapInputOptions(options, cwd),
  );

  return {
    discoveredFileCount: files.length,
    discoveryMs,
    entries,
    mapBuildMs: getElapsedMilliseconds(mapBuildStartMs),
  };
}

interface BuildEntriesResult {
  readonly discoveredFileCount: number;
  readonly discoveryMs: number;
  readonly entries: readonly MapEntry[];
  readonly mapBuildMs: number;
}

function getElapsedMilliseconds(startMs: number): number {
  return Math.max(0, Math.round(performance.now() - startMs));
}

function createDiscoveryDebugSummary(
  isDebug: boolean,
  cwd: CwdPath,
  discoverOptions: DiscoverFilesOptions,
  result: BuildEntriesResult,
): DiscoveryDebugSummary | undefined {
  if (!isDebug) {
    return undefined;
  }

  return {
    cwd,
    discoverOptions,
    resultCount: result.discoveredFileCount,
    timings: {
      discoveryMs: result.discoveryMs,
      mapBuildMs: result.mapBuildMs,
    },
  };
}

/**
 * Strips the scope directory prefix from map entry paths so rendered output
 * shows paths relative to the scope root rather than the repo root.
 *
 * @param entries - Map entries with repo-relative paths from the pipeline.
 * @param scope - The scope directory prefix to strip, or undefined for no stripping.
 * @returns New entries with scope-relative paths.
 */
function stripScopePrefix(
  entries: readonly MapEntry[],
  scope: string | undefined,
): MapEntry[] {
  if (scope === undefined || scope === '.') {
    return [...entries];
  }

  const prefix = `${scope}/`;

  return entries.map((entry) => {
    if (entry.kind === 'directory' && entry.path === scope) {
      return {
        ...entry,
        path: '.',
      };
    }

    if (!entry.path.startsWith(prefix)) {
      return entry;
    }

    return {
      ...entry,
      path: entry.path.slice(prefix.length),
    };
  });
}

/* v8 ignore next 12 */
function isCliEntryPoint(moduleUrl: string, entryPath: string | undefined) {
  if (entryPath === undefined) {
    return false;
  }

  try {
    return fileURLToPath(moduleUrl) === realpathSync(resolve(entryPath));
  } catch {
    return false;
  }
}

/* v8 ignore next 8 */
function installProcessOutputErrorHandlers(): void {
  process.stdout.on('error', (error: unknown) => {
    handleCliProcessOutputError(error, 'stdout');
  });
  process.stderr.on('error', (error: unknown) => {
    handleCliProcessOutputError(error, 'stderr');
  });
}
