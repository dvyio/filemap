import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { discoverFiles } from '@/discovery/index.js';

import {
  createDirectorySymlink,
  createFixture,
  createFixtureSymlink,
  withWorkspace,
} from '../helpers.js';

describe('discoverFiles scoped globs', () => {
  test('given a directory scope with include and exclude globs, when discovering, then only scoped files return', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/auth/login.ts');
      await createFixture(cwd, 'src/auth/login.test.ts');
      await createFixture(cwd, 'src/auth/skip.test.ts');
      await createFixture(cwd, 'src/admin/login.test.ts');
      await createFixture(cwd, 'packages/web/login.test.ts');

      await expect(
        discoverFiles({
          cwd,
          exclude: ['**/skip.test.ts'],
          include: ['**/*.test.ts'],
          scope: 'src/auth',
        }),
      ).resolves.toEqual(['src/auth/login.test.ts', 'src/auth/login.ts']);
    });
  });

  test('given a directory scope with an exact exclude, when discovering without rescues, then the scoped file stays hidden', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/auth/keep.ts');
      await createFixture(cwd, 'src/auth/skip.ts');
      await createFixture(cwd, 'src/admin/skip.ts');

      await expect(
        discoverFiles({
          cwd,
          exclude: ['skip.ts'],
          scope: 'src/auth',
        }),
      ).resolves.toEqual(['src/auth/keep.ts']);
    });
  });

  test('given a directory scope with rescues and an exact exclude, when discovering, then the exact exclude still wins', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/auth/app.ts');
      await createFixture(cwd, 'src/auth/keep.test.ts');
      await createFixture(cwd, 'src/auth/skip.test.ts');
      await createFixture(cwd, 'src/admin/skip.test.ts');

      await expect(
        discoverFiles({
          cwd,
          exclude: ['skip.test.ts'],
          include: ['**/*.test.ts'],
          scope: 'src/auth',
        }),
      ).resolves.toEqual(['src/auth/app.ts', 'src/auth/keep.test.ts']);
    });
  });

  test('given a directory scope inside a globstar include, when discovering, then it scans that scope', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/auth/login.ts');
      await createFixture(cwd, 'src/admin/login.ts');

      await expect(
        discoverFiles({
          cwd,
          include: ['**/auth/**'],
          scope: 'src/auth',
        }),
      ).resolves.toEqual(['src/auth/login.ts']);
    });
  });

  test('given a scoped include already inside the scope, when discovering, then it keeps that include path', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/auth/login.ts');
      await createFixture(cwd, 'src/auth/login.test.ts');

      await expect(
        discoverFiles({
          cwd,
          include: ['src/auth/*.test.ts'],
          scope: 'src/auth',
        }),
      ).resolves.toEqual(['src/auth/login.test.ts', 'src/auth/login.ts']);
    });
  });

  test('given a scoped include under a wider literal prefix, when discovering, then it narrows the globstar to the scope', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/auth/login.ts');
      await createFixture(cwd, 'src/auth/login.test.ts');
      await createFixture(cwd, 'src/admin/login.test.ts');

      await expect(
        discoverFiles({
          cwd,
          include: ['src/**/*.test.ts'],
          scope: 'src/auth',
        }),
      ).resolves.toEqual(['src/auth/login.test.ts', 'src/auth/login.ts']);
    });
  });

  test('given a scoped include under a wider literal prefix without globstar remainder, when discovering, then it keeps the pattern', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/auth/login.ts');
      await createFixture(cwd, 'src/auth/login.test.ts');

      await expect(
        discoverFiles({
          cwd,
          include: ['src/*.test.ts'],
          scope: 'src/auth',
        }),
      ).resolves.toEqual(['src/auth/login.ts']);
    });
  });

  test('given a dynamic include matches inside a scope, when discovering, then it rescues matching files', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/auth/login.ts');
      await createFixture(cwd, 'src/auth/login.test.ts');

      await expect(
        discoverFiles({
          cwd,
          include: ['**/{auth,admin}/**'],
          scope: 'src/auth',
        }),
      ).resolves.toEqual(['src/auth/login.test.ts', 'src/auth/login.ts']);
    });
  });

  test('given a file scope with include globs, when discovering, then only the scoped file returns', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/auth/login.ts');
      await createFixture(cwd, 'src/auth/login.test.ts');
      await createFixture(cwd, 'packages/web/login.test.ts');

      await expect(
        discoverFiles({
          cwd,
          include: ['**/*.test.ts'],
          scope: 'src/auth/login.ts',
        }),
      ).resolves.toEqual(['src/auth/login.ts']);
    });
  });

  test('rejects a directory scope that resolves outside cwd through a symlink', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      const outsideCwd = `${cwd}-outside`;

      try {
        await mkdir(outsideCwd, { recursive: true });
        const createdSymlink = await createDirectorySymlink(
          cwd,
          'linked',
          outsideCwd,
        );

        if (!createdSymlink) {
          return;
        }

        await expect(discoverFiles({ cwd, scope: 'linked' })).rejects.toThrow(
          `Invalid scope "linked" — expected a directory that resolves inside cwd "${cwd}".`,
        );
      } finally {
        await rm(outsideCwd, { force: true, recursive: true });
      }
    });
  });

  test('rejects a file scope that resolves outside cwd through a symlink', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      const outsideCwd = `${cwd}-outside`;

      try {
        await createFixture(outsideCwd, 'leak.ts');
        const createdSymlink = await createFixtureSymlink(
          cwd,
          'linked.ts',
          join(outsideCwd, 'leak.ts'),
        );

        if (!createdSymlink) {
          return;
        }

        await expect(
          discoverFiles({ cwd, scope: 'linked.ts' }),
        ).rejects.toThrow(
          `Invalid scope "linked.ts" — expected a file that resolves inside cwd "${cwd}".`,
        );
      } finally {
        await rm(outsideCwd, { force: true, recursive: true });
      }
    });
  });

  test('accepts an in-cwd symlink scope without leaking sibling files', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/auth/login.ts');
      await createFixture(cwd, 'src/admin/login.ts');
      const createdSymlink = await createDirectorySymlink(
        cwd,
        'linked',
        join(cwd, 'src/auth'),
      );

      if (!createdSymlink) {
        return;
      }

      await expect(discoverFiles({ cwd, scope: 'linked' })).resolves.toEqual([
        'linked/login.ts',
      ]);
    });
  });
});
