/** @fileoverview Detects glob syntax in discovery patterns. */

const GLOB_SYNTAX_PATTERN = /[*?[{(]/u;

/**
 * Checks whether a discovery pattern part contains glob syntax.
 *
 * @param value - Pattern text to check.
 * @returns Whether the text contains glob syntax.
 */
export function hasGlobSyntax(value: string): boolean {
  return GLOB_SYNTAX_PATTERN.test(value);
}
