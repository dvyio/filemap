/** @fileoverview Builds the extended help text shown after the options list */

/**
 * Builds the extended help text appended after Commander's options list.
 * Pre-formatted for terminal output — lines stay under 78 characters.
 *
 * @returns The help text string, starting with a newline.
 */
export function buildExtendedHelpText(): string {
  return ['', NOTES_HELP, EXAMPLES_HELP, README_HELP].join('\n\n');
}

const NOTES_HELP = `Notes:
  filemap is read-only and prints to stdout.
  Add @fileoverview, @file, or @overview near the top of each source file.
  Pass [scope] to map one subtree or file.
  Use --strict > /dev/null when you only want the coverage check.
  Use --debug when discovery is slow or a file is missing.`;

const EXAMPLES_HELP = `Examples:
  $ filemap
      Print the current directory map.

  $ filemap --strict > /dev/null
      Check overview coverage only.

  $ filemap src/auth
      Print one subtree with scope-relative paths.

  $ filemap --ext ts --ext py
      Discover only .ts and .py files.

  $ filemap --collapse-dir scripts
      Collapse a subtree into one summary line.

  $ filemap --depth 1
      Collapse directories deeper than one level from the scope root.`;

const README_HELP = `Docs:
  See README.md for setup, default groups, Git timeout settings, and
  agent instructions.`;
