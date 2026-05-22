/** @fileoverview Validates user supplied discovery groups, globs, and extensions */

import { type Extension } from '@/discovery/types.js';
import {
  normalizeRepoGlobPattern,
  REPO_GLOB_PATTERN_EXPECTATION,
  type RepoGlob,
} from '@/paths/brands.js';
import { DEFAULT_EXTENSIONS } from '@/shared/defaults.js';
import { formatInvalidValueMessage } from '@/shared/error-format.js';
import {
  validateArray,
  validateNonEmptyString,
  validateNonEmptyStringArray,
} from '@/shared/validation.js';

const EXTENSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

/**
 * Validates a user-supplied group list.
 *
 * @param groups - Raw group names from user options.
 * @param optionName - Option name used in validation errors.
 * @returns Trimmed group names, or `undefined` when omitted.
 */
export function validateGroupList(
  groups: unknown,
  optionName: 'excludeGroups' | 'includeGroups',
): string[] | undefined {
  if (groups === undefined) {
    return undefined;
  }

  const groupList = validateNonEmptyStringArray(
    groups,
    optionName,
    'an array of group names',
    `${optionName} value`,
    'a non-empty group name',
  );

  return groupList.map((group) => group.trim());
}

/**
 * Validates user-supplied include or exclude patterns.
 *
 * @param patterns - Raw patterns from user options.
 * @param optionName - Option name used in validation errors.
 * @returns Normalized repo-relative patterns, or `undefined` when omitted.
 */
export function validatePatternList(
  patterns: unknown,
  optionName: 'exclude' | 'include',
): RepoGlob[] | undefined {
  if (patterns === undefined) {
    return undefined;
  }

  const patternList = validateNonEmptyStringArray(
    patterns,
    optionName,
    'an array of glob patterns',
    `${optionName} pattern`,
    'a non-empty glob pattern',
  );

  return patternList.map((pattern) => {
    const normalizedPattern = normalizeRepoGlobPattern(
      pattern,
      `${optionName} pattern`,
      REPO_GLOB_PATTERN_EXPECTATION,
    );

    if (normalizedPattern.startsWith('!')) {
      throw new Error(
        formatInvalidValueMessage(
          `${optionName} pattern`,
          pattern,
          `${REPO_GLOB_PATTERN_EXPECTATION} without a leading "!". Remove the leading "!"`,
        ),
      );
    }

    return normalizedPattern;
  });
}

/**
 * Validates user-supplied literal file extensions.
 *
 * @param extensions - Raw extension values from user options.
 * @returns Branded literal extensions, or `undefined` when omitted.
 */
export function validateExtensionList(
  extensions: unknown,
): Extension[] | undefined {
  if (extensions === undefined) {
    return undefined;
  }

  const extensionList = validateArray(
    extensions,
    'ext',
    `a non-empty array of file extensions like "${DEFAULT_EXTENSIONS[0]}" or "${DEFAULT_EXTENSIONS[DEFAULT_EXTENSIONS.length - 1]}"`,
  );

  if (extensionList.length === 0) {
    throw new Error(
      formatInvalidValueMessage(
        'ext',
        extensions,
        `a non-empty array of file extensions like "${DEFAULT_EXTENSIONS[0]}" or "${DEFAULT_EXTENSIONS[DEFAULT_EXTENSIONS.length - 1]}"`,
      ),
    );
  }

  return extensionList.map((extension) => normalizeExtension(extension));
}

function normalizeExtension(extension: unknown): Extension {
  const normalizedExtension = validateNonEmptyString(
    extension,
    'ext',
    'a non-empty file extension like "ts" or "kt"',
  )
    .trim()
    .replace(/^\.+/u, '');

  if (normalizedExtension === '') {
    throw new Error(
      formatInvalidValueMessage(
        'ext',
        extension,
        'a non-empty file extension like "ts" or "kt"',
      ),
    );
  }

  if (!EXTENSION_PATTERN.test(normalizedExtension)) {
    throw new Error(
      formatInvalidValueMessage(
        'ext',
        extension,
        'a literal file extension like "ts" or "kt"',
      ),
    );
  }

  return normalizedExtension as Extension;
}
