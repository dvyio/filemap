import { describe, expect, test } from 'vitest';

import { replacePathPrefix, resolveReadablePath } from '@/cli/path-prefix.js';

describe('CLI path prefix helpers', () => {
  test('given an empty prefix, when replacing a path prefix, then it returns undefined', () => {
    expect(replacePathPrefix('/repo/src/app.ts', '', '.')).toBeUndefined();
  });

  test('given an exact prefix match, when replacing a path prefix, then it returns the replacement', () => {
    expect(replacePathPrefix('/repo', '/repo', '.')).toBe('.');
  });

  test('given an unreadable path, when resolving it for display, then it falls back to the lexical path', () => {
    expect(resolveReadablePath('/tmp/filemap-missing-path-prefix-test')).toBe(
      '/tmp/filemap-missing-path-prefix-test',
    );
  });
});
