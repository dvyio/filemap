import type { FileHandle } from 'node:fs/promises';

import { describe, expect, test, vi } from 'vitest';

import { getThrownError, withMockedFsPromises } from '../helpers.js';

type FileDescriptorRetryModule = typeof import('@/shared/file-io.js');
type OpenReplacement = (filePath: string, flags: string) => Promise<unknown>;
type SetTimeoutReplacement = (delayMs: number) => Promise<void>;

class MockNodeError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super(`Mock ${code}`);
    this.code = code;
  }
}

async function withMockedOpen(
  openMock: OpenReplacement,
  setTimeoutMock: SetTimeoutReplacement,
  run: (fileIoModule: FileDescriptorRetryModule) => Promise<void>,
): Promise<void> {
  vi.doMock('node:timers/promises', () => ({
    setTimeout: setTimeoutMock,
  }));

  try {
    await withMockedFsPromises({ open: openMock }, async () => {
      await run(await import('@/shared/file-io.js'));
    });
  } finally {
    vi.doUnmock('node:timers/promises');
    vi.resetModules();
  }
}

function createFileHandle(): Pick<FileHandle, 'close'> {
  return {
    close: vi.fn(async (): Promise<void> => {}),
  };
}

describe('openWithFileDescriptorRetry', () => {
  test('given EMFILE clears on retry, when opening a file, then it returns the handle', async () => {
    const fileHandle = createFileHandle();
    const openError = new MockNodeError('EMFILE');
    const openMock = vi.fn(
      async (_filePath: string, _flags: string): Promise<unknown> => {
        if (openMock.mock.calls.length === 1) {
          throw openError;
        }

        return fileHandle;
      },
    );
    const setTimeoutMock = vi.fn(async (_delayMs: number): Promise<void> => {});

    await withMockedOpen(
      openMock,
      setTimeoutMock,
      async ({ openWithFileDescriptorRetry }) => {
        await expect(
          openWithFileDescriptorRetry('/repo/src/app.ts'),
        ).resolves.toBe(fileHandle);
        expect(openMock).toHaveBeenNthCalledWith(1, '/repo/src/app.ts', 'r');
        expect(openMock).toHaveBeenNthCalledWith(2, '/repo/src/app.ts', 'r');
        expect(setTimeoutMock).toHaveBeenCalledTimes(1);
        expect(setTimeoutMock).toHaveBeenCalledWith(10);
      },
    );
  });

  test('given ENFILE clears on retry, when opening a file, then it returns the handle', async () => {
    const fileHandle = createFileHandle();
    const openError = new MockNodeError('ENFILE');
    const openMock = vi.fn(
      async (_filePath: string, _flags: string): Promise<unknown> => {
        if (openMock.mock.calls.length === 1) {
          throw openError;
        }

        return fileHandle;
      },
    );
    const setTimeoutMock = vi.fn(async (_delayMs: number): Promise<void> => {});

    await withMockedOpen(
      openMock,
      setTimeoutMock,
      async ({ openWithFileDescriptorRetry }) => {
        await expect(
          openWithFileDescriptorRetry('/repo/src/app.ts'),
        ).resolves.toBe(fileHandle);
        expect(openMock).toHaveBeenCalledTimes(2);
        expect(setTimeoutMock).toHaveBeenCalledTimes(1);
        expect(setTimeoutMock).toHaveBeenCalledWith(10);
      },
    );
  });

  test('given file handle pressure keeps failing, when opening a file, then it stops after the final attempt', async () => {
    const openError = new MockNodeError('EMFILE');
    const openMock = vi.fn(
      async (_filePath: string, _flags: string): Promise<never> => {
        throw openError;
      },
    );
    const setTimeoutMock = vi.fn(async (_delayMs: number): Promise<void> => {});

    await withMockedOpen(
      openMock,
      setTimeoutMock,
      async ({ openWithFileDescriptorRetry }) => {
        await expect(
          openWithFileDescriptorRetry('/repo/src/app.ts'),
        ).rejects.toBe(openError);
        expect(openMock).toHaveBeenCalledTimes(4);
        expect(setTimeoutMock).toHaveBeenNthCalledWith(1, 10);
        expect(setTimeoutMock).toHaveBeenNthCalledWith(2, 25);
        expect(setTimeoutMock).toHaveBeenNthCalledWith(3, 50);
      },
    );
  });

  test('given a non-pressure error, when opening a file, then it does not retry', async () => {
    const openError = new MockNodeError('EACCES');
    const openMock = vi.fn(
      async (_filePath: string, _flags: string): Promise<never> => {
        throw openError;
      },
    );
    const setTimeoutMock = vi.fn(async (_delayMs: number): Promise<void> => {});

    await withMockedOpen(
      openMock,
      setTimeoutMock,
      async ({ openWithFileDescriptorRetry }) => {
        await expect(
          openWithFileDescriptorRetry('/repo/src/app.ts'),
        ).rejects.toBe(openError);
        expect(openMock).toHaveBeenCalledTimes(1);
        expect(setTimeoutMock).not.toHaveBeenCalled();
      },
    );
  });

  test('given open throws a non-error value, when opening a file, then it reports the value', async () => {
    const thrownValue = 'open failed';
    const openMock = vi.fn(
      async (_filePath: string, _flags: string): Promise<never> => {
        return Promise.reject(thrownValue);
      },
    );
    const setTimeoutMock = vi.fn(async (_delayMs: number): Promise<void> => {});

    await withMockedOpen(
      openMock,
      setTimeoutMock,
      async ({ openWithFileDescriptorRetry }) => {
        const error = await getThrownError(async () => {
          await openWithFileDescriptorRetry('/repo/src/app.ts');
        });

        expect(error.message).toBe(
          'File open failed with a non-error value "open failed".',
        );
        expect(error.cause).toBe(thrownValue);
        expect(openMock).toHaveBeenCalledTimes(1);
        expect(setTimeoutMock).not.toHaveBeenCalled();
      },
    );
  });
});

