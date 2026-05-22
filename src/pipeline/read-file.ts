/** @fileoverview Reads source file chunks until overview extraction can stop */

import { type FileHandle } from 'node:fs/promises';
import { TextDecoder } from 'node:util';

import {
  type DescriptionResult,
  extractDescription,
  extractDescriptionResult,
} from '@/pipeline/comment-collectors.js';
import { getOverviewTags, type OverviewTag } from '@/pipeline/tag.js';
import { assertNever } from '@/shared/validation.js';

const FILEOVERVIEW_INITIAL_CHUNK_BYTES = 1024;
const FILEOVERVIEW_SECOND_CHUNK_BYTES = 4 * 1024;
const FILEOVERVIEW_SCAN_LIMIT_BYTES = 64 * 1024;

/**
 * Reads an already-open file and returns the first matching overview description.
 *
 * @param fileHandle - Open file handle to read from offset 0.
 * @param tag - Tag to extract, or the default overview tags when omitted.
 * @returns The normalized description text, or `undefined` when no description exists.
 */
export async function extractFileoverviewFromHandle(
  fileHandle: FileHandle,
  tag?: string,
): Promise<string | undefined> {
  const tags = getOverviewTags(tag);

  return readFileHandleOverviewDescription(fileHandle, tags);
}

/**
 * Reads a file handle from the start until the overview is known.
 *
 * @param fileHandle - Open file handle to read from offset 0.
 * @param tags - Overview tags to search for.
 * @returns The normalized description, or `undefined` when no tag is found.
 */
async function readFileHandleOverviewDescription(
  fileHandle: FileHandle,
  tags: readonly OverviewTag[],
): Promise<string | undefined> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let fileContents = '';
  let bytesReadTotal = 0;
  let nextChunkSize = FILEOVERVIEW_INITIAL_CHUNK_BYTES;

  // Most overviews are at the top, so stop after the first complete comment.
  while (bytesReadTotal < FILEOVERVIEW_SCAN_LIMIT_BYTES) {
    const remainingByteLimit = FILEOVERVIEW_SCAN_LIMIT_BYTES - bytesReadTotal;
    const bytesToRead = Math.min(nextChunkSize, remainingByteLimit);
    const buffer = Buffer.alloc(bytesToRead);
    const result = await fileHandle.read(
      buffer,
      0,
      bytesToRead,
      bytesReadTotal,
    );

    if (result.bytesRead === 0) {
      return getOverviewAtFileEnd(fileContents, decoder, tags);
    }

    bytesReadTotal += result.bytesRead;
    fileContents += decodeSourceTextChunk(
      decoder,
      buffer.subarray(0, result.bytesRead),
    );

    const reachedFileEnd = result.bytesRead < bytesToRead;
    const reachedScanLimit = bytesReadTotal >= FILEOVERVIEW_SCAN_LIMIT_BYTES;
    const descriptionResult = extractDescriptionResult(fileContents, tags);

    const completeDescription =
      getCompleteOverviewDescription(descriptionResult);

    if (completeDescription !== undefined) {
      return completeDescription;
    }

    if (reachedFileEnd) {
      return getOverviewAtFileEnd(fileContents, decoder, tags);
    }

    if (reachedScanLimit) {
      return getOverviewAtScanLimit(descriptionResult, decoder);
    }

    nextChunkSize = getNextOverviewChunkSize(nextChunkSize);
  }

  flushSourceTextDecoder(decoder);
  return undefined;
}

function getCompleteOverviewDescription(
  descriptionResult: DescriptionResult,
): string | undefined {
  switch (descriptionResult.state) {
    case 'complete':
      return descriptionResult.description;

    case 'none':
    case 'open':
      return undefined;

    default:
      return assertNever(
        descriptionResult,
        'description result',
        'complete, none, or open',
      );
  }
}

function getOverviewAtFileEnd(
  fileContents: string,
  decoder: TextDecoder,
  tags: readonly OverviewTag[],
): string | undefined {
  return extractDescription(
    `${fileContents}${flushSourceTextDecoder(decoder)}`,
    tags,
  );
}

function getOverviewAtScanLimit(
  descriptionResult: DescriptionResult,
  decoder: TextDecoder,
): string | undefined {
  flushSourceTextDecoder(decoder);

  switch (descriptionResult.state) {
    case 'complete':
    case 'open':
      return descriptionResult.description;

    case 'none':
      return undefined;

    default:
      return assertNever(
        descriptionResult,
        'description result',
        'complete, none, or open',
      );
  }
}

function decodeSourceTextChunk(decoder: TextDecoder, buffer: Buffer): string {
  try {
    return decoder.decode(buffer, { stream: true });
  } catch (error) {
    throwInvalidSourceUtf8Error(error);
  }
}

function flushSourceTextDecoder(decoder: TextDecoder): string {
  try {
    return decoder.decode();
  } catch (error) {
    throwInvalidSourceUtf8Error(error);
  }
}

function throwInvalidSourceUtf8Error(error: unknown): never {
  throw new Error(
    'Invalid source overview text — expected valid UTF-8 text; save the file as UTF-8 or remove invalid bytes.',
    { cause: error },
  );
}

function getNextOverviewChunkSize(currentChunkSize: number): number {
  if (currentChunkSize === FILEOVERVIEW_INITIAL_CHUNK_BYTES) {
    return FILEOVERVIEW_SECOND_CHUNK_BYTES;
  }

  return currentChunkSize * 2;
}
