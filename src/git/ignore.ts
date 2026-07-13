/** @fileoverview Finds paths hidden by Git ignore rules */

import {
  type ChildProcessByStdio,
  type ChildProcessWithoutNullStreams,
  spawn,
} from 'node:child_process';
import { once } from 'node:events';
import { type Readable, type Writable } from 'node:stream';

import {
  createGitCheckIgnoreOutputParser,
  type GitCheckIgnoreOutputParser,
} from '@/git/ignore-output-parser.js';
import {
  createLimitedTextCollector,
  type LimitedTextCollector,
} from '@/git/limited-text-collector.js';
import {
  type CwdPath,
  type RepoPath,
  toDiscoveredRepoPath,
} from '@/paths/brands.js';
import { createNonErrorThrownValueError } from '@/shared/error-format.js';
import {
  formatDisplayValue,
  parseDecimalIntegerText,
  validateIntegerInRange,
} from '@/shared/validation.js';

const DEFAULT_GIT_CHECK_IGNORE_TIMEOUT_MS = 5_000;
const GIT_CHECK_IGNORE_KILL_GRACE_MS = 1_000;
const GIT_NOT_A_REPOSITORY_EXIT_CODE = 128;
const GIT_CHECK_IGNORE_STDERR_LIMIT_CHARS = 8_192;
const GIT_CHECK_IGNORE_STDIN_CHUNK_CHARS = 16_384;
const GIT_CHECK_IGNORE_TIMEOUT_ENV = 'FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS';
const MAX_GIT_CHECK_IGNORE_TIMEOUT_MS = 60_000;
const MIN_GIT_CHECK_IGNORE_TIMEOUT_MS = 1;

type GitIgnoredPathsResult =
  | {
      readonly ignoredPaths: ReadonlySet<RepoPath>;
      readonly status: 'answered';
    }
  | {
      readonly status: 'notGitRepository';
    };

type GitVisibleFilesResult =
  | {
      readonly filePaths: readonly RepoPath[];
      readonly status: 'answered';
    }
  | {
      readonly status: 'notGitRepository';
    };

interface GitListFilesOutputParser {
  readonly addChunk: (chunk: string) => void;
  readonly finish: () => readonly RepoPath[];
}

type GitListFilesTag = '?' | 'H' | 'M' | 'R' | 'S';

type GitCheckIgnoreChildProcess = ChildProcessWithoutNullStreams;
type GitCommandChildProcess = ChildProcessByStdio<null, Readable, Readable>;
type GitProcessName = 'git check-ignore' | 'git ls-files';

interface GitProcessChild {
  readonly kill: (signal?: NodeJS.Signals | number) => boolean;
}

interface GitCommandOutputParser<TOutput> {
  readonly addChunk: (chunk: string) => void;
  readonly finish: () => TOutput;
}

interface GitProcessSettlement<TResult> {
  readonly isSettled: () => boolean;
  readonly reject: (reason: unknown) => void;
  readonly resolve: (result: TResult) => void;
  readonly setCleanup: (cleanup: () => void) => void;
}

interface GitProcessTimeoutState {
  readonly clear: () => void;
  readonly didTimeOut: () => boolean;
}

interface GitCheckIgnoreProcessState {
  readonly child: GitCheckIgnoreChildProcess;
  readonly getStdinError: () => Promise<unknown>;
  readonly outputParser: GitCheckIgnoreOutputParser;
  readonly setStdinStreamError: (reason: unknown) => void;
  readonly settlement: GitProcessSettlement<GitIgnoredPathsResult>;
  readonly stderrCollector: LimitedTextCollector;
  readonly workingDirectory: CwdPath;
}

interface StartGitCheckIgnoreProcessOptions {
  readonly filePaths: readonly RepoPath[];
  readonly rejectPromise: (reason: unknown) => void;
  readonly resolvePromise: (result: GitIgnoredPathsResult) => void;
  readonly workingDirectory: CwdPath;
}

