/** @fileoverview Opens and closes files while preserving useful Node errors */

import type { Stats } from 'node:fs';

import { type FileHandle, open, realpath, stat } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { TextDecoder } from 'node:util';

import { createNonErrorThrownValueError } from '@/shared/error-format.js';
import { formatDisplayValue } from '@/shared/validation.js';

const CLOSE_FILE_HANDLE_ERROR_MESSAGE =
  'Failed to close file handle after read.';
const FILE_DESCRIPTOR_RETRY_DELAYS_MS = [10, 25, 50] as const;
const UTF8_TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });

interface ReadOptionalBoundedUtf8FileSafelyOptions {
  readonly byteLimit: number;
  readonly createInvalidFileError: (
    expectedDescription: string,
    options?: ErrorOptions,
  ) => Error;
  readonly regularFileDescription: string;
  readonly resolvedPath: string;
  readonly validateRealPath?: (realPath: string) => Promise<void>;
}

interface FileIdentityStats {
  readonly dev: bigint | number;
  readonly ino: bigint | number;
}

/**
 * Checks whether an unknown value is a Node error with the expected code.
 *
 * @param error - Value caught from a Node API.
 * @param code - Error code to match, such as `ENOENT`.
 * @returns `true` when the value is an error with that code.
 */
export function hasNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/**
 * Runs a filesystem probe and treats only a missing path as absent.
 *
 * @param readValue - Filesystem call such as `stat`, `lstat`, `realpath`, or `open`.
 * @returns The read value, or `undefined` when Node reports `ENOENT`.
 */
export async function readOptionalFileSystemValue<TResult>(
  readValue: () => Promise<TResult>,
): Promise<TResult | undefined> {
  try {
    return await readValue();
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) {
      return undefined;
    }

    throw error;
  }
}

/**
 * Runs an optional filesystem probe and adds readable-path recovery guidance.
 *
 * @param readValue - Filesystem call such as `stat`, `lstat`, or `realpath`.
 * @param action - Action shown in the failure message, such as `inspect`.
 * @param fieldName - Optional field name shown before the path.
 * @param displayPath - User-facing path value used in the error message.
 * @returns The read value, or `undefined` when Node reports `ENOENT`.
 */
export async function readOptionalFileSystemValueOrFail<TResult>(
  readValue: () => Promise<TResult>,
  action: 'inspect' | 'resolve real path for',
  fieldName: string | undefined,
  displayPath: string,
): Promise<TResult | undefined> {
  try {
    return await readOptionalFileSystemValue(readValue);
  } catch (error) {
    throw new Error(
      formatReadablePathFailureMessage(action, fieldName, displayPath),
      { cause: error },
    );
  }
}

/**
 * Checks whether two file stats point at the same opened file.
 *
 * @param checkedStats - Stats captured before the file was opened.
 * @param openedStats - Stats captured from the open file handle.
 * @returns `true` when both stat records identify the same file.
 */
export function hasSameFileIdentity(
  checkedStats: FileIdentityStats,
  openedStats: FileIdentityStats,
): boolean {
  return (
    checkedStats.dev === openedStats.dev && checkedStats.ino === openedStats.ino
  );
}

function formatReadablePathFailureMessage(
  action: 'inspect' | 'resolve real path for',
  fieldName: string | undefined,
  displayPath: string,
): string {
  const pathDescription =
    fieldName === undefined
      ? `"${formatDisplayValue(displayPath)}"`
      : `${fieldName} "${formatDisplayValue(displayPath)}"`;

  return `Failed to ${action} ${pathDescription} — check that the path is readable.`;
}

/**
 * Reads an optional small UTF-8 file without following unsafe path changes.
 *
 * @param options - File path, size limit, and caller-owned error wording.
 * @returns The decoded file contents, or `undefined` when the file is absent.
 */
export async function readOptionalBoundedUtf8FileSafely(
  options: ReadOptionalBoundedUtf8FileSafelyOptions,
): Promise<string | undefined> {
  const checkedStats = await readOptionalFileSystemValue(() =>
    stat(options.resolvedPath),
  );

  if (checkedStats === undefined) {
    return undefined;
  }

  assertBoundedUtf8FileStatsAreSafe(options, checkedStats);

  const realPath = await readOptionalFileSystemValue(() =>
    realpath(options.resolvedPath),
  );

  if (realPath === undefined) {
    return undefined;
  }

  await options.validateRealPath?.(realPath);

  const fileHandle = await readOptionalFileSystemValue(() =>
    openWithFileDescriptorRetry(options.resolvedPath),
  );

  if (fileHandle === undefined) {
    return undefined;
  }

  return readOpenFileHandle(fileHandle, async (openedFileHandle) => {
    const openedStats = await openedFileHandle.stat();

    assertBoundedUtf8FileStatsAreSafe(options, openedStats);

    if (!hasSameFileIdentity(checkedStats, openedStats)) {
      throw options.createInvalidFileError(
        'the same file before and after opening it',
      );
    }

    return readBoundedUtf8FileContents(openedFileHandle, options);
  });
}

/**
 * Opens a file for reading and retries when the OS is temporarily out of file handles.
 *
 * @param filePath - File path passed to Node's `open`.
 * @returns The opened file handle.
 */
