#!/usr/bin/env node

/** @fileoverview Measures built filemap CLI performance on large repos. */

import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const CHILD_MODE_FLAG = '--run-case';
const FILEMAP_PERF_LARGE_REPO_ENV = 'FILEMAP_PERF_LARGE_REPO';
const GENERATED_SOURCE_FILE_COUNT = 4_000;
const GENERATED_TEST_FILE_COUNT = 1_500;
const FILES_PER_DIRECTORY = 100;
const WRITE_BATCH_SIZE = 100;
const PERF_RESULT_STRING_KEYS = Object.freeze(['target', 'label', 'stderr']);
const PERF_RESULT_STRING_ARRAY_KEYS = Object.freeze(['args']);
const PERF_RESULT_NUMBER_KEYS = Object.freeze([
  'discoveredCount',
  'discoveryMs',
  'elapsedMs',
  'exitCode',
  'mapBuildMs',
  'maxRssKb',
  'outputRows',
]);

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const builtCliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const builtCliModuleUrl = new URL('../dist/cli.js', import.meta.url).href;

if (process.argv[2] === CHILD_MODE_FLAG) {
  await runMeasuredCliCase();
} else {
  await runPerfSuite();
}

/**
 * Creates a large temp repo, runs the perf cases, and prints a metrics table.
 *
 * @returns {Promise<void>} Resolves after every case has printed metrics.
 */
