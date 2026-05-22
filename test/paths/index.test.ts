/** @fileoverview Tests shared cwd containment helpers */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, test } from 'vitest';

import {
  assertSafeGlobPatternString,
  assertSafeUserPathString,
  normalizePathInsideCwdLexically,
  normalizeRepoGlobPattern,
  type ResolvedPath,
  resolvePathFromCwd,
  toCwdPath,
  toRepoPath,
  toResolvedPath,
} from '@/paths/brands.js';
import { isRealPathInsideDirectory } from '@/paths/platform.js';
import { assertRealPathInsideCwd, normalizeRepoScope } from '@/paths/scope.js';

import { createFixture, withWorkspace } from '../helpers.js';

describe('normalizePathInsideCwdLexically', () => {
  test('given a POSIX child path, when normalizing, then returns a repo-relative path', () => {
    const cwd = toCwdPath('/repo/project');

    expect(normalizePathInsideCwdLexically('src/app.ts', cwd, 'path')).toBe(
      'src/app.ts',
    );
  });

  test('given a POSIX absolute path inside cwd, when normalizing, then returns a repo-relative path', () => {
    const cwd = toCwdPath('/repo/project');

    expect(
      normalizePathInsideCwdLexically('/repo/project/src/app.ts', cwd, 'path'),
    ).toBe('src/app.ts');
  });

  test('given a POSIX absolute path outside cwd, when normalizing, then rejects it', () => {
    const cwd = toCwdPath('/repo/project');

    expect(() =>
      normalizePathInsideCwdLexically('/repo/other/src/app.ts', cwd, 'path'),
    ).toThrow(
      `Invalid path "/repo/other/src/app.ts" — expected a path inside cwd "${cwd}".`,
    );
  });

  test('given spaces and Unicode, when normalizing, then keeps the path', () => {
    const cwd = toCwdPath('/repo/project');

    expect(
      normalizePathInsideCwdLexically('src/café file.ts', cwd, 'path'),
    ).toBe('src/café file.ts');
  });

  test('given NUL, when normalizing, then rejects it before resolving', () => {
    const cwd = toCwdPath('/repo/project');

    expect(() =>
      normalizePathInsideCwdLexically('src/bad\0file.ts', cwd, 'path'),
    ).toThrow(
      'Invalid path "src/bad\\u0000file.ts" — expected a path without control characters.',
    );
  });

  test('given an escape character, when normalizing, then rejects it before resolving', () => {
    const cwd = toCwdPath('/repo/project');

    expect(() =>
      normalizePathInsideCwdLexically('src/\u001bfile.ts', cwd, 'path'),
    ).toThrow(
      'Invalid path "src/\\u001bfile.ts" — expected a path without control characters.',
    );
  });

  test('given a Windows child path, when normalizing, then returns a POSIX repo-relative path', () => {
    const cwd = toCwdPath('C:\\repo\\project');

    expect(normalizePathInsideCwdLexically('src\\app.ts', cwd, 'path')).toBe(
      'src/app.ts',
    );
  });

  test('given a Windows absolute path inside cwd, when normalizing, then returns a POSIX repo-relative path', () => {
    const cwd = toCwdPath('C:\\repo\\project');

    expect(
      normalizePathInsideCwdLexically(
        'C:\\repo\\project\\src\\app.ts',
        cwd,
        'path',
      ),
    ).toBe('src/app.ts');
  });

  test('given a Windows absolute path outside cwd, when normalizing, then rejects it', () => {
    const cwd = toCwdPath('C:\\repo\\project');

    expect(() =>
      normalizePathInsideCwdLexically(
        'C:\\repo\\other\\src\\app.ts',
        cwd,
        'path',
      ),
    ).toThrow(
      `Invalid path "C:\\repo\\other\\src\\app.ts" — expected a path inside cwd "${cwd}".`,
    );
  });

  test('given Windows traversal outside cwd, when normalizing, then rejects it with the field and cwd', () => {
    const cwd = toCwdPath('C:\\repo\\project');

    expect(() =>
      normalizePathInsideCwdLexically('..\\secret.ts', cwd, 'path'),
    ).toThrow(
      `Invalid path "..\\secret.ts" — expected a path inside cwd "${cwd}".`,
    );
  });

  test('given direct traversal outside cwd, when normalizing, then rejects it with the field and cwd', () => {
    const cwd = toCwdPath('/repo/project');

    expect(() =>
      normalizePathInsideCwdLexically('../secret.ts', cwd, 'path'),
    ).toThrow(
      `Invalid path "../secret.ts" — expected a path inside cwd "${cwd}".`,
    );
  });

  test('given current directory, when normalizing, then rejects it as not a child path', () => {
    const cwd = toCwdPath('/repo/project');

    expect(() => normalizePathInsideCwdLexically('.', cwd, 'path')).toThrow(
      `Invalid path "." — expected a path inside cwd "${cwd}".`,
    );
  });
});

