/** @fileoverview Defines shared types for file discovery planning */

import { type CwdPath, type RepoGlob, type RepoPath } from '@/paths/brands.js';
import { type ExistingRepoScope } from '@/paths/scope.js';
import { type MaxFiles } from '@/shared/max-files.js';

declare const extensionBrand: unique symbol;

export type Extension = {
  readonly [extensionBrand]: 'Extension';
} & string;

export interface DiscoverFilesOptions {
  readonly cwd?: string | undefined;
  readonly exclude?: readonly string[] | undefined;
  readonly excludeGroups?: readonly string[] | undefined;
  readonly ext?: readonly string[] | undefined;
  readonly include?: readonly string[] | undefined;
  readonly includeGroups?: readonly string[] | undefined;
  readonly maxFiles?: MaxFiles | undefined;
  readonly noDefaultExcludes?: boolean | undefined;
  readonly scope?: string | undefined;
}

export interface PreparedDiscoveryOptions {
  readonly excludeGlobs: readonly RepoGlob[];
  readonly excludeGroups: readonly string[];
  readonly extensions: readonly Extension[] | undefined;
  readonly includeGlobs: readonly RepoGlob[];
  readonly includeGroups: readonly string[];
  readonly maxFiles: MaxFiles;
  readonly noDefaultExcludes: boolean;
  readonly scope: ExistingRepoScope;
  readonly workingDirectory: CwdPath;
}

export interface DiscoveryPlan {
  readonly explicitExcludePatterns: readonly RepoGlob[];
  readonly hardExcludePatterns: readonly RepoGlob[];
  readonly hasRescues: boolean;
  readonly includePatterns: readonly RepoGlob[];
  readonly rescuePatterns: readonly RepoGlob[];
  readonly softExcludePatterns: readonly RepoGlob[];
  readonly walkDirectory: '' | RepoPath;
}