interface StartGitProcessTimeoutOptions<TResult> {
  readonly child: GitProcessChild;
  readonly processName: GitProcessName;
  readonly settlement: GitProcessSettlement<TResult>;
  readonly timeoutMs: number;
  readonly workingDirectory: CwdPath;
}

interface WireGitCheckIgnoreStreamsOptions {
  readonly state: GitCheckIgnoreProcessState;
  readonly timeoutMs: number;
  readonly timeoutState: GitProcessTimeoutState;
}

interface RunGitCommandOptions<TOutput, TResult> {
  readonly acceptedExitCodes: readonly number[];
  readonly args: readonly string[];
  readonly getAcceptedResult: (output: TOutput) => TResult;
  readonly getNotGitRepositoryResult?: () => TResult;
  readonly outputParser: GitCommandOutputParser<TOutput>;
  readonly processName: GitProcessName;
  readonly stdin: 'ignore';
  readonly timeoutMs: number;
  readonly toOutputError: (error: unknown, workingDirectory: CwdPath) => Error;
  readonly workingDirectory: CwdPath;
}

interface WireGitCommandStreamsOptions<TOutput, TResult> {
  readonly child: GitCommandChildProcess;
  readonly options: RunGitCommandOptions<TOutput, TResult>;
  readonly settlement: GitProcessSettlement<TResult>;
  readonly stderrCollector: LimitedTextCollector;
  readonly timeoutMs: number;
  readonly timeoutState: GitProcessTimeoutState;
}

interface HandleGitCommandCloseOptions<TOutput, TResult> {
  readonly exitCode: null | number;
  readonly options: RunGitCommandOptions<TOutput, TResult>;
  readonly settlement: GitProcessSettlement<TResult>;
  readonly stderrCollector: LimitedTextCollector;
  readonly timeoutMs: number;
  readonly timeoutState: GitProcessTimeoutState;
}

interface GitCommandCloseResultOptions<TOutput, TResult> {
  readonly exitCode: null | number;
  readonly isStderrTruncated: boolean;
  readonly options: RunGitCommandOptions<TOutput, TResult>;
  readonly stderr: string;
}

interface GitCheckIgnoreCloseResultOptions {
  readonly child: GitProcessChild;
  readonly exitCode: null | number;
  readonly isStderrTruncated: boolean;
  readonly outputParser: GitCheckIgnoreOutputParser;
  readonly stderr: string;
  readonly stdinError: unknown;
  readonly workingDirectory: CwdPath;
}

/**
 * Formats the public rule for Git ignore timeout values.
 *
 * @returns The accepted timeout format and range.
 */
function formatGitCheckIgnoreTimeoutExpectation(): string {
  return `a decimal integer from ${formatGitCheckIgnoreTimeoutRangeLabel()} milliseconds`;
}

/**
 * Formats the next action shown when Git ignore checks time out.
 *
 * @returns A short recovery hint for timeout errors.
 */
function formatGitCheckIgnoreTimeoutRecoveryHint(): string {
  return `Set ${GIT_CHECK_IGNORE_TIMEOUT_ENV} up to ${String(MAX_GIT_CHECK_IGNORE_TIMEOUT_MS)}, or run filemap on a narrower scope.`;
}

/**
 * Runs `git check-ignore` and returns the repo paths Git hides.
 *
 * @param filePaths - Repo-relative paths to check against Git ignore rules.
 * @param workingDirectory - Directory where the Git command should run.
 * @returns Git's ignored paths, or a not-repo result when Git cannot check them.
 */
export async function findGitIgnoredPaths(
  filePaths: readonly RepoPath[],
  workingDirectory: CwdPath,
): Promise<GitIgnoredPathsResult> {
  return runGitCheckIgnoreProcess(
    filePaths,
    workingDirectory,
    getGitCheckIgnoreTimeoutMs(),
  );
}

