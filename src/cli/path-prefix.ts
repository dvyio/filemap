/** @fileoverview Resolves paths and replaces local path prefixes in CLI output */

import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { normalizeToPosixPath } from '@/paths/brands.js';

/** Ordered path prefixes that share one replacement label. */
export interface PathPrefixReplacement {
  readonly prefixCandidates: readonly string[];
  readonly replacement: string;
}

/**
 * Replaces a path prefix and returns POSIX separators for CLI text.
 *
 * @param value - Path that may start with the prefix.
 * @param prefix - Absolute prefix to hide.
 * @param replacement - Safe text shown instead of the prefix.
 * @returns The redacted path, or `undefined` when the prefix does not match.
 */
export function replacePathPrefix(
  value: string,
  prefix: string,
  replacement: string,
): string | undefined {
  if (prefix === '') {
    return undefined;
  }

  if (value === prefix) {
    return replacement;
  }

  const prefixWithSeparator = prefix.endsWith(sep) ? prefix : `${prefix}${sep}`;

  if (!value.startsWith(prefixWithSeparator)) {
    return undefined;
  }

  return `${replacement}/${normalizeToPosixPath(value.slice(prefixWithSeparator.length))}`;
}

/**
 * Tries ordered path prefix candidates and returns the first replacement.
 *
 * @param value - Path that may start with one of the prefixes.
 * @param replacements - Prefix candidate groups in priority order.
 * @returns The redacted path, or `undefined` when no prefix matches.
 */
export function replacePathPrefixCandidates(
  value: string,
  replacements: readonly PathPrefixReplacement[],
): string | undefined {
  for (const replacement of replacements) {
    for (const prefixCandidate of replacement.prefixCandidates) {
      const replacedPath = replacePathPrefix(
        value,
        prefixCandidate,
        replacement.replacement,
      );

      if (replacedPath !== undefined) {
        return replacedPath;
      }
    }
  }

  return undefined;
}

/**
 * Resolves a path without failing when the path does not exist.
 *
 * @param path - Path to resolve.
 * @returns The real path when readable, otherwise the resolved path.
 */
export function resolveReadablePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
