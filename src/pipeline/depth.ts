/** @fileoverview Validates depth values before directory collapse uses them */

import { validateIntegerInRange } from '@/shared/validation.js';

declare const depthBrand: unique symbol;

export type Depth = {
  readonly [depthBrand]: 'Depth';
} & number;

/**
 * Checks a depth value before it controls directory collapse.
 *
 * @param depth - Depth value from CLI or shared-code input.
 * @returns The same value marked as a checked depth.
 */
export function validateDepth(depth: unknown): Depth {
  return validateIntegerInRange(
    depth,
    'depth',
    'a non-negative integer',
    0,
  ) as Depth;
}