/**
 * Runs `git ls-files` and returns files Git considers visible.
 *
 * @param workingDirectory - Directory where the Git command should run.
 * @returns Git-visible repo paths, or a not-repo result when Git cannot list them.
 */
export async function findGitVisibleFiles(
  workingDirectory: CwdPath,
): Promise<GitVisibleFilesResult> {
  return runGitListFilesProcess(workingDirectory, getGitCheckIgnoreTimeoutMs());
}

async function runGitCheckIgnoreProcess(
  filePaths: readonly RepoPath[],
  workingDirectory: CwdPath,
  timeoutMs: number,
): Promise<GitIgnoredPathsResult> {
  return new Promise<GitIgnoredPathsResult>((resolvePromise, rejectPromise) => {
    const state = startGitCheckIgnoreProcess({
      filePaths,
      rejectPromise,
      resolvePromise,
      workingDirectory,
    });
    const timeoutState = startGitProcessTimeout({
      child: state.child,
      processName: 'git check-ignore',
      settlement: state.settlement,
      timeoutMs,
      workingDirectory,
    });

    state.settlement.setCleanup(timeoutState.clear);
    wireGitCheckIgnoreStreams({ state, timeoutMs, timeoutState });
  });
}

function startGitCheckIgnoreProcess(
  options: StartGitCheckIgnoreProcessOptions,
): GitCheckIgnoreProcessState {
  const { filePaths, rejectPromise, resolvePromise, workingDirectory } =
    options;
  let stdinStreamError: unknown;
  const child: GitCheckIgnoreChildProcess = spawn(
    'git',
    ['-C', workingDirectory, 'check-ignore', '-z', '--stdin'],
    {
      stdio: 'pipe',
    },
  );
  const outputParser = createGitCheckIgnoreOutputParser(
    workingDirectory,
    filePaths,
  );
  const settlement = createGitProcessSettlement(resolvePromise, rejectPromise);
  const stderrCollector = createLimitedTextCollector(
    GIT_CHECK_IGNORE_STDERR_LIMIT_CHARS,
  );
  const stdinEndResult = writeGitCheckIgnoreInput(child.stdin, filePaths).then(
    () => undefined,
    (error: unknown) => {
      return createNonErrorThrownValueError(
        error,
        `Failed to send paths to git check-ignore in cwd "${formatDisplayValue(workingDirectory)}" — stdin failed`,
      );
    },
  );

  async function getStdinError(): Promise<unknown> {
    if (stdinStreamError !== undefined) {
      return stdinStreamError;
    }

    return stdinEndResult;
  }

  return {
    child,
    getStdinError,
    outputParser,
    setStdinStreamError(reason: unknown): void {
      stdinStreamError = reason;
    },
    settlement,
    stderrCollector,
    workingDirectory,
  };
}

function wireGitCheckIgnoreStreams(
  options: WireGitCheckIgnoreStreamsOptions,
): void {
  const { state, timeoutMs, timeoutState } = options;
  const { child, outputParser, settlement, stderrCollector, workingDirectory } =
    state;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    try {
      outputParser.addChunk(chunk);
    } catch (error) {
      child.kill();
      settlement.reject(toGitCheckIgnoreError(error, workingDirectory));
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrCollector.addChunk(chunk);
  });

  child.stdin.on('error', (reason: unknown) => {
    state.setStdinStreamError(reason);
  });

  child.on('error', (error: NodeJS.ErrnoException) => {
    settlement.reject(
      new Error(
        `Failed to run git check-ignore in cwd "${formatDisplayValue(workingDirectory)}" — check that Git is installed and try again.`,
        { cause: error },
      ),
    );
  });

  child.on('close', (exitCode) => {
    handleGitCheckIgnoreClose({
      exitCode,
      state,
      timeoutMs,
      timeoutState,
    });
  });
}

