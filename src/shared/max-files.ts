/** @fileoverview Caps file counts before filemap does expensive per-file work */

import { validateIntegerInRange } from '@/shared/validation.js';

export const MAX_FILES = 200_000;
export const DEFAULT_MAX_FILES = validateMaxFiles(10_000);

declare const maxFilesBrand: unique symbol;

export type MaxFiles = {
  readonly [maxFilesBrand]: 'MaxFiles';
} & number;

/**
 * Checks a file-count cap before it controls discovery or map building.
 *
 * @param maxFiles - Limit value from CLI or shared-code input.
 * @returns The same value marked as a checked file-count cap.
 */
export function validateMaxFiles(maxFiles: unknown): MaxFiles {
  return validateIntegerInRange(
    maxFiles,
    'maxFiles',
    `a positive integer up to ${String(MAX_FILES)}`,
    1,
    MAX_FILES,
  ) as MaxFiles;
}

/**
 * Fails when discovery found more candidates than filemap should send to later filters.
 *
 * @param count - Candidate file count after glob and scope filtering.
 * @param maxFiles - Checked discovery cap.
 */
export function assertDiscoveryFileCountWithinLimit(
  count: number,
  maxFiles: MaxFiles,
): void {
  if (count <= maxFiles) {
    return;
  }

  throw new Error(
    `Filemap found ${String(count)} discovered or visible files before Git ignore filtering, which exceeds the max-files limit of ${String(maxFiles)}. Re-run with --max-files ${String(count)} or narrow [scope], --include, or --exclude.`,
  );
}

/**
 * Fails when the visible map has more files than filemap should read.
 *
 * @param count - File count after excludes, scope, and collapse planning.
 * @param maxFiles - Checked file-count cap.
 */
export function assertFileCountWithinLimit(
  count: number,
  maxFiles: MaxFiles,
): void {
  if (count <= maxFiles) {
    return;
  }

  throw new Error(
    `Filemap found ${String(count)} visible files, which exceeds the max-files limit of ${String(maxFiles)}. Re-run with --max-files ${String(count)} or narrow [scope], --include, or --exclude.`,
  );
}