export async function openWithFileDescriptorRetry(
  filePath: string,
): Promise<FileHandle> {
  for (const delayMs of FILE_DESCRIPTOR_RETRY_DELAYS_MS) {
    try {
      return await open(filePath, 'r');
    } catch (error) {
      if (!isFileDescriptorPressureError(error)) {
        throw createNonErrorThrownValueError(error, 'File open failed');
      }

      await setTimeout(delayMs);
    }
  }

  return openFileReadOnly(filePath);
}

/**
 * Opens a file, lets the caller read it, and always closes the handle.
 *
 * @param filePath - File path passed to Node's `open`.
 * @param readFileHandle - Reads from the opened file handle.
 * @returns The value returned by the read callback.
 */
export async function readFileWithHandle<TResult>(
  filePath: string,
  readFileHandle: (fileHandle: FileHandle) => Promise<TResult>,
): Promise<TResult> {
  const fileHandle = await openWithFileDescriptorRetry(filePath);

  return readOpenFileHandle(fileHandle, readFileHandle);
}

/**
 * Reads an opened file handle and always closes it before returning.
 *
 * @param fileHandle - Open file handle to read and close.
 * @param readFileHandle - Reads from the opened file handle.
 * @returns The value returned by the read callback.
 */
export async function readOpenFileHandle<
  TResult,
  TFileHandle extends Pick<FileHandle, 'close'>,
>(
  fileHandle: TFileHandle,
  readFileHandle: (fileHandle: TFileHandle) => Promise<TResult>,
): Promise<TResult> {
  let readResult: TResult;

  try {
    readResult = await readFileHandle(fileHandle);
  } catch (error) {
    await closeFileHandleAfterRead(fileHandle, error);

    throw createNonErrorThrownValueError(error, 'File read failed');
  }

  await closeFileHandleAfterRead(fileHandle, undefined);

  return readResult;
}

async function readBoundedUtf8FileContents(
  fileHandle: Pick<FileHandle, 'read'>,
  options: ReadOptionalBoundedUtf8FileSafelyOptions,
): Promise<string> {
  const buffer = Buffer.alloc(options.byteLimit + 1);
  let bytesRead = 0;

  while (bytesRead <= options.byteLimit) {
    const result = await fileHandle.read(
      buffer,
      bytesRead,
      buffer.length - bytesRead,
      bytesRead,
    );

    if (result.bytesRead === 0) {
      return decodeBoundedUtf8FileContents(
        buffer.subarray(0, bytesRead),
        options,
      );
    }

    bytesRead += result.bytesRead;
  }

  throwFileIsTooLarge(options);
}

function decodeBoundedUtf8FileContents(
  buffer: Buffer,
  options: ReadOptionalBoundedUtf8FileSafelyOptions,
): string {
  try {
    return UTF8_TEXT_DECODER.decode(buffer);
  } catch (error) {
    throw options.createInvalidFileError(
      'valid UTF-8 text; save the file as UTF-8 or remove invalid bytes',
      { cause: error },
    );
  }
}

function assertBoundedUtf8FileStatsAreSafe(
  options: ReadOptionalBoundedUtf8FileSafelyOptions,
  stats: Stats,
): void {
  if (!stats.isFile()) {
    throw options.createInvalidFileError(options.regularFileDescription);
  }

  if (stats.size > options.byteLimit) {
    throwFileIsTooLarge(options);
  }
}

function throwFileIsTooLarge(
  options: ReadOptionalBoundedUtf8FileSafelyOptions,
): never {
  throw options.createInvalidFileError(
    `a file no larger than ${String(options.byteLimit)} bytes`,
  );
}

/**
 * Closes a file handle and keeps the original read error as the main failure.
 *
 * @param fileHandle - Open file handle to close.
 * @param primaryError - Error caught while reading, or `undefined` when reading succeeded.
 */
async function closeFileHandleAfterRead(
  fileHandle: Pick<FileHandle, 'close'>,
  primaryError: unknown,
): Promise<void> {
  const closeError = await getCloseError(fileHandle);

  if (closeError === undefined) {
    return;
  }

  const closeFailure = new Error(CLOSE_FILE_HANDLE_ERROR_MESSAGE, {
    cause: closeError,
  });

  if (primaryError === undefined) {
    throw closeFailure;
  }

  const primaryFailure = createNonErrorThrownValueError(
    primaryError,
    'File read failed',
  );

  throw new AggregateError([closeFailure], primaryFailure.message, {
    cause: primaryFailure,
  });
}

async function openFileReadOnly(filePath: string): Promise<FileHandle> {
  try {
    return await open(filePath, 'r');
  } catch (error) {
    throw createNonErrorThrownValueError(error, 'File open failed');
  }
}

function isFileDescriptorPressureError(error: unknown): boolean {
  return hasNodeErrorCode(error, 'EMFILE') || hasNodeErrorCode(error, 'ENFILE');
}

async function getCloseError(
  fileHandle: Pick<FileHandle, 'close'>,
): Promise<unknown> {
  try {
    await fileHandle.close();
    return undefined;
  } catch (error) {
    return error;
  }
}