function handleGitCheckIgnoreClose(options: {
  readonly exitCode: null | number;
  readonly state: GitCheckIgnoreProcessState;
  readonly timeoutMs: number;
  readonly timeoutState: GitProcessTimeoutState;
}): void {
  const { exitCode, state, timeoutMs, timeoutState } = options;
  const {
    child,
    getStdinError,
    outputParser,
    settlement,
    stderrCollector,
    workingDirectory,
  } = state;

  if (timeoutState.didTimeOut()) {
    settlement.reject(
      new Error(
        `Timed out running git check-ignore in cwd "${formatDisplayValue(workingDirectory)}" after ${String(timeoutMs)} ms — Git was killed. ${formatGitCheckIgnoreTimeoutRecoveryHint()}`,
      ),
    );
    return;
  }

  void getStdinError()
    .then((stdinError) => {
      settlement.resolve(
        getGitCheckIgnoreCloseResult({
          child,
          exitCode,
          isStderrTruncated: stderrCollector.isTruncated(),
          outputParser,
          stderr: stderrCollector.getText(),
          stdinError,
          workingDirectory,
        }),
      );
    })
    .catch((error: unknown) => {
      if (error instanceof Error) {
        settlement.reject(error);
        return;
      }

      settlement.reject(toGitCheckIgnoreError(error, workingDirectory));
    });
}

async function runGitListFilesProcess(
  workingDirectory: CwdPath,
  timeoutMs: number,
): Promise<GitVisibleFilesResult> {
  return runGitCommand({
    acceptedExitCodes: [0],
    args: [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--deleted',
      '-t',
      '-z',
    ],
    getAcceptedResult(filePaths): GitVisibleFilesResult {
      return {
        filePaths,
        status: 'answered',
      };
    },
    getNotGitRepositoryResult(): GitVisibleFilesResult {
      return {
        status: 'notGitRepository',
      };
    },
    outputParser: createGitListFilesOutputParser(),
    processName: 'git ls-files',
    stdin: 'ignore',
    timeoutMs,
    toOutputError: toGitListFilesError,
    workingDirectory,
  });
}

function runGitCommand<TOutput, TResult>(
  options: RunGitCommandOptions<TOutput, TResult>,
): Promise<TResult> {
  return new Promise<TResult>((resolvePromise, rejectPromise) => {
    const child: GitCommandChildProcess = spawn(
      'git',
      ['-C', options.workingDirectory, ...options.args],
      {
        stdio: [options.stdin, 'pipe', 'pipe'],
      },
    );
    const settlement = createGitProcessSettlement(
      resolvePromise,
      rejectPromise,
    );
    const stderrCollector = createLimitedTextCollector(
      GIT_CHECK_IGNORE_STDERR_LIMIT_CHARS,
    );
    const timeoutState = startGitProcessTimeout({
      child,
      processName: options.processName,
      settlement,
      timeoutMs: options.timeoutMs,
      workingDirectory: options.workingDirectory,
    });

    settlement.setCleanup(timeoutState.clear);
    wireGitCommandStreams({
      child,
      options,
      settlement,
      stderrCollector,
      timeoutMs: options.timeoutMs,
      timeoutState,
    });
  });
}

function wireGitCommandStreams<TOutput, TResult>(
  streamOptions: WireGitCommandStreamsOptions<TOutput, TResult>,
): void {
  const {
    child,
    options,
    settlement,
    stderrCollector,
    timeoutMs,
    timeoutState,
  } = streamOptions;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    try {
      options.outputParser.addChunk(chunk);
    } catch (error) {
      child.kill();
      settlement.reject(options.toOutputError(error, options.workingDirectory));
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrCollector.addChunk(chunk);
  });

  child.on('error', (error: NodeJS.ErrnoException) => {
    settlement.reject(
      new Error(
        `Failed to run ${options.processName} in cwd "${formatDisplayValue(options.workingDirectory)}" — check that Git is installed and try again.`,
        { cause: error },
      ),
    );
  });

  child.on('close', (exitCode) => {
    handleGitCommandClose({
      exitCode,
      options,
      settlement,
      stderrCollector,
      timeoutMs,
      timeoutState,
    });
  });
}

