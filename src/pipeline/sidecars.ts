/** @fileoverview Reads collapsed-directory sidecar files without following unsafe paths */

import { realpath } from 'node:fs/promises';

import {
  type CwdPath,
  type RepoPath,
  type ResolvedPath,
  resolvePathFromCwd,
  toResolvedPath,
} from '@/paths/brands.js';
import { isRealPathInsideDirectory } from '@/paths/platform.js';
import { normalizeDescriptionText } from '@/pipeline/comment-collectors.js';
import { formatInvalidValueMessage } from '@/shared/error-format.js';
import {
  hasNodeErrorCode,
  readOptionalBoundedUtf8FileSafely,
} from '@/shared/file-io.js';
import { formatDisplayValue } from '@/shared/validation.js';

const DIRECTORY_SIDECAR_READ_LIMIT_BYTES = 64 * 1024;

class InvalidSidecarError extends Error {}

class SidecarReadError extends Error {}

interface AssertSidecarPathIsSafeOptions {
  readonly directoryPath: RepoPath;
  readonly sidecarDisplayPath: string;
  readonly sidecarRealPath: ResolvedPath;
  readonly workingDirectory: CwdPath;
  readonly workingDirectoryRealPath: CwdPath;
}

/**
 * Reads the optional `.overview` file for a collapsed directory.
 *
 * @param workingDirectory - Checked working directory.
 * @param workingDirectoryRealPath - Real path for the checked working directory.
 * @param directoryPath - Collapsed directory path relative to the repo.
 * @returns The sidecar description, or `undefined` when the sidecar is missing.
 */
export async function readDirectorySidecar(
  workingDirectory: CwdPath,
  workingDirectoryRealPath: CwdPath,
  directoryPath: RepoPath,
): Promise<string | undefined> {
  const sidecarPath = resolvePathFromCwd(
    workingDirectory,
    directoryPath,
    '.overview',
  );
  const sidecarDisplayPath = `${directoryPath}/.overview`;

  try {
    const sidecarContents = await readOptionalBoundedUtf8FileSafely({
      byteLimit: DIRECTORY_SIDECAR_READ_LIMIT_BYTES,
      createInvalidFileError(expectedDescription, options) {
        return createInvalidSidecarError(
          formatInvalidValueMessage(
            'sidecar',
            sidecarDisplayPath,
            expectedDescription,
          ),
          options,
        );
      },
      regularFileDescription: `a file inside collapsed directory "${formatDisplayValue(directoryPath)}"`,
      resolvedPath: sidecarPath,
      validateRealPath(sidecarRealPath) {
        return assertSidecarPathIsSafe({
          directoryPath,
          sidecarDisplayPath,
          sidecarRealPath: toResolvedPath(sidecarRealPath, 'sidecar'),
          workingDirectory,
          workingDirectoryRealPath,
        });
      },
    });

    if (sidecarContents === undefined) {
      return undefined;
    }

    return normalizeDescriptionText(sidecarContents);
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) {
      return undefined;
    }

    if (isInvalidSidecarError(error) || isSidecarReadError(error)) {
      throw error;
    }

    throw createSidecarReadError(sidecarPath, { cause: error });
  }
}

/**
 * Reads the message from an invalid sidecar error.
 *
 * @param error - Invalid sidecar error.
 * @returns The safe client-facing error message.
 */
export function getInvalidSidecarErrorMessage(error: Error): string {
  return error.message;
}

/**
 * Checks whether an error came from an invalid sidecar.
 *
 * @param error - Error value from a sidecar read.
 * @returns `true` when the sidecar reader created this invalid-sidecar error.
 */
export function isInvalidSidecarError(
  error: unknown,
): error is InvalidSidecarError {
  return error instanceof InvalidSidecarError;
}

/**
 * Checks whether an error came from a sidecar read failure.
 *
 * @param error - Error value from a sidecar read.
 * @returns `true` when the sidecar reader created this read error.
 */
export function isSidecarReadError(error: unknown): error is SidecarReadError {
  return error instanceof SidecarReadError;
}

async function assertSidecarPathIsSafe(
  options: AssertSidecarPathIsSafeOptions,
): Promise<void> {
  const {
    directoryPath,
    sidecarDisplayPath,
    sidecarRealPath,
    workingDirectory,
    workingDirectoryRealPath,
  } = options;

  const directoryRealPath = toResolvedPath(
    await realpath(resolvePathFromCwd(workingDirectory, directoryPath)),
    'directoryPath',
  );

  if (!isRealPathInsideDirectory(workingDirectoryRealPath, sidecarRealPath)) {
    throw createInvalidSidecarError(
      formatInvalidValueMessage(
        'sidecar',
        sidecarDisplayPath,
        `a file that resolves inside cwd "${formatDisplayValue(workingDirectory)}"`,
      ),
    );
  }

  if (!isRealPathInsideDirectory(directoryRealPath, sidecarRealPath)) {
    throw createInvalidSidecarError(
      formatInvalidValueMessage(
        'sidecar',
        sidecarDisplayPath,
        `a file that resolves inside collapsed directory "${formatDisplayValue(directoryPath)}" and cwd "${formatDisplayValue(workingDirectory)}"`,
      ),
    );
  }
}

function formatSidecarReadFailureMessage(sidecarPath: ResolvedPath): string {
  return `Failed to read sidecar "${formatDisplayValue(sidecarPath)}" — check that the file is readable or remove the collapse directory.`;
}

function createInvalidSidecarError(
  message: string,
  options?: ErrorOptions,
): InvalidSidecarError {
  return new InvalidSidecarError(message, options);
}

function createSidecarReadError(
  sidecarPath: ResolvedPath,
  options?: ErrorOptions,
): SidecarReadError {
  return new SidecarReadError(formatSidecarReadFailureMessage(sidecarPath), {
    cause: options?.cause,
  });
}