describe('toCwdPath', () => {
  test('given a relative cwd, when branding, then it rejects it', () => {
    expect(() => toCwdPath('src')).toThrow(
      'Invalid cwd "src" — expected an absolute path.',
    );
  });

  test('given a Windows absolute cwd, when branding, then it accepts it', () => {
    expect(toCwdPath('C:\\repo\\project')).toBe('C:\\repo\\project');
  });
});

describe('toResolvedPath', () => {
  test('given a relative path, when branding a resolved path, then it rejects it', () => {
    expect(() => toResolvedPath('src/app.ts', 'resolvedPath')).toThrow(
      'Invalid resolvedPath "src/app.ts" — expected an absolute path.',
    );
  });

  test('given a Windows absolute path, when branding a resolved path, then it accepts it', () => {
    expect(
      toResolvedPath('C:\\repo\\project\\src\\app.ts', 'resolvedPath'),
    ).toBe('C:\\repo\\project\\src\\app.ts');
  });
});

describe('toRepoPath', () => {
  test('given a parent-escaping path, when branding, then it rejects it', () => {
    expect(() => toRepoPath('../secret.ts', 'filePath')).toThrow(
      'Invalid filePath "../secret.ts" — expected a repo-relative path.',
    );
  });
});

describe('assertSafeUserPathString', () => {
  test.each([
    ['newline', 'bad\npath.md', 'bad\\u000apath.md'],
    ['carriage return', 'bad\rpath.md', 'bad\\u000dpath.md'],
    ['tab', 'bad\tpath.md', 'bad\\u0009path.md'],
    ['DEL', 'bad\u007fpath.md', 'bad\\u007fpath.md'],
    ['NUL', 'bad\0path.md', 'bad\\u0000path.md'],
  ])(
    'given a path with %s, when checking safety, then rejects it with an escaped value',
    (_name, value, escapedValue) => {
      expect(() => assertSafeUserPathString(value, 'path')).toThrow(
        `Invalid path "${escapedValue}" — expected a path without control characters.`,
      );
    },
  );

  test('given a path with Unicode format controls, when checking safety, then rejects it with an escaped value', () => {
    expect(() => assertSafeUserPathString('bad\u202epath.md', 'path')).toThrow(
      'Invalid path "bad\\u202epath.md" — expected a path without Unicode format characters.',
    );
  });
});

describe('assertSafeGlobPatternString', () => {
  test.each([
    ['newline', 'src/\n*.ts', 'src/\\u000a*.ts'],
    ['carriage return', 'src/\r*.ts', 'src/\\u000d*.ts'],
    ['tab', 'src/\t*.ts', 'src/\\u0009*.ts'],
    ['DEL', 'src/\u007f*.ts', 'src/\\u007f*.ts'],
    ['NUL', 'src/\0*.ts', 'src/\\u0000*.ts'],
  ])(
    'given a glob with %s, when checking safety, then rejects it with an escaped value',
    (_name, value, escapedValue) => {
      expect(() =>
        assertSafeGlobPatternString(value, 'include pattern'),
      ).toThrow(
        `Invalid include pattern "${escapedValue}" — expected a glob pattern without control characters.`,
      );
    },
  );

  test('given a glob with Unicode format controls, when checking safety, then rejects it with an escaped value', () => {
    expect(() =>
      assertSafeGlobPatternString('src/\u202e*.ts', 'include pattern'),
    ).toThrow(
      'Invalid include pattern "src/\\u202e*.ts" — expected a glob pattern without Unicode format characters.',
    );
  });
});

describe('normalizeRepoGlobPattern', () => {
  test.each([
    ['**/*.test.ts', '**/*.test.ts'],
    [' src/** ', 'src/**'],
    ['././src/**', 'src/**'],
    ['{src,lib}/**/*.ts', '{src,lib}/**/*.ts'],
  ])(
    'given valid glob %s, when normalizing, then returns %s',
    (pattern, expected) => {
      expect(
        normalizeRepoGlobPattern(
          pattern,
          'include pattern',
          'a repo-relative glob pattern',
        ),
      ).toBe(expected);
    },
  );

  test.each(['../x/**', 'foo/../../x/**', '*/../x/**'])(
    'given escaping glob %s, when normalizing, then rejects it',
    (pattern) => {
      expect(() =>
        normalizeRepoGlobPattern(
          pattern,
          'include pattern',
          'a repo-relative glob pattern',
        ),
      ).toThrow(
        `Invalid include pattern "${pattern}" — expected a repo-relative glob pattern.`,
      );
    },
  );

  test('given a Windows absolute glob, when normalizing, then rejects it', () => {
    expect(() =>
      normalizeRepoGlobPattern(
        'C:\\repo\\project\\src\\**',
        'include pattern',
        'a repo-relative glob pattern',
      ),
    ).toThrow(
      'Invalid include pattern "C:\\repo\\project\\src\\**" — expected a repo-relative glob pattern.',
    );
  });
});

