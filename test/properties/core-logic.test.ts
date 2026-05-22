import { describe, expect, test } from 'vitest';

import type { MapEntry } from '@/pipeline/index.js';

import { createGitCheckIgnoreOutputParser } from '@/git/ignore-output-parser.js';
import {
  normalizeRepoGlobPattern,
  type RepoPath,
  toCwdPath,
  toDiscoveredRepoPath,
  toRepoPath,
} from '@/paths/brands.js';
import { renderFileMapChunks } from '@/pipeline/render.js';

const SAFE_SEGMENTS = [
  'app',
  'auth',
  'build-tools',
  'config_1',
  'docs',
  'feature flag',
  'lib',
  'nested',
  'src',
  'utils',
] as const;
const FILE_NAMES = [
  'api.ts',
  'app.ts',
  'build.ts',
  'index.ts',
  'login.ts',
  'readme.md',
  'worker.ts',
] as const;
const PROPERTY_CASE_COUNT = 40;
const PROPERTY_CWD = toCwdPath('/repo/project');
const REPO_GLOB_EXPECTATION = 'a repo-relative glob pattern';

describe('repo path properties', () => {
  test('given generated safe repo paths, when branding, then output stays normalized and bounded', () => {
    for (const filePath of generateSafeRepoPaths(PROPERTY_CASE_COUNT)) {
      const brandedPath = toRepoPath(
        ` ${filePath.replaceAll('/', '\\')}/// `,
        'filePath',
      );

      expect(brandedPath).toBe(filePath);
      expect(brandedPath).not.toContain('\\');
      expect(brandedPath).not.toMatch(/\/$/u);
      expect(brandedPath).not.toMatch(/(^|\/)\.\.($|\/)/u);
    }
  });

  test('given generated escape paths, when branding, then each one is rejected', () => {
    for (const filePath of generateSafeRepoPaths(PROPERTY_CASE_COUNT)) {
      for (const unsafePath of [
        `../${filePath}`,
        `./../${filePath}`,
        `${firstPathSegment(filePath)}/../../secret.ts`,
        `/${filePath}`,
        `C:\\repo\\project\\${filePath.replaceAll('/', '\\')}`,
      ]) {
        expect(() => toRepoPath(unsafePath, 'filePath')).toThrow(
          'expected a repo-relative path',
        );
      }
    }
  });

  test('given generated glob patterns, when normalizing, then current-directory prefixes and separators are removed', () => {
    for (const filePath of generateSafeRepoPaths(PROPERTY_CASE_COUNT)) {
      const globPattern = ` ././${filePath.replaceAll('/', '\\')} `;
      const normalizedPattern = normalizeRepoGlobPattern(
        globPattern,
        'include pattern',
        REPO_GLOB_EXPECTATION,
      );

      expect(normalizedPattern).toBe(filePath);
      expect(normalizedPattern).not.toContain('\\');
      expect(normalizedPattern).not.toMatch(/^\.\//u);
    }
  });
});

describe('render sorting properties', () => {
  test('given generated map entries, when rendering, then every row is grouped by directory and name', () => {
    for (const entries of generateMapEntrySets()) {
      const renderedRows = [...renderFileMapChunks(entries)];

      expect(renderedRows).toHaveLength(entries.length);
      expect(renderedRows.every((row) => row.endsWith('\n'))).toBe(true);

      const renderedPaths = renderedRows.map(readRenderedPath);

      expect(renderedPaths).toEqual([...renderedPaths].sort(comparePathLabels));

      for (const entry of entries) {
        expect(renderedPaths).toContain(formatExpectedPathLabel(entry));
      }
    }
  });
});

describe('git check-ignore output parser properties', () => {
  test('given generated Git output includes empty NUL segments, when parsing, then empty paths are ignored', () => {
    const requestedPaths = generateRepoPathSets()[0] ?? [];
    const parser = createGitCheckIgnoreOutputParser(
      PROPERTY_CWD,
      requestedPaths,
    );

    parser.addChunk(`\0${requestedPaths.join('\0')}\0\0`);

    expect([...parser.finish()]).toEqual(requestedPaths);
  });

  test('given generated NUL-separated Git output, when chunks split at many offsets, then every requested path is kept', () => {
    for (const paths of generateRepoPathSets()) {
      const gitOutput = `${paths.join('\0')}\0`;

      for (const chunkSize of [1, 2, 3, 5, 8, 13, gitOutput.length]) {
        const parser = createGitCheckIgnoreOutputParser(PROPERTY_CWD, paths);

        for (const chunk of chunkString(gitOutput, chunkSize)) {
          parser.addChunk(chunk);
        }

        expect([...parser.finish()]).toEqual(paths);
      }
    }
  });
});

function generateSafeRepoPaths(count: number): readonly string[] {
  return Array.from({ length: count }, (_unused, index) => {
    const depth = (index % 3) + 1;
    const segments = Array.from(
      { length: depth },
      (_nestedUnused, depthIndex) => {
        return SAFE_SEGMENTS[(index + depthIndex) % SAFE_SEGMENTS.length];
      },
    );
    const fileName = FILE_NAMES[index % FILE_NAMES.length];

    return [...segments, fileName].join('/');
  });
}

function generateMapEntrySets(): readonly (readonly MapEntry[])[] {
  return [
    generateSafeRepoPaths(12).map((path, index) => {
      return {
        description: index % 2 === 0 ? `File ${String(index)}` : undefined,
        kind: 'file',
        path,
      };
    }),
    generateSafeRepoPaths(9).map((path, index) => {
      if (index % 3 !== 0) {
        return {
          description: undefined,
          kind: 'file',
          path,
        };
      }

      return {
        description: `Directory ${String(index)}`,
        hiddenFileCount: index + 1,
        kind: 'directory',
        path: path.split('/').slice(0, -1).join('/'),
      };
    }),
  ];
}

function generateRepoPathSets(): readonly (readonly RepoPath[])[] {
  return [3, 7, 15].map((count) => {
    return generateSafeRepoPaths(count).map((path) => {
      return toDiscoveredRepoPath(path, 'filePath');
    });
  });
}

function firstPathSegment(path: string): string {
  return path.split('/')[0] ?? path;
}

function readRenderedPath(row: string): string {
  const trimmedRow = row.trimEnd();
  const descriptionSeparatorIndex = trimmedRow.indexOf(' — ');

  if (descriptionSeparatorIndex !== -1) {
    return trimmedRow.slice(0, descriptionSeparatorIndex);
  }

  const directoryCountMatch = /^(.*) \(\d+ files?\)$/u.exec(trimmedRow);

  if (directoryCountMatch !== null) {
    return directoryCountMatch[1] ?? trimmedRow;
  }

  return trimmedRow;
}

function comparePathLabels(left: string, right: string): number {
  const leftDirectory = readDirectoryLabel(left);
  const rightDirectory = readDirectoryLabel(right);

  if (leftDirectory < rightDirectory) {
    return -1;
  }

  if (leftDirectory > rightDirectory) {
    return 1;
  }

  const leftName = readBaseName(left);
  const rightName = readBaseName(right);

  if (leftName < rightName) {
    return -1;
  }

  if (leftName > rightName) {
    return 1;
  }

  return 0;
}

function readDirectoryLabel(pathLabel: string): string {
  const normalizedPathLabel = pathLabel.replace(/^\.\/|\/$/gu, '');
  const lastSlashIndex = normalizedPathLabel.lastIndexOf('/');

  if (lastSlashIndex === -1) {
    return '.';
  }

  return normalizedPathLabel.slice(0, lastSlashIndex);
}

function readBaseName(pathLabel: string): string {
  const normalizedPathLabel = pathLabel.replace(/^\.\/|\/$/gu, '');
  const lastSlashIndex = normalizedPathLabel.lastIndexOf('/');

  if (lastSlashIndex === -1) {
    return normalizedPathLabel;
  }

  return normalizedPathLabel.slice(lastSlashIndex + 1);
}

function formatExpectedPathLabel(entry: MapEntry): string {
  if (entry.kind === 'directory') {
    if (entry.path === '.') {
      return './';
    }

    return `./${entry.path}/`;
  }

  return `./${entry.path}`;
}

function chunkString(value: string, chunkSize: number): readonly string[] {
  const chunks: string[] = [];

  for (let index = 0; index < value.length; index += chunkSize) {
    chunks.push(value.slice(index, index + chunkSize));
  }

  return chunks;
}