async function runPerfSuite() {
  await assertBuiltCliExists();

  const fixtureRoot = await createGeneratedFixture();

  try {
    const scenarios = [
      ...buildScenarios('generated', fixtureRoot),
      ...(await buildOptionalLargeRepoScenarios()),
    ];
    const results = [];

    for (const scenario of scenarios) {
      results.push(await runScenario(scenario));
    }

    printReport(fixtureRoot, results);
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
}

/**
 * Runs one scenario inside a child process so max RSS belongs to one CLI run.
 *
 * @param {PerfScenario} scenario - Case to run.
 * @returns {Promise<PerfResult>} Metrics reported by the child process.
 */
async function runScenario(scenario) {
  const childResult = await runChildProcess([
    scriptPath,
    CHILD_MODE_FLAG,
    scenario.target,
    scenario.label,
    scenario.cwd,
    ...scenario.args,
  ]);

  if (childResult.exitCode !== 0) {
    throw new Error(
      `Failed to run perf case "${scenario.label}" on "${scenario.target}" — child exited with code ${String(childResult.exitCode)}. ${childResult.stderr}`,
    );
  }

  const result = parsePerfResult(childResult.stdout);

  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to run perf case "${scenario.label}" on "${scenario.target}" — filemap exited with code ${String(result.exitCode)}. ${result.stderr}`,
    );
  }

  return result;
}

/**
 * Runs a Node child process and captures its output.
 *
 * @param {readonly string[]} args - Arguments passed to the Node executable.
 * @returns {Promise<ChildProcessResult>} The process output and exit code.
 */
async function runChildProcess(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    /** @type {string[]} */
    const stdout = [];
    /** @type {string[]} */
    const stderr = [];

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      appendTextChunk(stdout, chunk, 'perf child stdout');
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      appendTextChunk(stderr, chunk, 'perf child stderr');
    });

    child.on('error', (error) => {
      rejectPromise(
        new Error('Failed to start perf child process — check Node.', {
          cause: error,
        }),
      );
    });

    child.on('close', (exitCode) => {
      resolvePromise({
        exitCode: exitCode ?? 1,
        stderr: stderr.join(''),
        stdout: stdout.join(''),
      });
    });
  });
}

/**
 * Runs one built CLI case and prints JSON metrics for the parent process.
 *
 * @returns {Promise<void>} Resolves after metrics are printed.
 */
async function runMeasuredCliCase() {
  const [target, label, cwd, ...args] = process.argv.slice(3);

  if (target === undefined || label === undefined || cwd === undefined) {
    throw new Error(
      'Invalid perf child args — expected target, label, cwd, then filemap args.',
    );
  }

  const runCli = await importBuiltRunCli();
  const stdoutCounter = createLineCounter();
  /** @type {string[]} */
  const stderrChunks = [];
  const startMs = performance.now();
  const exitCode = await runCli(
    ['node', builtCliPath, ...args],
    {
      writeStderr(message) {
        stderrChunks.push(message);
      },
      writeStdout(message) {
        stdoutCounter.addChunk(message);
      },
    },
    {
      invocationCwd: cwd,
    },
  );
  const elapsedMs = Math.round(performance.now() - startMs);
  const stderr = stderrChunks.join('');

  process.stdout.write(
    `${JSON.stringify({
      args,
      discoveredCount: parseNumberMetric(stderr, /^result: ([0-9]+) files$/m),
      discoveryMs: parseNumberMetric(stderr, /^ {2}discovery: ([0-9]+) ms$/m),
      elapsedMs,
      exitCode,
      label,
      mapBuildMs: parseNumberMetric(stderr, /^ {2}map build: ([0-9]+) ms$/m),
      maxRssKb: process.resourceUsage().maxRSS,
      outputRows: stdoutCounter.getLineCount(),
      stderr: firstLines(stderr, 4),
      target,
    })}\n`,
  );
}

/**
 * Builds the standard cases for one repo root.
 *
 * @param {string} target - Short label for the repo.
 * @param {string} cwd - Directory the CLI should scan.
 * @returns {readonly PerfScenario[]} The cases to run.
 */
function buildScenarios(target, cwd) {
  return [
    {
      args: ['--debug', '--max-files', '10000'],
      cwd,
      label: 'normal',
      target,
    },
    {
      args: ['--debug', '--strict', '--max-files', '10000'],
      cwd,
      label: 'strict',
      target,
    },
    {
      args: ['--debug', '--depth', '1', '--max-files', '10000'],
      cwd,
      label: 'depth collapse',
      target,
    },
    {
      args: ['--debug', '--include-groups', 'tests', '--max-files', '10000'],
      cwd,
      label: 'rescue tests',
      target,
    },
  ];
}

/**
 * Adds real large-repo cases when the env var points to one.
 *
 * @returns {Promise<readonly PerfScenario[]>} Real-repo cases, or none.
 */
async function buildOptionalLargeRepoScenarios() {
  const largeRepo = process.env[FILEMAP_PERF_LARGE_REPO_ENV];

  if (largeRepo === undefined || largeRepo.trim() === '') {
    return [];
  }

  await access(largeRepo);

  return buildScenarios('real repo', largeRepo);
}

/**
 * Creates a generated repo large enough to catch common scale regressions.
 *
 * @returns {Promise<string>} The temp repo path.
 */
async function createGeneratedFixture() {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'filemap-perf-large-'));
  const sourcePaths = createGeneratedPaths(
    GENERATED_SOURCE_FILE_COUNT,
    'src/module',
    'file',
    '.ts',
  );
  const testPaths = createGeneratedPaths(
    GENERATED_TEST_FILE_COUNT,
    'test/module',
    'file',
    '.test.ts',
  );

  await writeFile(join(fixtureRoot, '.gitignore'), 'node_modules/\ndist/\n');
  await writeGeneratedFiles(
    fixtureRoot,
    sourcePaths,
    (path) =>
      `/** @fileoverview Generated source file for large perf runs */\nexport const path = ${JSON.stringify(path)};\n`,
  );
  await writeGeneratedFiles(
    fixtureRoot,
    testPaths,
    (path) =>
      `/** @fileoverview Generated test file for rescue perf runs */\nexport const path = ${JSON.stringify(path)};\n`,
  );

  return fixtureRoot;
}

/**
 * Creates stable generated paths spread across subdirectories.
 *
 * @param {number} count - File count to create.
 * @param {string} directoryPrefix - Prefix before the numbered directory.
 * @param {string} filePrefix - Prefix before the numbered file.
 * @param {string} extension - File extension, including the dot.
 * @returns {readonly string[]} Repo-relative generated paths.
 */
function createGeneratedPaths(count, directoryPrefix, filePrefix, extension) {
  return Array.from({ length: count }, (_unused, index) => {
    const directoryIndex = Math.floor(index / FILES_PER_DIRECTORY);

    return `${directoryPrefix}-${String(directoryIndex).padStart(3, '0')}/${filePrefix}-${String(index).padStart(5, '0')}${extension}`;
  });
}

/**
 * Writes generated files in small batches so setup does not hide perf results.
 *
 * @param {string} root - Temp repo root.
 * @param {readonly string[]} paths - Repo-relative file paths.
 * @param {(path: string) => string} getContents - Builds file contents.
 * @returns {Promise<void>} Resolves after all files are written.
 */
async function writeGeneratedFiles(root, paths, getContents) {
  const directories = new Set(paths.map((path) => dirname(join(root, path))));

  for (const directory of directories) {
    await mkdir(directory, { recursive: true });
  }

  for (let start = 0; start < paths.length; start += WRITE_BATCH_SIZE) {
    const batch = paths.slice(start, start + WRITE_BATCH_SIZE);
    await Promise.all(
      batch.map((path) => {
        return writeFile(join(root, path), getContents(path));
      }),
    );
  }
}

/**
 * Parses one JSON metrics line from a child process.
 *
 * @param {string} stdout - Child stdout.
 * @returns {PerfResult} Parsed and checked metrics.
 */
function parsePerfResult(stdout) {
  /** @type {unknown} */
  const value = JSON.parse(stdout.trim());

  if (!isPerfResult(value)) {
    throw new Error(
      `Invalid perf child output "${firstLines(stdout, 3)}" — expected a metrics object.`,
    );
  }

  return value;
}

/**
 * Checks a child metrics object before the parent prints it.
 *
 * @param {unknown} value - Parsed JSON value.
 * @returns {value is PerfResult} True when the shape is usable.
 */
function isPerfResult(value) {
  return (
    isRecord(value) &&
    PERF_RESULT_STRING_KEYS.every((key) => hasStringProperty(value, key)) &&
    PERF_RESULT_STRING_ARRAY_KEYS.every((key) =>
      hasStringArrayProperty(value, key),
    ) &&
    PERF_RESULT_NUMBER_KEYS.every((key) => hasNumberProperty(value, key))
  );
}

/**
 * Checks whether an unknown object has a string property.
 *
 * @param {Readonly<Record<string, unknown>>} value - Object to inspect.
 * @param {string} key - Property name.
 * @returns {boolean} True when the property is a string.
 */
function hasStringProperty(value, key) {
  return key in value && typeof value[key] === 'string';
}

/**
 * Checks whether an unknown object has a string array property.
 *
 * @param {Readonly<Record<string, unknown>>} value - Object to inspect.
 * @param {string} key - Property name.
 * @returns {boolean} True when the property is an array of strings.
 */
function hasStringArrayProperty(value, key) {
  return (
    key in value &&
    Array.isArray(value[key]) &&
    value[key].every((item) => typeof item === 'string')
  );
}

/**
 * Checks whether an unknown object has a finite number property.
 *
 * @param {Readonly<Record<string, unknown>>} value - Object to inspect.
 * @param {string} key - Property name.
 * @returns {boolean} True when the property is a finite number.
 */
function hasNumberProperty(value, key) {
  return (
    key in value &&
    typeof value[key] === 'number' &&
    Number.isFinite(value[key])
  );
}

/**
 * Imports the built CLI and checks the public runner exists.
 *
 * @returns {Promise<RunCli>} The built CLI runner.
 */
async function importBuiltRunCli() {
  const moduleValue = await importBuiltCliModule();

  if (!isRecord(moduleValue) || !isRunCli(moduleValue['runCli'])) {
    throw new Error(
      'Invalid dist/cli.js — expected it to export a runCli function.',
    );
  }

  return moduleValue['runCli'];
}

/**
 * Imports the built CLI module as unchecked runtime data.
 *
 * @returns {Promise<unknown>} The imported module namespace.
 */
async function importBuiltCliModule() {
  return import(builtCliModuleUrl);
}

/**
 * Adds a stream chunk after checking it is text.
 *
 * @param {string[]} chunks - Collected chunks.
 * @param {unknown} chunk - Stream data chunk.
 * @param {string} streamName - Name used in error messages.
 */
function appendTextChunk(chunks, chunk, streamName) {
  if (typeof chunk !== 'string') {
    throw new Error(
      `Invalid ${streamName} chunk "${String(chunk)}" — expected text.`,
    );
  }

  chunks.push(chunk);
}

/**
 * Checks whether a value can be read by string keys.
 *
 * @param {unknown} value - Value to inspect.
 * @returns {value is Readonly<Record<string, unknown>>} True when it is a plain object.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks whether a value can run the built CLI.
 *
 * @param {unknown} value - Value to inspect.
 * @returns {value is RunCli} True when it is a function.
 */
function isRunCli(value) {
  return typeof value === 'function';
}

/**
 * Extracts a numeric metric from debug stderr.
 *
 * @param {string} text - Debug stderr.
 * @param {RegExp} pattern - Pattern with one numeric capture group.
 * @returns {number} The parsed metric, or 0 when missing.
 */
function parseNumberMetric(text, pattern) {
  const match = pattern.exec(text);

  if (match === null) {
    return 0;
  }

  const rawValue = match[1];

  if (rawValue === undefined) {
    return 0;
  }

  return Number.parseInt(rawValue, 10);
}

/**
 * Tracks stdout rows without storing the full file map.
 *
 * @returns {{ addChunk: (chunk: string) => void, getLineCount: () => number }} A line counter.
 */
function createLineCounter() {
  let lineCount = 0;
  let pending = '';

  return {
    addChunk(chunk) {
      pending += chunk;
      const parts = pending.split('\n');
      lineCount += parts.length - 1;
      pending = parts[parts.length - 1] ?? '';
    },
    getLineCount() {
      return pending.length === 0 ? lineCount : lineCount + 1;
    },
  };
}

/**
 * Prints a compact metrics report.
 *
 * @param {string} fixtureRoot - Generated fixture path.
 * @param {readonly PerfResult[]} results - Metrics to print.
 * @returns {void}
 */
function printReport(fixtureRoot, results) {
  process.stdout.write('filemap large performance\n');
  process.stdout.write(
    `generated fixture: ${fixtureRoot} (${String(GENERATED_SOURCE_FILE_COUNT)} source files, ${String(GENERATED_TEST_FILE_COUNT)} test files)\n`,
  );
  process.stdout.write(
    `${FILEMAP_PERF_LARGE_REPO_ENV}: ${process.env[FILEMAP_PERF_LARGE_REPO_ENV] ?? '(not set)'}\n\n`,
  );
  process.stdout.write(
    '| target | case | args | elapsed | max RSS | discovered | rows | discovery | map build |\n',
  );
  process.stdout.write(
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |\n',
  );

  for (const result of results) {
    process.stdout.write(
      `| ${result.target} | ${result.label} | ${formatArgs(result.args)} | ${String(result.elapsedMs)} ms | ${formatMebibytes(result.maxRssKb)} | ${String(result.discoveredCount)} | ${String(result.outputRows)} | ${String(result.discoveryMs)} ms | ${String(result.mapBuildMs)} ms |\n`,
    );
  }
}

/**
 * Formats CLI args for one table cell.
 *
 * @param {readonly string[]} args - CLI args.
 * @returns {string} A readable arg list.
 */
function formatArgs(args) {
  return args.length === 0 ? '(none)' : args.join(' ');
}

/**
 * Formats max RSS from Node's kilobyte counter.
 *
 * @param {number} kilobytes - Max resident set size in kilobytes.
 * @returns {string} A mebibyte label.
 */
function formatMebibytes(kilobytes) {
  return `${(kilobytes / 1024).toFixed(1)} MiB`;
}

/**
 * Returns the first few lines of text for diagnostics.
 *
 * @param {string} text - Text to trim.
 * @param {number} limit - Maximum line count.
 * @returns {string} Trimmed text.
 */
function firstLines(text, limit) {
  return text.split('\n').slice(0, limit).join('\n').trim();
}

/**
 * Fails early when the built CLI has not been produced yet.
 *
 * @returns {Promise<void>} Resolves when dist/cli.js exists.
 */
async function assertBuiltCliExists() {
  try {
    await access(builtCliPath);
  } catch (error) {
    throw new Error('Missing dist/cli.js — run npm run build first.', {
      cause: error,
    });
  }
}

/**
 * @typedef {{
 *   readonly args: readonly string[];
 *   readonly cwd: string;
 *   readonly label: string;
 *   readonly target: string;
 * }} PerfScenario
 */

/**
 * @typedef {{
 *   readonly exitCode: number;
 *   readonly stderr: string;
 *   readonly stdout: string;
 * }} ChildProcessResult
 */

/**
 * @typedef {{
 *   readonly args: readonly string[];
 *   readonly discoveredCount: number;
 *   readonly discoveryMs: number;
 *   readonly elapsedMs: number;
 *   readonly exitCode: number;
 *   readonly label: string;
 *   readonly mapBuildMs: number;
 *   readonly maxRssKb: number;
 *   readonly outputRows: number;
 *   readonly stderr: string;
 *   readonly target: string;
 * }} PerfResult
 */

/**
 * @typedef {(argv: readonly string[], output: { readonly writeStderr: (message: string) => void; readonly writeStdout: (message: string) => void }, runtime: { readonly invocationCwd: string }) => Promise<number>} RunCli
 */