describe('normalizeRepoScope', () => {
  test('given NUL, when normalizing, then rejects it before matching paths', () => {
    expect(() => normalizeRepoScope('src\0auth')).toThrow(
      'Invalid scope "src\\u0000auth" — expected a path without control characters.',
    );
  });

  test.each([
    ['.', '.'],
    ['./', '.'],
    ['./.', '.'],
    ['src/auth', 'src/auth'],
    ['./src/auth/', 'src/auth'],
  ])('given scope %s, when normalizing, then returns %s', (scope, expected) => {
    expect(normalizeRepoScope(scope)).toBe(expected);
  });

  test.each(['/', '///', '/repo/project/src', 'C:\\repo\\project\\src'])(
    'given absolute-looking scope %s, when normalizing, then rejects it',
    (scope) => {
      expect(() => normalizeRepoScope(scope)).toThrow(
        `Invalid scope "${scope}" — expected "." for the repository root or a relative child path.`,
      );
    },
  );

  test('given scope resolves back to root through a parent segment, when normalizing, then rejects it', () => {
    expect(() => normalizeRepoScope('src/..')).toThrow(
      'Invalid scope "src/.." — expected "." for the repository root or a relative child path.',
    );
  });

  test.each(['../secret', 'src/../../secret'])(
    'given parent traversal scope %s, when normalizing, then rejects it before branding',
    (scope) => {
      expect(() => normalizeRepoScope(scope)).toThrow(
        `Invalid scope "${scope}" — expected "." for the repository root or a relative child path.`,
      );
    },
  );
});

describe('isRealPathInsideDirectory', () => {
  test('given a POSIX real path inside cwd, when checking containment, then it passes', () => {
    expect(
      isRealPathInsideDirectory('/repo/project', '/repo/project/src/app.ts'),
    ).toBe(true);
  });

  test('given a POSIX real path outside cwd, when checking containment, then it fails', () => {
    expect(
      isRealPathInsideDirectory('/repo/project', '/repo/outside/app.ts'),
    ).toBe(false);
  });

  test('given a Windows real path inside cwd, when checking containment, then it passes', () => {
    expect(
      isRealPathInsideDirectory(
        'C:\\repo\\project',
        'C:\\repo\\project\\src\\app.ts',
      ),
    ).toBe(true);
  });

  test('given a Windows real path outside cwd, when checking containment, then it fails', () => {
    expect(
      isRealPathInsideDirectory(
        'C:\\repo\\project',
        'C:\\repo\\outside\\app.ts',
      ),
    ).toBe(false);
  });

  test('given a Windows sibling prefix, when checking containment, then it fails', () => {
    expect(
      isRealPathInsideDirectory(
        'C:\\repo\\project',
        'C:\\repo\\project-old\\app.ts',
      ),
    ).toBe(false);
  });

  test('given cwd itself, when checking containment, then it passes', () => {
    expect(isRealPathInsideDirectory('/repo/project', '/repo/project')).toBe(
      true,
    );
  });
});

describe('assertRealPathInsideCwd', () => {
  test('given resolved path options, when typechecking, then resolvedPath must be branded', () => {
    type ResolvedPathOption = Parameters<
      typeof assertRealPathInsideCwd
    >[0]['resolvedPath'];

    expectTypeOf<ResolvedPathOption>().toEqualTypeOf<ResolvedPath>();

    const repoRelativePathIsRejected: 'src/app.ts' extends ResolvedPathOption
      ? false
      : true = true;

    expect(repoRelativePathIsRejected).toBe(true);
  });

  test('given a path inside cwd, when resolving real paths, then it passes', async () => {
    await withWorkspace('filemap-paths-', async (cwd) => {
      await createFixture(cwd, 'src/app.ts');

      const workingDirectory = toCwdPath(cwd);

      await expect(
        assertRealPathInsideCwd({
          cwd: workingDirectory,
          expectedKind: 'file',
          fieldName: 'path',
          originalPath: 'src/app.ts',
          resolvedPath: resolvePathFromCwd(workingDirectory, 'src/app.ts'),
        }),
      ).resolves.toBeUndefined();
    });
  });

  test('given an existing directory but a file is expected, when resolving real paths, then it rejects the kind', async () => {
    await withWorkspace('filemap-paths-', async (cwd) => {
      await mkdir(join(cwd, 'docs'));
      const workingDirectory = toCwdPath(cwd);

      await expect(
        assertRealPathInsideCwd({
          cwd: workingDirectory,
          expectedKind: 'file',
          fieldName: 'path',
          originalPath: 'docs',
          resolvedPath: resolvePathFromCwd(workingDirectory, 'docs'),
        }),
      ).rejects.toThrow('Invalid path "docs" — expected an existing file.');
    });
  });

  test('given resolved path is missing, when resolving real paths, then it passes without kind checks', async () => {
    await withWorkspace('filemap-paths-', async (cwd) => {
      const workingDirectory = toCwdPath(cwd);

      await expect(
        assertRealPathInsideCwd({
          cwd: workingDirectory,
          expectedKind: 'file',
          fieldName: 'path',
          originalPath: 'missing.ts',
          resolvedPath: resolvePathFromCwd(workingDirectory, 'missing.ts'),
        }),
      ).resolves.toBeUndefined();
    });
  });
});
