import { describe, expect, test } from 'vitest';

import { type MapEntry } from '@/pipeline/index.js';
import { renderFileMapChunks } from '@/pipeline/render.js';

import {
  buildDiscoveredMap,
  createFixture,
  withWorkspace,
} from '../helpers.js';

function renderEntries(entries: readonly MapEntry[]): string {
  return [...renderFileMapChunks(entries)].join('');
}

describe('renderFileMapChunks', () => {
  test('returns empty string for empty input', () => {
    expect(renderEntries([])).toBe('');
  });

  test('renders map entries built from discovered files', async () => {
    await withWorkspace('filemap-render-', async (cwd) => {
      await createFixture(
        cwd,
        'src/app.ts',
        '/** @fileoverview Main application */\n',
      );
      await createFixture(cwd, 'src/lib.ts', 'export const lib = true;\n');

      const entries = await buildDiscoveredMap(['src/app.ts', 'src/lib.ts'], {
        cwd,
      });

      expect(renderEntries(entries)).toBe(
        './src/app.ts — Main application\n./src/lib.ts\n',
      );
    });
  });

  test('renders one newline-terminated chunk for each row', () => {
    const entries = [
      {
        description: 'Main app',
        kind: 'file',
        path: 'src/app.ts',
      },
      {
        description: undefined,
        hiddenFileCount: 2,
        kind: 'directory',
        path: 'src/auth',
      },
      {
        description: undefined,
        kind: 'file',
        path: 'src/utils.ts',
      },
    ] satisfies readonly MapEntry[];

    expect([...renderFileMapChunks(entries)]).toEqual([
      './src/app.ts — Main app\n',
      './src/auth/ (2 files)\n',
      './src/utils.ts\n',
    ]);
  });

  test('formats described files with an em dash separator', () => {
    expect(
      renderEntries([
        {
          description: 'Main application',
          kind: 'file',
          path: 'src/app.ts',
        },
      ]),
    ).toBe('./src/app.ts — Main application\n');
  });

  test('formats undescribed files as path only', () => {
    expect(
      renderEntries([
        {
          description: undefined,
          kind: 'file',
          path: 'src/app.ts',
        },
      ]),
    ).toBe('./src/app.ts\n');
  });

  test('renders normal paths unchanged', () => {
    expect(
      renderEntries([
        {
          description: undefined,
          kind: 'file',
          path: 'src/auth/login.ts',
        },
      ]),
    ).toBe('./src/auth/login.ts\n');
  });

  test('renders root directory entries', () => {
    expect(
      renderEntries([
        {
          description: undefined,
          hiddenFileCount: 2,
          kind: 'directory',
          path: '.',
        },
      ]),
    ).toBe('./ (2 files)\n');
  });

  test('rejects discovered file paths with control characters before extraction', async () => {
    await withWorkspace('filemap-render-', async (cwd) => {
      await createFixture(
        cwd,
        'src/bad\n- injected.ts',
        '/** @fileoverview Bad path */\n',
      );

      await expect(
        buildDiscoveredMap(['src/bad\n- injected.ts'], { cwd }),
      ).rejects.toThrow(
        `Invalid resolvedPath "${cwd}/src/bad\\u000a- injected.ts" — expected a path without control characters.`,
      );
    });
  });

  test('rejects discovered file paths with Unicode format controls before extraction', async () => {
    await withWorkspace('filemap-render-', async (cwd) => {
      await createFixture(
        cwd,
        'src/bad\u202e.ts',
        '/** @fileoverview Bad path */\n',
      );

      await expect(
        buildDiscoveredMap(['src/bad\u202e.ts'], { cwd }),
      ).rejects.toThrow(
        `Invalid resolvedPath "${cwd}/src/bad\\u202e.ts" — expected a path without Unicode format characters.`,
      );
    });
  });

  test('sorts files in directory-grouped alphabetical order', () => {
    expect(
      renderEntries([
        { description: undefined, kind: 'file', path: 'src/b.ts' },
        { description: undefined, kind: 'file', path: 'lib/a.ts' },
        { description: undefined, kind: 'file', path: 'src/a.ts' },
        { description: undefined, kind: 'file', path: 'lib/b.ts' },
        { description: undefined, kind: 'file', path: 'app.ts' },
      ]),
    ).toBe(
      [
        './app.ts',
        './lib/a.ts',
        './lib/b.ts',
        './src/a.ts',
        './src/b.ts',
        '',
      ].join('\n'),
    );
  });

  test('handles a mix of described and undescribed files', () => {
    expect(
      renderEntries([
        { description: 'Main app', kind: 'file', path: 'src/app.ts' },
        { description: undefined, kind: 'file', path: 'src/utils.ts' },
        { description: 'Shared helpers', kind: 'file', path: 'lib/helper.ts' },
      ]),
    ).toBe(
      [
        './lib/helper.ts — Shared helpers',
        './src/app.ts — Main app',
        './src/utils.ts',
        '',
      ].join('\n'),
    );
  });

  test('renders a described directory entry with a trailing slash and file count', () => {
    expect(
      renderEntries([
        {
          description: 'Build and deploy tooling',
          hiddenFileCount: 7,
          kind: 'directory',
          path: 'scripts',
        },
      ]),
    ).toBe('./scripts/ — Build and deploy tooling (7 files)\n');
  });

  test('renders an undescribed directory entry as path and file count only', () => {
    expect(
      renderEntries([
        {
          description: undefined,
          hiddenFileCount: 2,
          kind: 'directory',
          path: 'scripts',
        },
      ]),
    ).toBe('./scripts/ (2 files)\n');
  });

  test('renders a singular file label when a directory hides one file', () => {
    expect(
      renderEntries([
        {
          description: 'Tooling',
          hiddenFileCount: 1,
          kind: 'directory',
          path: 'scripts',
        },
      ]),
    ).toBe('./scripts/ — Tooling (1 file)\n');
  });

  test('sorts file and directory entries together by path', () => {
    expect(
      renderEntries([
        {
          description: 'Tooling',
          hiddenFileCount: 2,
          kind: 'directory',
          path: 'src/scripts',
        },
        { description: 'App', kind: 'file', path: 'src/app.ts' },
        { description: 'Utils', kind: 'file', path: 'src/utils.ts' },
      ]),
    ).toBe(
      [
        './src/app.ts — App',
        './src/scripts/ — Tooling (2 files)',
        './src/utils.ts — Utils',
        '',
      ].join('\n'),
    );
  });
});
