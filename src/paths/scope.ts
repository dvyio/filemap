/** @fileoverview Checks scoped repo paths against the filesystem */

import { realpath, stat } from 'node:fs/promises';
import { posix } from 'node:path';

import {
  assertSafeUserPathString,
  type CwdPath,
  hasParentEscapingGlobPrefix,
  isRepoPathAtOrInside,
  normalizePathInsideCwdLexically,
  normalizeToPosixPath,
  type RepoPath,
  type ResolvedPath,
  resolvePathFromCwd,
  toRepoPath,
} from '@/paths/brands.js';
import {
  isRealPathInsideDirectory,
  isWindowsAbsolutePath,
} from '@/paths/platform.js';
import { formatInvalidValueMessage } from '@/shared/error-format.js';
import { readOptionalFileSystemValueOrFail } from '@/shared/file-io.js';
import {
  assertNever,
  formatDisplayValue,
  validateNonEmptyString,
} from '@/shared/validation.js';

declare const repoScopeBrand: unique symbol;

/** Repo-relative CLI scope, or `.` when the user names the repo root. */
export type RepoScope = { readonly [repoScopeBrand]: 'RepoScope' } & string;

/** Existing scope resolved to the whole repo, one directory, or one file. */
export type ExistingRepoScope =
  | {
      readonly kind: 'all';
    }
  | {
      readonly kind: 'directory';
      readonly path: RepoPath;
    }
  | {
      readonly kind: 'file';
      readonly path: RepoPath;
    };

/** Inputs used to prove a resolved path still points inside cwd after symlinks. */
export interface AssertRealPathInsideCwdOptions {
  /** Absolute working directory that bounds the check. */
  readonly cwd: CwdPath;
  /** Real path for cwd when the caller already resolved it. */
  readonly cwdRealPath?: CwdPath;
  /** File kind the path must have when it exists. */
  readonly expectedKind: 'directory' | 'file';
  /** Field name used in the error message. */
  readonly fieldName: string;
  /** User-facing path value used in the error message. */
  readonly originalPath: string;
  /** Absolute path to check. */
  readonly resolvedPath: ResolvedPath;
}

interface ResolveExistingScopePathOptions {
  readonly cwd: CwdPath;
  readonly cwdRealPath?: CwdPath;
  readonly scopeText: string;
}

interface ResolvedExistingScopePath {
  readonly kind: 'directory' | 'file';
  readonly path: RepoPath;
}

/**
 * Reads path stats, treating only missing paths as absent.
 *
 * @param filePath - Absolute path to inspect.
 * @param fieldName - Field name used in the error message.
 * @param originalPath - User-facing path value used in the error message.
 * @returns File stats, or `undefined` when the path does not exist.
 */
export async function readPathStatsIfExists(
  filePath: CwdPath | ResolvedPath,
  fieldName: string,
  originalPath: string,
): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  return readOptionalFileSystemValueOrFail(
    () => stat(filePath),
    'inspect',
    fieldName,
    originalPath,
  );
}

/**
 * Normalizes a CLI scope without touching the file system.
 *
 * @param scope - Optional scope from the CLI or shared code.
 * @returns A stable repo-relative scope, `.` for root, or `undefined`.
 */
