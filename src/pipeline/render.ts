/** @fileoverview Sorts file and directory map entries and renders a plain file map */

import type { MapEntry } from '@/pipeline/index.js';

import { compareMapEntries } from '@/pipeline/entry-paths.js';
import { assertNever } from '@/shared/validation.js';

type DirectoryMapEntry = Extract<MapEntry, { readonly kind: 'directory' }>;
type FileMapEntry = Extract<MapEntry, { readonly kind: 'file' }>;

/**
 * Turns map entries into newline-terminated chunks so the CLI can write each
 * row without building the whole rendered map first.
 *
 * @param entries - Relative file and directory entries from the map-building pipeline.
 * @returns Newline-terminated rendered map rows in display order.
 */
export function* renderFileMapChunks(
  entries: readonly MapEntry[],
): IterableIterator<string> {
  const sortedEntries = [...entries].sort(compareMapEntries);

  for (const entry of sortedEntries) {
    yield `${formatMapEntry(entry)}\n`;
  }
}

function formatMapEntry(entry: MapEntry): string {
  switch (entry.kind) {
    case 'directory':
      return formatDirectoryEntry(entry);

    case 'file':
      return formatFileEntry(entry);

    default:
      return assertNever(entry, 'map entry', 'directory or file');
  }
}

function formatDirectoryEntry(entry: DirectoryMapEntry): string {
  const displayPath = formatDirectoryPath(entry.path);
  const fileLabel = entry.hiddenFileCount === 1 ? 'file' : 'files';

  if (entry.description === undefined) {
    return `${displayPath} (${entry.hiddenFileCount} ${fileLabel})`;
  }

  return `${displayPath} — ${entry.description} (${entry.hiddenFileCount} ${fileLabel})`;
}

function formatFileEntry(entry: FileMapEntry): string {
  const displayPath = `./${entry.path}`;

  if (entry.description === undefined) {
    return displayPath;
  }

  return `${displayPath} — ${entry.description}`;
}

function formatDirectoryPath(path: string): string {
  if (path === '.') {
    return './';
  }

  return `./${path}/`;
}
