/** @fileoverview Keeps Git stderr output within a fixed character limit */

export interface LimitedTextCollector {
  readonly addChunk: (chunk: string) => void;
  readonly getText: () => string;
  readonly isTruncated: () => boolean;
}

/**
 * Collects text until a fixed character limit and records when later text was dropped.
 *
 * @param limit - Maximum number of characters to keep.
 * @returns A collector with the kept text and truncation status.
 */
export function createLimitedTextCollector(
  limit: number,
): LimitedTextCollector {
  let text = '';
  let isTextTruncated = false;

  return {
    addChunk: (chunk: string): void => {
      const remainingLength = limit - text.length;

      if (remainingLength <= 0) {
        isTextTruncated = true;
        return;
      }

      text += chunk.slice(0, remainingLength);

      if (chunk.length > remainingLength) {
        isTextTruncated = true;
      }
    },
    getText: (): string => text,
    isTruncated: (): boolean => isTextTruncated,
  };
}
