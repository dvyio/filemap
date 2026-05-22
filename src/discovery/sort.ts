/** @fileoverview Sorts discovered repo paths in a stable text order */

/**
 * Compares file paths so discovery output is stable across walkers.
 *
 * @param left - First file path.
 * @param right - Second file path.
 * @returns Sort order for the two paths.
 */
export function compareFilePaths(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  /* v8 ignore next */
  return 0;
}