function handleGitCommandClose<TOutput, TResult>(
  closeOptions: HandleGitCommandCloseOptions<TOutput, TResult>,
): void {
  const { exitCode, options, settlement, stderrCollector, timeoutMs } =
    closeOptions;

  if (closeOptions.timeoutState.didTimeOut()) {
    settlement.reject(
      new Error(
        `Timed out running ${options.processName} in cwd "${formatDisplayValue(options.workingDirectory)}" after ${String(timeoutMs)} ms — Git was killed. ${formatGitCheckIgnoreTimeoutRecoveryHint()}`,
      ),
    );
    return;
  }

  try {
    settlement.resolve(
      getGitCommandCloseResult({
        exitCode,
        isStderrTruncated: stderrCollector.isTruncated(),
        options,
        stderr: stderrCollector.getText(),
      }),
    );
  } catch (error) {
    settlement.reject(createNonErrorThrownValueError(error));
  }
}

function createGitProcessSettlement<TResult>(
  resolvePromise: (result: TResult) => void,
  rejectPromise: (reason: unknown) => void,
): GitProcessSettlement<TResult> {
  let cleanup = (): void => {};
  let isSettled = false;

  function settle(settlePromise: () => void): void {
    if (isSettled) {
      return;
    }

    isSettled = true;
    cleanup();
    settlePromise();
  }

  return {
    isSettled: (): boolean => isSettled,
    reject: (reason: unknown): void => {
      settle(() => {
        rejectPromise(reason);
      });
    },
    resolve: (result: TResult): void => {
      settle(() => {
        resolvePromise(result);
      });
    },
    setCleanup: (nextCleanup: () => void): void => {
      cleanup = nextCleanup;
    },
  };
}

function startGitProcessTimeout<TResult>(
  options: StartGitProcessTimeoutOptions<TResult>,
): GitProcessTimeoutState {
  const { child, processName, settlement, timeoutMs, workingDirectory } =
    options;
  let didTimeOut = false;
  let killGraceTimeout: ReturnType<typeof setTimeout> | undefined;

  const timeout = setTimeout(() => {
    if (settlement.isSettled()) {
      return;
    }

    didTimeOut = true;
    child.kill();
    killGraceTimeout = setTimeout(() => {
      if (settlement.isSettled()) {
        return;
      }

      child.kill('SIGKILL');
      settlement.reject(
        new Error(
          `Timed out running ${processName} in cwd "${formatDisplayValue(workingDirectory)}" after ${String(timeoutMs)} ms — Git was killed but did not close within ${String(GIT_CHECK_IGNORE_KILL_GRACE_MS)} ms. ${formatGitCheckIgnoreTimeoutRecoveryHint()}`,
        ),
      );
    }, GIT_CHECK_IGNORE_KILL_GRACE_MS);
  }, timeoutMs);

  return {
    clear: (): void => {
      clearTimeout(timeout);

      if (killGraceTimeout !== undefined) {
        clearTimeout(killGraceTimeout);
      }
    },
    didTimeOut: (): boolean => didTimeOut,
  };
}

