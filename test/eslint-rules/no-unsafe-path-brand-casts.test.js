import typescriptParser from '@typescript-eslint/parser';
import { RuleTester } from 'eslint';
import { describe, test } from 'vitest';

import noUnsafePathBrandCasts from '../../eslint-rules/no-unsafe-path-brand-casts.js';

const TEST_PROJECT_ROOT = process.cwd();
const unsafePathBrandCast = { messageId: 'unsafePathBrandCast' };

RuleTester.describe = describe;
RuleTester.it = test;
RuleTester.itOnly = test.only;
RuleTester.setDefaultConfig({
  languageOptions: {
    ecmaVersion: 2024,
    parser: typescriptParser,
    sourceType: 'module',
  },
});

new RuleTester().run('no-unsafe-path-brand-casts', noUnsafePathBrandCasts, {
  invalid: [
    {
      code: 'const scope = value as RepoScope;',
      errors: [unsafePathBrandCast],
      filename: `${TEST_PROJECT_ROOT}/src/discovery/index.ts`,
    },
    {
      code: 'const repoPath = <RepoPath>value;',
      errors: [unsafePathBrandCast],
      filename: `${TEST_PROJECT_ROOT}/src/pipeline/index.ts`,
    },
    {
      code: 'const resolvedPath = value as ResolvedPath;',
      errors: [unsafePathBrandCast],
      filename: `${TEST_PROJECT_ROOT}/src/pipeline/index.ts`,
    },
    {
      code: 'const depth = value as Depth;',
      errors: [unsafePathBrandCast],
      filename: `${TEST_PROJECT_ROOT}/src/pipeline/index.ts`,
    },
    {
      code: 'const maxFiles = value as MaxFiles;',
      errors: [unsafePathBrandCast],
      filename: `${TEST_PROJECT_ROOT}/src/discovery/index.ts`,
    },
    {
      code: 'const extension = value as Extension;',
      errors: [unsafePathBrandCast],
      filename: `${TEST_PROJECT_ROOT}/src/discovery/index.ts`,
    },
    {
      code: 'const tag = value as OverviewTag;',
      errors: [unsafePathBrandCast],
      filename: `${TEST_PROJECT_ROOT}/src/pipeline/index.ts`,
    },
    {
      code: 'const cwd = value as CwdPath;',
      errors: [unsafePathBrandCast],
      filename: `${TEST_PROJECT_ROOT}/src/shared/defaults.ts`,
    },
    {
      code: 'const glob = value as RepoGlob;',
      errors: [unsafePathBrandCast],
      filename: `${TEST_PROJECT_ROOT}/src/discovery/index.ts`,
    },
    {
      code: 'const path = value as Domain.RepoPath;',
      errors: [unsafePathBrandCast],
      filename: `${TEST_PROJECT_ROOT}/src/discovery/index.ts`,
    },
    {
      code: 'const path = value as RepoPath | undefined;',
      errors: [unsafePathBrandCast],
      filename: `${TEST_PROJECT_ROOT}/src/discovery/index.ts`,
    },
    {
      code: 'const paths = value as Array<RepoPath>;',
      errors: [unsafePathBrandCast],
      filename: `${TEST_PROJECT_ROOT}/src/discovery/index.ts`,
    },
    {
      code: 'const paths = value as readonly RepoPath[];',
      errors: [unsafePathBrandCast],
      filename: `${TEST_PROJECT_ROOT}/src/discovery/index.ts`,
    },
    {
      code: 'const entry = value as { path: RepoPath };',
      errors: [unsafePathBrandCast],
      filename: `${TEST_PROJECT_ROOT}/src/discovery/index.ts`,
    },
  ],
  valid: [
    {
      code: 'const scope = value as RepoScope;',
      filename: `${TEST_PROJECT_ROOT}/src/paths/scope.ts`,
    },
    {
      code: 'const repoPath = value as RepoPath;',
      filename: `${TEST_PROJECT_ROOT}/src/paths/brands.ts`,
    },
    {
      code: 'const path = value as RepoPath | undefined;',
      filename: `${TEST_PROJECT_ROOT}/src/paths/brands.ts`,
    },
    {
      code: 'const depth = value as Depth;',
      filename: `${TEST_PROJECT_ROOT}/src/pipeline/depth.ts`,
    },
    {
      code: 'const maxFiles = value as MaxFiles;',
      filename: `${TEST_PROJECT_ROOT}/src/shared/max-files.ts`,
    },
    {
      code: 'const extension = value as Extension;',
      filename: `${TEST_PROJECT_ROOT}/src/discovery/pattern-validation.ts`,
    },
    {
      code: 'const tag = value as OverviewTag;',
      filename: `${TEST_PROJECT_ROOT}/src/pipeline/tag.ts`,
    },
    {
      code: 'const scope = normalizeRepoScope(value);',
      filename: `${TEST_PROJECT_ROOT}/src/discovery/index.ts`,
    },
    {
      code: 'const value = rawValue as UserId;',
      filename: `${TEST_PROJECT_ROOT}/src/discovery/index.ts`,
    },
    {
      code: 'const path = value as string;',
      filename: `${TEST_PROJECT_ROOT}/src/discovery/index.ts`,
    },
    {
      code: 'const paths = value as string[];',
      filename: `${TEST_PROJECT_ROOT}/src/discovery/index.ts`,
    },
    {
      code: 'const path = value as RepoPath;',
      filename: '<input>',
    },
    {
      code: 'const path = value as RepoPath;',
      filename: `${TEST_PROJECT_ROOT}/scripts/example.ts`,
    },
    {
      code: 'const path = value as RepoPath;',
      filename: `${TEST_PROJECT_ROOT}/test/helpers.ts`,
    },
    'const path = value as RepoPath;',
  ],
});
