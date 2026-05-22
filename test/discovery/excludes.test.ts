import { mkdir, rm } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

import { discoverFiles } from '@/discovery/index.js';

import {
  createDirectorySymlink,
  createFixture,
  withWorkspace,
} from '../helpers.js';

describe('discoverFiles excludes', () => {
  test('excludes hard-excluded directories', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'node_modules/dep/index.js');
      await createFixture(cwd, 'vendor/lib/file.php');
      await createFixture(cwd, 'dist/bundle.js');
      await createFixture(cwd, 'out/server/page.js');
      await createFixture(cwd, '.cache/tool/output.ts');
      await createFixture(cwd, '.turbo/cache/output.ts');
      await createFixture(cwd, '.agent-batch/run/output.ts');
      await createFixture(cwd, 'src/app.ts');

      await expect(discoverFiles({ cwd })).resolves.toEqual(['src/app.ts']);
    });
  });

  test('excludes soft-excluded patterns', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/app.ts');
      await createFixture(cwd, 'src/app.test.ts');
      await createFixture(cwd, 'src/app.spec.ts');
      await createFixture(cwd, 'src/types.generated.ts');
      await createFixture(cwd, 'src/globals.d.ts');
      await createFixture(cwd, 'src/vite.config.ts');
      await createFixture(cwd, 'src/__tests__/app.ts');
      await createFixture(cwd, 'src/__fixtures__/data.ts');
      await createFixture(cwd, 'src/__mocks__/api.ts');
      await createFixture(cwd, 'src/__snapshots__/app.ts');
      await createFixture(cwd, 'test/fixtures/sample.ts');
      await createFixture(cwd, 'test/unit.ts');
      await createFixture(cwd, 'e2e/login.ts');
      await createFixture(cwd, 'cypress/integration/auth.ts');
      await createFixture(cwd, 'playwright/tests/smoke.ts');
      await createFixture(cwd, 'src/__generated__/schema.ts');
      await createFixture(cwd, 'src/Button.stories.tsx');
      await createFixture(cwd, 'stories/Page.tsx');
      await createFixture(cwd, '.storybook/main.ts');
      await createFixture(cwd, 'eslint-rules/no-foo.js');
      await createFixture(cwd, 'migrations/001.ts');
      await createFixture(cwd, 'package-lock.json');
      await createFixture(cwd, 'src/real.ts');

      await expect(discoverFiles({ cwd })).resolves.toEqual([
        'eslint-rules/no-foo.js',
        'migrations/001.ts',
        'src/app.ts',
        'src/real.ts',
        'src/vite.config.ts',
      ]);
    });
  });

  test('rescues a soft-excluded group when includeGroups uses a group name', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/app.ts');
      await createFixture(cwd, 'src/app.test.ts');

      await expect(
        discoverFiles({ cwd, includeGroups: ['tests'] }),
      ).resolves.toEqual(['src/app.test.ts', 'src/app.ts']);
    });
  });

  test('given a scoped test directory, when includeGroups includes tests, then direct children are included', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'test/unit.ts');
      await createFixture(cwd, 'test/nested/feature.ts');
      await createFixture(cwd, 'src/app.ts');

      await expect(
        discoverFiles({
          cwd,
          includeGroups: ['tests'],
          scope: 'test',
        }),
      ).resolves.toEqual(['test/nested/feature.ts', 'test/unit.ts']);
    });
  });

  test('given a scoped source directory, when includeGroups includes tests, then nested test directories still match', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/app.ts');
      await createFixture(cwd, 'src/test/unit.ts');
      await createFixture(cwd, 'src/auth/login.ts');
      await createFixture(cwd, 'src/auth/login.test.ts');

      await expect(
        discoverFiles({
          cwd,
          includeGroups: ['tests'],
          scope: 'src',
        }),
      ).resolves.toEqual([
        'src/app.ts',
        'src/auth/login.test.ts',
        'src/auth/login.ts',
        'src/test/unit.ts',
      ]);
    });
  });

  test('discovers dot directory files when default excludes are disabled', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, '.storybook/main.ts');
      await createFixture(cwd, 'src/app.ts');

      await expect(
        discoverFiles({ cwd, noDefaultExcludes: true }),
      ).resolves.toEqual(['.storybook/main.ts', 'src/app.ts']);
    });
  });

  test('keeps default excludes when noDefaultExcludes is false', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/app.ts');
      await createFixture(cwd, 'src/app.test.ts');

      await expect(
        discoverFiles({ cwd, noDefaultExcludes: false }),
      ).resolves.toEqual(['src/app.ts']);
    });
  });

  test('rescues story files from dot directories with the stories group', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, '.storybook/main.ts');
      await createFixture(cwd, 'src/app.ts');

      await expect(
        discoverFiles({ cwd, includeGroups: ['stories'] }),
      ).resolves.toEqual(['.storybook/main.ts', 'src/app.ts']);
    });
  });

  test('keeps git internals hard-excluded when dot files are discoverable', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, '.git/hooks/pre-commit.ts');
      await createFixture(cwd, '.storybook/main.ts');
      await createFixture(cwd, 'src/app.ts');

      await expect(
        discoverFiles({
          cwd,
          include: ['.git/hooks/pre-commit.ts'],
          noDefaultExcludes: true,
        }),
      ).resolves.toEqual(['.storybook/main.ts', 'src/app.ts']);
    });
  });

  test('does not scan a symlinked directory that resolves outside cwd', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      const outsideCwd = `${cwd}-outside`;

      try {
        await mkdir(outsideCwd, { recursive: true });
        await createFixture(cwd, 'src/app.ts');
        await createFixture(outsideCwd, 'leak.ts');

        const createdSymlink = await createDirectorySymlink(
          cwd,
          'linked',
          outsideCwd,
        );

        if (!createdSymlink) {
          return;
        }

        await expect(discoverFiles({ cwd })).resolves.toEqual(['src/app.ts']);
      } finally {
        await rm(outsideCwd, { force: true, recursive: true });
      }
    });
  });

  test('rescues soft-excluded files when include uses a glob pattern', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/app.ts');
      await createFixture(cwd, 'src/app.test.ts');
      await createFixture(cwd, 'src/app.spec.ts');

      await expect(
        discoverFiles({ cwd, include: ['**/*.test.ts'] }),
      ).resolves.toEqual(['src/app.test.ts', 'src/app.ts']);
    });
  });

  test('rescues soft-excluded files from multiple literal include roots', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'lib/keep.test.ts');
      await createFixture(cwd, 'src/app.ts');
      await createFixture(cwd, 'src/keep.test.ts');

      await expect(
        discoverFiles({
          cwd,
          include: ['src/**/*.test.ts', 'lib/**/*.test.ts'],
        }),
      ).resolves.toEqual([
        'lib/keep.test.ts',
        'src/app.ts',
        'src/keep.test.ts',
      ]);
    });
  });

  test('rescues an exact soft-excluded file path', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/app.ts');
      await createFixture(cwd, 'src/keep.test.ts');
      await createFixture(cwd, 'src/skip.test.ts');

      await expect(
        discoverFiles({ cwd, include: ['src/keep.test.ts'] }),
      ).resolves.toEqual(['src/app.ts', 'src/keep.test.ts']);
    });
  });

  test('given user include and exclude globs, when both match, then exclude wins', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/app.ts');
      await createFixture(cwd, 'src/keep.test.ts');
      await createFixture(cwd, 'src/skip.test.ts');

      await expect(
        discoverFiles({
          cwd,
          exclude: ['src/skip.test.ts'],
          include: ['**/*.test.ts'],
        }),
      ).resolves.toEqual(['src/app.ts', 'src/keep.test.ts']);
    });
  });

  test('given rescued files and explicit excludes, when both match, then exclude wins', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/app.ts');
      await createFixture(cwd, 'src/keep.test.ts');
      await createFixture(cwd, 'src/skip.test.ts');
      await createFixture(cwd, 'src/skip.generated.ts');

      await expect(
        discoverFiles({
          cwd,
          exclude: ['src/skip.test.ts', 'src/skip.generated.ts'],
          include: ['src/*.test.ts', 'src/*.generated.ts'],
        }),
      ).resolves.toEqual(['src/app.ts', 'src/keep.test.ts']);
    });
  });

  test('given brace include and exclude globs, when discovering, then exclude still wins', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/app.ts');
      await createFixture(cwd, 'src/keep.generated.ts');
      await createFixture(cwd, 'src/keep.test.ts');
      await createFixture(cwd, 'src/skip.generated.ts');
      await createFixture(cwd, 'src/skip.test.ts');

      await expect(
        discoverFiles({
          cwd,
          exclude: ['src/skip.{generated,test}.ts'],
          include: ['src/*.{generated,test}.ts'],
        }),
      ).resolves.toEqual([
        'src/app.ts',
        'src/keep.generated.ts',
        'src/keep.test.ts',
      ]);
    });
  });

  test('include does not broaden beyond the candidate set', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'Dockerfile');
      await createFixture(cwd, 'src/app.ts');

      await expect(
        discoverFiles({ cwd, include: ['Dockerfile'] }),
      ).resolves.toEqual(['src/app.ts']);
    });
  });

  test('excludeGroups with a group name adds that group to the active excludes', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/app.ts');
      await createFixture(cwd, 'src/vite.config.ts');

      await expect(
        discoverFiles({ cwd, excludeGroups: ['config'] }),
      ).resolves.toEqual(['src/app.ts']);
    });
  });

  test('custom exclude glob adds to soft excludes while keeping hard excludes', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'node_modules/dep/index.js');
      await createFixture(cwd, 'src/app.ts');
      await createFixture(cwd, 'src/app.test.ts');
      await createFixture(cwd, 'src/utils.helper.ts');

      await expect(
        discoverFiles({ cwd, exclude: ['**/*.helper.ts'] }),
      ).resolves.toEqual(['src/app.ts']);
    });
  });

  test('exclude wins over includeGroups when both match the same file', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/app.ts');
      await createFixture(cwd, 'src/app.test.ts');

      await expect(
        discoverFiles({
          cwd,
          exclude: ['**/*.test.ts'],
          includeGroups: ['tests'],
        }),
      ).resolves.toEqual(['src/app.ts']);
    });
  });

  test('discovers config files by default because the config group is off', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'src/app.ts');
      await createFixture(cwd, 'src/vite.config.ts');

      await expect(discoverFiles({ cwd })).resolves.toEqual([
        'src/app.ts',
        'src/vite.config.ts',
      ]);
    });
  });

  test('discovers migration files by default because the migrations group is off', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'migrations/001.ts');
      await createFixture(cwd, 'src/app.ts');

      await expect(discoverFiles({ cwd })).resolves.toEqual([
        'migrations/001.ts',
        'src/app.ts',
      ]);
    });
  });

  test('noDefaultExcludes removes soft excludes but keeps hard excludes', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'node_modules/dep/index.js');
      await createFixture(cwd, 'src/app.ts');
      await createFixture(cwd, 'src/app.test.ts');
      await createFixture(cwd, 'src/__tests__/helper.ts');

      await expect(
        discoverFiles({ cwd, noDefaultExcludes: true }),
      ).resolves.toEqual([
        'src/__tests__/helper.ts',
        'src/app.test.ts',
        'src/app.ts',
      ]);
    });
  });

  test('noDefaultExcludes with exclude applies only hard excludes and caller patterns', async () => {
    await withWorkspace('filemap-discover-', async (cwd) => {
      await createFixture(cwd, 'node_modules/dep/index.js');
      await createFixture(cwd, 'src/app.ts');
      await createFixture(cwd, 'src/app.test.ts');
      await createFixture(cwd, 'src/__tests__/helper.ts');

      await expect(
        discoverFiles({
          cwd,
          exclude: ['**/__tests__/**'],
          noDefaultExcludes: true,
        }),
      ).resolves.toEqual(['src/app.test.ts', 'src/app.ts']);
    });
  });
});