function getGitCheckIgnoreCloseResult(
  options: GitCheckIgnoreCloseResultOptions,
): GitIgnoredPathsResult {
  const {
    child,
    exitCode,
    isStderrTruncated,
    outputParser,
    stderr,
    stdinError,
    workingDirectory,
  } = options;

  if (
    exitCode === GIT_NOT_A_REPOSITORY_EXIT_CODE &&
    stderr.includes('not a git repository')
  ) {
    return {
      status: 'notGitRepository',
    };
  }

  if (stdinError !== undefined) {
    throw new Error(
      `Failed to send paths to git check-ignore in cwd "${formatDisplayValue(workingDirectory)}" — Git closed stdin before reading all paths.`,
      { cause: stdinError },
    );
  }

  if (exitCode === 0 || exitCode === 1) {
    let ignoredPaths: ReadonlySet<RepoPath>;

    try {
      ignoredPaths = outputParser.finish();
    } catch (error) {
      child.kill();
      throw toGitCheckIgnoreError(error, workingDirectory);
    }

    return {
      ignoredPaths,
      status: 'answered',
    };
  }

  throw new Error(
    `Failed to run git check-ignore in cwd "${formatDisplayValue(workingDirectory)}" — Git exited with code ${String(exitCode)}: ${formatGitCheckIgnoreStderr(stderr, isStderrTruncated)}`,
  );
}

function getGitCommandCloseResult<TOutput, TResult>(
  closeOptions: GitCommandCloseResultOptions<TOutput, TResult>,
): TResult {
  const { exitCode, isStderrTruncated, options, stderr } = closeOptions;

  if (
    exitCode === GIT_NOT_A_REPOSITORY_EXIT_CODE &&
    stderr.includes('not a git repository') &&
    options.getNotGitRepositoryResult !== undefined
  ) {
    return options.getNotGitRepositoryResult();
  }

  if (exitCode !== null && options.acceptedExitCodes.includes(exitCode)) {
    try {
      return options.getAcceptedResult(options.outputParser.finish());
    } catch (error) {
      throw options.toOutputError(error, options.workingDirectory);
    }
  }

  throw new Error(
    `Failed to run ${options.processName} in cwd "${formatDisplayValue(options.workingDirectory)}" — Git exited with code ${String(exitCode)}: ${formatGitCheckIgnoreStderr(stderr, isStderrTruncated)}`,
  );
}

function createGitListFilesOutputParser(): GitListFilesOutputParser {
  const filePaths = new Set<RepoPath>();
  const deletedFilePaths = new Set<RepoPath>();
  let pendingOutput = '';

  function addTaggedPath(taggedPath: string): void {
    if (taggedPath === '') {
      return;
    }

    const tag = parseGitListFilesTag(taggedPath);
    const filePath = toDiscoveredRepoPath(taggedPath.slice(2), 'Git path');

    if (tag === 'R') {
      deletedFilePaths.add(filePath);
      return;
    }

    filePaths.add(filePath);
  }

  return {
    addChunk(chunk: string): void {
      const output = `${pendingOutput}${chunk}`;
      const parts = output.split('\0');
      pendingOutput = parts.pop() ?? '';

      for (const part of parts) {
        addTaggedPath(part);
      }
    },
    finish(): readonly RepoPath[] {
      if (pendingOutput !== '') {
        throw new Error(
          `Git returned incomplete path "${formatDisplayValue(pendingOutput)}", expected null-separated paths ending with NUL.`,
        );
      }

      return [...filePaths].filter(
        (filePath) => !deletedFilePaths.has(filePath),
      );
    },
  };
}

function parseGitListFilesTag(taggedPath: string): GitListFilesTag {
  if (taggedPath.length < 3 || taggedPath[1] !== ' ') {
    throw new Error(
      `Git returned malformed tagged path "${formatDisplayValue(taggedPath)}", expected a status letter, a space, and a repo path.`,
    );
  }

  const tag = taggedPath.charAt(0);

  if (tag === '?' || tag === 'H' || tag === 'M' || tag === 'R' || tag === 'S') {
    return tag;
  }

  throw new Error(
    `Git returned unknown file status "${formatDisplayValue(tag)}" for path "${formatDisplayValue(taggedPath.slice(2))}", expected one of "?", "H", "M", "R", or "S".`,
  );
}