export function normalizeRepoScope(scope: unknown): RepoScope | undefined {
  if (scope === undefined) {
    return undefined;
  }

  const scopeText = validateNonEmptyString(
    scope,
    'scope',
    'a non-empty string path',
  );
  const trimmedScope = scopeText.trim();

  assertSafeUserPathString(trimmedScope, 'scope');

  if (isExplicitRepoRootScope(trimmedScope)) {
    return '.' as RepoScope;
  }

  if (isAbsoluteScope(trimmedScope)) {
    throwInvalidRepoScope(scopeText);
  }

  const normalizedScope = posix.normalize(normalizeToPosixPath(trimmedScope));

  if (
    normalizedScope === '' ||
    normalizedScope === '.' ||
    normalizedScope.startsWith('/') ||
    hasParentEscapingGlobPrefix(normalizedScope)
  ) {
    throwInvalidRepoScope(scopeText);
  }

  return normalizedScope
    .replace(/\/+$/u, '')
    .replace(/^\.\//u, '') as RepoScope;
}

/**
 * Resolves a CLI or shared scope to an existing file or directory inside cwd.
 *
 * @param scope - Optional scope from the CLI or shared code.
 * @param cwd - Absolute working directory that bounds the scope.
 * @param cwdRealPath - Real path for cwd when the caller already has it.
 * @returns Scope kind plus a repo-relative path for file and directory scopes.
 */
export async function resolveExistingRepoScope(
  scope: unknown,
  cwd: CwdPath,
  cwdRealPath?: CwdPath,
): Promise<ExistingRepoScope> {
  if (scope === undefined) {
    return { kind: 'all' };
  }

  const scopeText = validateNonEmptyString(
    scope,
    'scope',
    'a non-empty string path',
  );
  const normalizedScope = normalizeRepoScope(scopeText);

  return resolveNormalizedExistingRepoScope(
    normalizedScope,
    scopeText,
    cwd,
    cwdRealPath,
  );
}

/**
 * Resolves a scope that was already checked by `normalizeRepoScope()`.
 *
 * @param scope - Checked repo scope from CLI parsing.
 * @param cwd - Absolute working directory that bounds the scope.
 * @param cwdRealPath - Real path for cwd when the caller already has it.
 * @returns Scope kind plus a repo-relative path for file and directory scopes.
 */
export async function resolveCheckedExistingRepoScope(
  scope: RepoScope | undefined,
  cwd: CwdPath,
  cwdRealPath?: CwdPath,
): Promise<ExistingRepoScope> {
  return resolveNormalizedExistingRepoScope(scope, scope, cwd, cwdRealPath);
}

async function resolveNormalizedExistingRepoScope(
  normalizedScope: RepoScope | undefined,
  scopeText: string | undefined,
  cwd: CwdPath,
  cwdRealPath: CwdPath | undefined,
): Promise<ExistingRepoScope> {
  if (normalizedScope === '.') {
    return { kind: 'all' };
  }

  if (normalizedScope === undefined || scopeText === undefined) {
    return { kind: 'all' };
  }

  const resolvedScopePath = await resolveExistingScopePath({
    cwd,
    ...(cwdRealPath !== undefined ? { cwdRealPath } : {}),
    scopeText,
  });

  if (resolvedScopePath.kind === 'file') {
    return {
      kind: 'file',
      path: resolvedScopePath.path,
    };
  }

  return {
    kind: 'directory',
    path: resolvedScopePath.path,
  };
}

/**
 * Checks whether a repo path belongs to a resolved scope.
 *
 * @param path - Repo-relative path to test.
 * @param scope - Resolved repo scope.
 * @returns `true` when the path is inside the scope.
 */
function isRepoPathInsideScope(
  path: RepoPath,
  scope: ExistingRepoScope,
): boolean {
  switch (scope.kind) {
    case 'all':
      return true;

    case 'directory':
      return isRepoPathAtOrInside(path, scope.path);

    case 'file':
      return path === scope.path;

    default:
      return assertNever(scope, 'repo scope', 'all, directory, or file');
  }
}

/**
 * Keeps only repo paths that belong to a resolved scope.
 *
 * @param paths - Repo-relative paths to filter.
 * @param scope - Resolved repo scope.
 * @returns Paths inside the scope.
 */
export function filterRepoPathsByScope(
  paths: readonly RepoPath[],
  scope: ExistingRepoScope,
): RepoPath[] {
  return paths.filter((path) => isRepoPathInsideScope(path, scope));
}

/**
 * Rejects a resolved path when symlinks point it outside cwd.
 *
 * @param options - Path, cwd, and error labels for the realpath check.
 * @returns A promise that resolves when the path stays inside cwd.
 */
export async function assertRealPathInsideCwd(
  options: AssertRealPathInsideCwdOptions,
): Promise<void> {
  const resolvedRealPath = await getRealPathIfExists(options.resolvedPath);

  if (resolvedRealPath === undefined) {
    return;
  }

  const cwdRealPath = options.cwdRealPath ?? (await realpath(options.cwd));

  if (!isRealPathInsideDirectory(cwdRealPath, resolvedRealPath)) {
    throw new Error(
      formatInvalidValueMessage(
        options.fieldName,
        options.originalPath,
        `a ${options.expectedKind} that resolves inside cwd "${formatDisplayValue(options.cwd)}"`,
      ),
    );
  }

  await assertExistingPathKind(options);
}

async function resolveExistingScopePath(
  options: ResolveExistingScopePathOptions,
): Promise<ResolvedExistingScopePath> {
  const { cwd, cwdRealPath, scopeText } = options;
  const relativeScopePath = toRepoPath(
    normalizePathInsideCwdLexically(scopeText, cwd, 'scope').replace(
      /\/+$/u,
      '',
    ),
    'scope',
  );
  const resolvedScopePath = resolvePathFromCwd(cwd, relativeScopePath);
  const scopeStats = await readPathStatsIfExists(
    resolvedScopePath,
    'scope',
    scopeText,
  );

  if (scopeStats === undefined) {
    throw new Error(
      formatInvalidValueMessage(
        'scope',
        scopeText,
        `an existing file or directory relative to cwd "${formatDisplayValue(cwd)}"`,
      ),
    );
  }

  /* v8 ignore next 5 */
  if (!scopeStats.isDirectory() && !scopeStats.isFile()) {
    throw new Error(
      formatInvalidValueMessage(
        'scope',
        scopeText,
        `an existing file or directory relative to cwd "${formatDisplayValue(cwd)}"`,
      ),
    );
  }

  await assertRealPathInsideCwd({
    cwd,
    ...(cwdRealPath !== undefined ? { cwdRealPath } : {}),
    expectedKind: scopeStats.isFile() ? 'file' : 'directory',
    fieldName: 'scope',
    originalPath: scopeText,
    resolvedPath: resolvedScopePath,
  });

  if (scopeStats.isFile()) {
    return {
      kind: 'file',
      path: relativeScopePath,
    };
  }

  return {
    kind: 'directory',
    path: relativeScopePath,
  };
}

async function getRealPathIfExists(
  filePath: ResolvedPath,
): Promise<string | undefined> {
  return readOptionalFileSystemValueOrFail(
    () => realpath(filePath),
    'resolve real path for',
    undefined,
    filePath,
  );
}

async function assertExistingPathKind(
  options: AssertRealPathInsideCwdOptions,
): Promise<void> {
  const pathStats = await readPathStatsIfExists(
    options.resolvedPath,
    options.fieldName,
    options.originalPath,
  );

  if (pathStats === undefined) {
    return;
  }

  if (options.expectedKind === 'directory' && pathStats.isDirectory()) {
    return;
  }

  if (options.expectedKind === 'file' && pathStats.isFile()) {
    return;
  }

  throw new Error(
    formatInvalidValueMessage(
      options.fieldName,
      options.originalPath,
      `an existing ${options.expectedKind}`,
    ),
  );
}

function isExplicitRepoRootScope(scope: string): boolean {
  const normalizedScope = normalizeToPosixPath(scope);

  return /^\.(?:\/\.)*\/?$/u.test(normalizedScope);
}

function isAbsoluteScope(scope: string): boolean {
  const normalizedScope = normalizeToPosixPath(scope);

  return normalizedScope.startsWith('/') || isWindowsAbsolutePath(scope);
}

function throwInvalidRepoScope(scope: string): never {
  throw new Error(
    formatInvalidValueMessage(
      'scope',
      scope,
      '"." for the repository root or a relative child path',
    ),
  );
}
