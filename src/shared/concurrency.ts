/** @fileoverview Runs small async worker pools while keeping result order */

import {
  createNonErrorThrownValueError,
  formatInvalidValueMessage,
} from '@/shared/error-format.js';
import { validateIntegerInRange } from '@/shared/validation.js';

export const DEFAULT_CONCURRENCY = 32;

/**
 * Maps items with a fixed number of concurrent workers.
 *
 * @param items - Defined items to pass to the worker function.
 * @param concurrency - Maximum number of workers to run at once.
 * @param fn - Async worker run once for each item.
 * @returns Results in the same order as the input items.
 */
export async function mapWithConcurrency<
  TInput extends NonNullable<unknown>,
  TOutput,
>(
  items: readonly TInput[],
  concurrency: number,
  fn: (item: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  validateConcurrency(concurrency);

  const results: TOutput[] = [];
  let index = 0;
  let firstError: Error | undefined;

  async function worker(): Promise<void> {
    while (firstError === undefined && index < items.length) {
      const currentIndex = index;
      index += 1;
      const item = items[currentIndex];

      try {
        if (item === undefined) {
          throw new Error(
            formatInvalidValueMessage(
              'concurrency item',
              item,
              'every item to be defined',
            ),
          );
        }

        results[currentIndex] = await fn(item);
      } catch (error) {
        firstError ??= createNonErrorThrownValueError(error);
      }
    }
  }

  const workers: Promise<void>[] = [];
  const workerCount = Math.min(concurrency, items.length);

  for (let w = 0; w < workerCount; w += 1) {
    workers.push(worker());
  }

  await Promise.all(workers);

  if (firstError !== undefined) {
    throw firstError;
  }

  return results;
}

function validateConcurrency(concurrency: number): void {
  validateIntegerInRange(concurrency, 'concurrency', 'a positive integer', 1);
}