describe('readOptionalFileSystemValue', () => {
  test('given the path exists, when reading an optional filesystem value, then it returns the value', async () => {
    const { readOptionalFileSystemValue } = await import('@/shared/file-io.js');

    await expect(
      readOptionalFileSystemValue(async () => 'path value'),
    ).resolves.toBe('path value');
  });

  test('given Node reports ENOENT, when reading an optional filesystem value, then it returns undefined', async () => {
    const { readOptionalFileSystemValue } = await import('@/shared/file-io.js');

    await expect(
      readOptionalFileSystemValue(async (): Promise<never> => {
        throw new MockNodeError('ENOENT');
      }),
    ).resolves.toBeUndefined();
  });

  test('given Node reports a different error, when reading an optional filesystem value, then it rethrows it', async () => {
    const readError = new MockNodeError('EACCES');
    const { readOptionalFileSystemValue } = await import('@/shared/file-io.js');

    await expect(
      readOptionalFileSystemValue(async (): Promise<never> => {
        throw readError;
      }),
    ).rejects.toBe(readError);
  });
});

describe('readOpenFileHandle', () => {
  test('given reading succeeds, when reading an open file handle, then it closes the handle and returns the result', async () => {
    const fileHandle = createFileHandle();
    const { readOpenFileHandle } = await import('@/shared/file-io.js');

    await expect(
      readOpenFileHandle(fileHandle, async () => 'Overview text'),
    ).resolves.toBe('Overview text');
    expect(fileHandle.close).toHaveBeenCalledTimes(1);
  });

  test('given read and close both fail, when reading an open file handle, then the read error stays primary', async () => {
    const readError = new Error('Mock read failed.');
    const closeError = new Error('Mock close failed.');
    const fileHandle = {
      close: vi.fn(async (): Promise<void> => {
        throw closeError;
      }),
    };
    const { readOpenFileHandle } = await import('@/shared/file-io.js');

    const error = await getThrownError(() =>
      readOpenFileHandle(fileHandle, async (): Promise<never> => {
        throw readError;
      }),
    );

    expectReadAndCloseErrors(error, readError, closeError);
  });
});

function expectReadAndCloseErrors(
  error: Error,
  readError: Error,
  closeError: Error,
): void {
  expect(error).toBeInstanceOf(AggregateError);

  if (!(error instanceof AggregateError)) {
    throw new Error('Expected an AggregateError.');
  }

  expect(error.message).toBe(readError.message);
  expect(error.cause).toBe(readError);
  expect(error.errors).toHaveLength(1);

  const closeFailure: unknown = error.errors[0];

  expect(closeFailure).toBeInstanceOf(Error);

  if (!(closeFailure instanceof Error)) {
    throw new Error('Expected close failure to be an Error.');
  }

  expect(closeFailure.message).toBe('Failed to close file handle after read.');
  expect(closeFailure.cause).toBe(closeError);
}