function getGitCheckIgnoreTimeoutMs(): number {
  const rawTimeout = process.env[GIT_CHECK_IGNORE_TIMEOUT_ENV];

  if (rawTimeout === undefined) {
    return DEFAULT_GIT_CHECK_IGNORE_TIMEOUT_MS;
  }

  const timeoutExpectation = formatGitCheckIgnoreTimeoutExpectation();
  const timeout = parseDecimalIntegerText(
    rawTimeout,
    GIT_CHECK_IGNORE_TIMEOUT_ENV,
    timeoutExpectation,
  );

  return validateIntegerInRange(
    timeout,
    GIT_CHECK_IGNORE_TIMEOUT_ENV,
    timeoutExpectation,
    MIN_GIT_CHECK_IGNORE_TIMEOUT_MS,
    MAX_GIT_CHECK_IGNORE_TIMEOUT_MS,
  );
}

async function writeGitCheckIgnoreInput(
  stdin: Writable,
  filePaths: readonly RepoPath[],
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const settlement = createGitProcessSettlement<void>(
      resolvePromise,
      rejectPromise,
    );

    function handleError(reason: unknown): void {
      settlement.reject(reason);
    }

    function handleEnd(): void {
      settlement.resolve(undefined);
    }

    async function writePaths(): Promise<void> {
      try {
        for (const chunk of createGitCheckIgnoreInputChunks(filePaths)) {
          if (!stdin.write(chunk)) {
            await once(stdin, 'drain');
          }
        }

        stdin.end(handleEnd);
      } catch (error) {
        settlement.reject(error);
      }
    }

    settlement.setCleanup(() => {
      stdin.off('error', handleError);
    });
    stdin.once('error', handleError);
    void writePaths();
  });
}

function* createGitCheckIgnoreInputChunks(
  filePaths: readonly RepoPath[],
): Iterable<string> {
  let chunk = '';

  for (const filePath of filePaths) {
    const pathInput = `${filePath}\0`;

    if (
      chunk !== '' &&
      chunk.length + pathInput.length > GIT_CHECK_IGNORE_STDIN_CHUNK_CHARS
    ) {
      yield chunk;
      chunk = '';
    }

    if (pathInput.length > GIT_CHECK_IGNORE_STDIN_CHUNK_CHARS) {
      yield pathInput;
      continue;
    }

    chunk = `${chunk}${pathInput}`;
  }

  if (chunk !== '') {
    yield chunk;
  }
}

function formatGitCheckIgnoreStderr(
  stderr: string,
  isStderrTruncated: boolean,
): string {
  const trimmedStderr = stderr.trim();
  let diagnostic = formatDisplayValue(trimmedStderr);

  if (diagnostic === '') {
    diagnostic = '(no stderr)';
  }

  if (isStderrTruncated) {
    return `${diagnostic} (stderr was truncated after ${String(GIT_CHECK_IGNORE_STDERR_LIMIT_CHARS)} characters.)`;
  }

  return diagnostic;
}

function formatGitCheckIgnoreTimeoutRangeLabel(): string {
  return `${String(MIN_GIT_CHECK_IGNORE_TIMEOUT_MS)} to ${String(MAX_GIT_CHECK_IGNORE_TIMEOUT_MS)}`;
}

function toGitCheckIgnoreError(
  error: unknown,
  workingDirectory: CwdPath,
): Error {
  return new Error(
    `Failed to read git check-ignore output in cwd "${formatDisplayValue(workingDirectory)}" — expected Git stdout to contain only checked repo paths.`,
    { cause: error },
  );
}

function toGitListFilesError(error: unknown, workingDirectory: CwdPath): Error {
  let detail: string;

  if (error instanceof Error) {
    detail = formatDisplayValue(error.message);
  } else {
    detail = formatDisplayValue(String(error));
  }

  return new Error(
    `Failed to read git ls-files output in cwd "${formatDisplayValue(workingDirectory)}" — ${detail}`,
    { cause: error },
  );
}
