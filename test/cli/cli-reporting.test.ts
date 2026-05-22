import { describe, expect, test } from 'vitest';

import type { MapEntry } from '@/pipeline/index.js';

import {
  type DiscoveryDebugSummary,
  getStrictValidationFailures,
  reportDiscoveryDebugSummary,
  reportStrictFailures,
} from '@/cli/cli-reporting.js';
import { toCwdPath } from '@/paths/brands.js';

describe('CLI reporting', () => {
  test('given no debug summary, when reporting discovery debug, then it writes nothing', () => {
    const stderr: string[] = [];

    reportDiscoveryDebugSummary(
      undefined,
      {
        writeStderr(message: string) {
          stderr.push(message);
        },
      },
      toCwdPath('/repo'),
    );

    expect(stderr).toEqual([]);
  });

  test('given one discovered file, when reporting discovery debug, then it uses the singular label', () => {
    const stderr: string[] = [];
    const summary: DiscoveryDebugSummary = {
      cwd: toCwdPath('/repo'),
      discoverOptions: {
        cwd: '/repo',
        include: ['/repo/src/**'],
      },
      resultCount: 1,
      timings: {
        discoveryMs: 2,
        mapBuildMs: 3,
      },
    };

    reportDiscoveryDebugSummary(
      summary,
      {
        writeStderr(message: string) {
          stderr.push(message);
        },
      },
      toCwdPath('/repo'),
    );

    expect(stderr.join('')).toContain('result: 1 file');
    expect(stderr.join('')).toContain('timing:');
    expect(stderr.join('')).toContain('include: <cwd>/src/**');
  });

  test('given strict mode is off, when checking entries, then it returns no failures', () => {
    const entries: readonly MapEntry[] = [
      {
        description: undefined,
        kind: 'file',
        path: 'src/app.ts',
      },
    ];

    expect(
      getStrictValidationFailures(entries, undefined, false, false),
    ).toEqual([]);
  });

  test('given described entries, when checking strict mode, then it returns no failures', () => {
    const entries: readonly MapEntry[] = [
      {
        description: 'App',
        kind: 'file',
        path: 'src/app.ts',
      },
      {
        description: 'Scripts',
        hiddenFileCount: 1,
        kind: 'directory',
        path: 'scripts',
      },
    ];

    expect(
      getStrictValidationFailures(entries, undefined, true, false),
    ).toEqual([]);
  });

  test('given strict failures, when reporting them, then each one is written as an error line', () => {
    const stderr: string[] = [];

    reportStrictFailures(['first failure', 'second failure'], {
      writeStderr(message: string) {
        stderr.push(message);
      },
    });

    expect(stderr).toEqual(['first failure\n', 'second failure\n']);
  });
});
