/** @fileoverview Redacts local filesystem paths before CLI errors are printed */

import { homedir } from 'node:os';
import { basename, resolve, win32 } from 'node:path';

import {
  replacePathPrefixCandidates,
  resolveReadablePath,
} from '@/cli/path-prefix.js';
import { isWindowsAbsolutePath } from '@/paths/platform.js';

const QUOTED_POSIX_ABSOLUTE_PATH = /"((?:\/[^"\n\r]+))"/gu;
const SINGLE_QUOTED_POSIX_ABSOLUTE_PATH = /'((?:\/[^'\n\r]+))'/gu;
const QUOTED_WINDOWS_ABSOLUTE_PATH = /"([A-Za-z]:\\[^"\n\r]+)"/gu;
const SINGLE_QUOTED_WINDOWS_ABSOLUTE_PATH = /'([A-Za-z]:\\[^'\n\r]+)'/gu;

/** Redacts local paths before text is shown to CLI users. */
export interface UserFacingPathRedactor {
  /** Redacts quoted absolute paths inside a larger message. */
  readonly redactText: (text: string) => string;
}

/**
 * Builds a redactor for CLI errors that may contain local absolute paths.
 *
 * @param cwd - Directory that should be shown as `.` in user-facing errors.
 * @returns A redactor for error text and standalone paths.
 */
export function createUserFacingPathRedactor(
  cwd: string,
): UserFacingPathRedactor {
  const homeDirectory = homedir();
  const resolvedCwd = resolveReadablePath(cwd);
  const cwdCandidates = uniqueStrings([cwd, resolve(cwd), resolvedCwd]).sort(
    longestFirst,
  );
  const homeCandidates = uniqueStrings([
    homeDirectory,
    resolveReadablePath(homeDirectory),
  ]).sort(longestFirst);

  return {
    redactText(text): string {
      return redactQuotedAbsolutePaths(text, cwdCandidates, homeCandidates);
    },
  };
}

function redactQuotedAbsolutePaths(
  text: string,
  cwdCandidates: readonly string[],
  homeCandidates: readonly string[],
): string {
  return text
    .replace(QUOTED_POSIX_ABSOLUTE_PATH, (_match, path: string) => {
      return `"${redactQuotedAbsolutePath(path, cwdCandidates, homeCandidates)}"`;
    })
    .replace(SINGLE_QUOTED_POSIX_ABSOLUTE_PATH, (_match, path: string) => {
      return `'${redactQuotedAbsolutePath(path, cwdCandidates, homeCandidates)}'`;
    })
    .replace(QUOTED_WINDOWS_ABSOLUTE_PATH, (_match, path: string) => {
      return `"${redactQuotedAbsolutePath(path, cwdCandidates, homeCandidates)}"`;
    })
    .replace(SINGLE_QUOTED_WINDOWS_ABSOLUTE_PATH, (_match, path: string) => {
      return `'${redactQuotedAbsolutePath(path, cwdCandidates, homeCandidates)}'`;
    });
}

function redactQuotedAbsolutePath(
  path: string,
  cwdCandidates: readonly string[],
  homeCandidates: readonly string[],
): string {
  const redactedPath = replacePathPrefixCandidates(path, [
    { prefixCandidates: cwdCandidates, replacement: '.' },
    { prefixCandidates: homeCandidates, replacement: '~' },
  ]);

  if (redactedPath !== undefined) {
    return redactedPath;
  }

  return `<path:${getPathBasename(path)}>`;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value !== ''))];
}

function longestFirst(left: string, right: string): number {
  return right.length - left.length;
}

function getPathBasename(path: string): string {
  if (isWindowsAbsolutePath(path)) {
    return win32.basename(path);
  }

  return basename(path);
}
