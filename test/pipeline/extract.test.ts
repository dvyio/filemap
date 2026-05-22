import { open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { extractFileoverviewFromHandle } from '@/pipeline/read-file.js';

import { createFixture, withWorkspace } from '../helpers.js';

const FILEOVERVIEW_SCAN_LIMIT_BYTES = 64 * 1024;
const FILLER_LINE = 'const filler = true;\n';

function buildFillerLines(lineCount: number): string {
  return FILLER_LINE.repeat(lineCount);
}

describe('extractFileoverviewFromHandle', () => {
  test('extracts from a single-line JSDoc comment', async () => {
    await expectDescription(
      '/** @fileoverview Handles user authentication */\nexport class Auth {}\n',
      'Handles user authentication',
      'auth.ts',
    );
  });

  test('given the default tags are reused, when extracting twice, then each read starts at the file beginning', async () => {
    await withWorkspace('filemap-extract-', async (cwd) => {
      await createFixture(
        cwd,
        'first.ts',
        '/** @fileoverview First file */\nexport const first = true;\n',
      );
      await createFixture(
        cwd,
        'second.ts',
        '/** @fileoverview Second file */\nexport const second = true;\n',
      );

      await expectFileDescription(join(cwd, 'first.ts'), 'First file');
      await expectFileDescription(join(cwd, 'second.ts'), 'Second file');
    });
  });

  test('escapes non-whitespace control characters in descriptions', async () => {
    await expectDescription(
      '/** @fileoverview Red \u001b[31m text\u007f */\nexport const app = true;\n',
      'Red \\u001b[31m text\\u007f',
      'control-description.ts',
    );
  });

  test('escapes Unicode format controls in descriptions', async () => {
    await expectDescription(
      '/** @fileoverview Safe \u202etext */\nexport const app = true;\n',
      'Safe \\u202etext',
      'unicode-format-description.ts',
    );
  });

  test('rejects an overview block that contains invalid UTF-8', async () => {
    await withWorkspace('filemap-extract-', async (cwd) => {
      const fileName = 'invalid-utf8.ts';
      const filePath = join(cwd, fileName);
      const invalidSource = Buffer.concat([
        Buffer.from('/** @fileoverview Broken '),
        Buffer.from([0xff]),
        Buffer.from(' */\nexport const app = true;\n'),
      ]);

      await createFixture(cwd, fileName);
      await writeFile(filePath, invalidSource);

      const fileHandle = await open(filePath, 'r');

      try {
        await expect(extractFileoverviewFromHandle(fileHandle)).rejects.toThrow(
          'Invalid source overview text — expected valid UTF-8 text; save the file as UTF-8 or remove invalid bytes.',
        );
      } finally {
        await fileHandle.close();
      }
    });
  });

  test('collapses newlines and tabs in descriptions', async () => {
    await expectDescription(
      [
        '/**',
        ' * @fileoverview Handles\tuser',
        ' * authentication',
        ' */',
        'export const auth = true;',
        '',
      ].join('\n'),
      'Handles user authentication',
      'description-whitespace.ts',
    );
  });

  test('extracts an early overview from a large file', async () => {
    await expectDescription(
      [
        [
          '/** @fileoverview Handles large source files */',
          'export const value = 1;',
          'const ignored = true;',
          '',
        ].join('\n'),
        buildFillerLines(5_000),
      ].join(''),
      'Handles large source files',
      'large-early.ts',
    );
  });

  test('extracts an overview inside the first chunk', async () => {
    await expectDescription(
      '/** @fileoverview Handles first chunk */\nexport const value = 1;\n',
      'Handles first chunk',
      'first-chunk.ts',
    );
  });

  test('extracts an overview after the first chunk', async () => {
    await expectDescription(
      [
        buildFillerLines(100),
        '/** @fileoverview Handles second chunk */\n',
      ].join(''),
      'Handles second chunk',
      'second-chunk.ts',
    );
  });

  test('extracts an overview after several chunks', async () => {
    await expectDescription(
      [
        buildFillerLines(600),
        '/** @fileoverview Handles later chunks */\n',
      ].join(''),
      'Handles later chunks',
      'later-chunks.ts',
    );
  });

  test('preserves a multiline block description across a chunk boundary', async () => {
    const longDescription = 'A'.repeat(980);

    await expectDescription(
      [
        '/**',
        ` * @fileoverview ${longDescription}`,
        ' * across chunk boundary',
        ' */',
        'export const value = 1;',
        '',
      ].join('\n'),
      `${longDescription} across chunk boundary`,
      'block-boundary.ts',
    );
  });

  test('preserves a line comment description across a chunk boundary', async () => {
    const longDescription = 'A'.repeat(1_000);

    await expectDescription(
      [
        `// @fileoverview ${longDescription}`,
        '// across chunk boundary',
        'export const value = 1;',
        '',
      ].join('\n'),
      `${longDescription} across chunk boundary`,
      'line-boundary.ts',
    );
  });

  test('preserves a line comment description when the chunk ends after the continuation prefix', async () => {
    const firstLineStart = '// @fileoverview ';
    const firstLineDescription = 'A'.repeat(
      1024 - Buffer.byteLength(firstLineStart) - Buffer.byteLength('\n// '),
    );

    await expectDescription(
      [
        `${firstLineStart}${firstLineDescription}`,
        '// across prefix boundary',
        'export const value = 1;',
        '',
      ].join('\n'),
      `${firstLineDescription} across prefix boundary`,
      'line-prefix-boundary.ts',
    );
  });

  test('preserves a hash comment description when the chunk ends after the continuation prefix', async () => {
    const firstLineStart = '# @fileoverview ';
    const firstLineDescription = 'A'.repeat(
      1024 - Buffer.byteLength(firstLineStart) - Buffer.byteLength('\n# '),
    );

    await expectDescription(
      [
        `${firstLineStart}${firstLineDescription}`,
        '# across prefix boundary',
        'import os',
        '',
      ].join('\n'),
      `${firstLineDescription} across prefix boundary`,
      'hash-prefix-boundary.py',
    );
  });

  test('preserves a multibyte description character split across a chunk boundary', async () => {
    const firstLineStart = '// @fileoverview ';
    const firstLineDescription = 'A'.repeat(
      1023 - Buffer.byteLength(firstLineStart),
    );

    await expectDescription(
      `${firstLineStart}${firstLineDescription}€ across byte boundary\n`,
      `${firstLineDescription}€ across byte boundary`,
      'utf8-boundary.ts',
    );
  });

  test('preserves an HTML comment description across a chunk boundary', async () => {
    const longDescription = 'A'.repeat(990);

    await expectDescription(
      [
        '<!--',
        `  @fileoverview ${longDescription}`,
        '  across chunk boundary',
        '-->',
        '# Notes',
        '',
      ].join('\n'),
      `${longDescription} across chunk boundary`,
      'html-boundary.md',
    );
  });

  test('ignores overview tags after the scan limit', async () => {
    await expectDescription(
      [
        buildFillerLines(5_000),
        '/** @fileoverview This tag is too deep */\n',
      ].join(''),
      undefined,
      'large-late.ts',
    );
  });

  test('extracts an incomplete block description at the scan limit', async () => {
    const opening = '/** @fileoverview Partial overview\n';
    const visibleFiller = ' '.repeat(
      FILEOVERVIEW_SCAN_LIMIT_BYTES - Buffer.byteLength(opening),
    );

    await expectDescription(
      `${opening}${visibleFiller}\n*/\n`,
      'Partial overview',
      'truncated-block.ts',
    );
  });

  test('extracts a complete block description before the scan limit', async () => {
    const comment = '/** @fileoverview Complete overview */\n';
    const filler = 'A'.repeat(
      FILEOVERVIEW_SCAN_LIMIT_BYTES - Buffer.byteLength(comment),
    );

    await expectDescription(
      `${comment}${filler}`,
      'Complete overview',
      'complete-before-limit.ts',
    );
  });

  test('extracts a final line comment at EOF before the scan limit', async () => {
    await expectDescription(
      '// @fileoverview Final line overview',
      'Final line overview',
      'final-line.ts',
    );
  });

  test('stops a one-line block description at the closing token', async () => {
    await expectDescription(
      '/** @fileoverview App */ const x = 1;\n',
      'App',
      'one-line-with-code.ts',
    );
  });

  test('extracts from a multi-line JSDoc comment and collapses it to one line', async () => {
    await expectDescription(
      [
        '/**',
        ' * @fileoverview Handles user authentication',
        ' * across multiple identity providers',
        ' */',
        'export class Auth {}',
        '',
      ].join('\n'),
      'Handles user authentication across multiple identity providers',
      'auth.ts',
    );
  });

  test('stops a multiline block description at the first closing token', async () => {
    await expectDescription(
      [
        '/**',
        ' * @fileoverview App',
        ' * closes here */ const x = 1;',
        ' * ignored after close',
        ' */',
        '',
      ].join('\n'),
      'App closes here',
      'multiline-close-with-code.ts',
    );
  });

  test('extracts from a hash comment', async () => {
    await expectDescription(
      '# @fileoverview Handles background jobs\nimport os\n',
      'Handles background jobs',
      'jobs.py',
    );
  });

  test('extracts from a slash comment', async () => {
    await expectDescription(
      '// @fileoverview Handles session refresh\nconst refresh = true;\n',
      'Handles session refresh',
      'refresh.ts',
    );
  });

  test('extracts from a one-line HTML comment', async () => {
    await expectDescription(
      '<!-- @fileoverview Handles markdown docs -->\n# Notes\n',
      'Handles markdown docs',
      'notes.md',
    );
  });

  test('extracts from an indented one-line HTML comment', async () => {
    await expectDescription(
      '  <!-- @fileoverview Handles indented markdown docs -->\n# Notes\n',
      'Handles indented markdown docs',
      'indented-notes.md',
    );
  });

  test('extracts from a multiline HTML comment', async () => {
    await expectDescription(
      [
        '<!--',
        '  @fileoverview Handles markdown docs',
        '  across multiple sections',
        '-->',
        '# Notes',
        '',
      ].join('\n'),
      'Handles markdown docs across multiple sections',
      'multiline-notes.md',
    );
  });

  test('extracts from an indented multiline HTML comment', async () => {
    await expectDescription(
      [
        '  <!--',
        '    @fileoverview Handles indented markdown docs',
        '    across multiple sections',
        '  -->',
        '# Notes',
        '',
      ].join('\n'),
      'Handles indented markdown docs across multiple sections',
      'indented-multiline-notes.md',
    );
  });

  test('returns undefined when no tag is present', async () => {
    await expectDescription(
      'export const value = 1;\n// just a comment\n',
      undefined,
      'value.ts',
    );
  });

  test('returns only the first match when multiple tags exist', async () => {
    await expectDescription(
      [
        '/** @fileoverview First description */',
        '// @fileoverview Second description',
        'export const value = 1;',
        '',
      ].join('\n'),
      'First description',
      'multi.ts',
    );
  });

  test('extracts @file as a default overview tag', async () => {
    await expectDescription(
      '/** @file Handles routing */\nexport const router = true;\n',
      'Handles routing',
      'file-alias.ts',
    );
  });

  test('extracts @overview as a default overview tag', async () => {
    await expectDescription(
      '/** @overview Handles routing */\nexport const router = true;\n',
      'Handles routing',
      'overview-alias.ts',
    );
  });

  test('returns the first default overview tag in file order', async () => {
    await expectDescription(
      [
        '// @overview First description',
        '/** @fileoverview Second description */',
        '// @file Third description',
        'export const value = 1;',
        '',
      ].join('\n'),
      'First description',
      'mixed-aliases.ts',
    );
  });

  test('strips leading stars and extra whitespace from continuation lines', async () => {
    await expectDescription(
      [
        '/**',
        ' * @fileoverview Line one',
        ' *   Line two with leading spaces',
        ' *  Line three',
        ' */',
        '',
      ].join('\n'),
      'Line one Line two with leading spaces Line three',
      'lines.ts',
    );
  });

  test('returns undefined when @fileoverview has no description text', async () => {
    await expectDescription(
      '/** @fileoverview */\nexport const value = 1;\n',
      undefined,
      'empty.ts',
    );
  });

  test('extracts a custom tag when one is provided', async () => {
    await expectDescription(
      '/** @overview Handles routing */\nexport const router = true;\n',
      'Handles routing',
      'routes.ts',
      '@overview',
    );
  });

  test('trims accidental whitespace from custom tags', async () => {
    await expectDescription(
      '/** @overview Handles routing */\nexport const router = true;\n',
      'Handles routing',
      'routes.ts',
      ' @overview ',
    );
  });

  test('rejects a custom tag without an at sign', async () => {
    await expectExtractionFailure(
      '/** @fileoverview Wrong tag */\n',
      'invalid.ts',
      'overview',
      'Invalid tag "overview" — expected a tag like "@fileoverview" using letters, numbers, underscores, or hyphens.',
    );
  });

  test('rejects a custom tag with Unicode format controls using an escaped error value', async () => {
    await expectExtractionFailure(
      '/** @fileoverview Wrong tag */\n',
      'unicode-invalid.ts',
      '@file\u202eoverview',
      'Invalid tag "@file\\u202eoverview" — expected a tag like "@fileoverview" using letters, numbers, underscores, or hyphens.',
    );
  });

  test('does not match an extended tag as the default tag', async () => {
    await expectDescription(
      '/** @fileoverview-extra Handles routing */\nexport const router = true;\n',
      undefined,
      'extended-default.ts',
    );
  });

  test('does not treat a colon suffix as a default tag delimiter', async () => {
    await expectDescription(
      '// @fileoverview: Handles routing\nexport const router = true;\n',
      undefined,
      'colon-suffix.ts',
    );
  });

  test('extracts an extended tag when it is configured exactly', async () => {
    await expectDescription(
      '/** @fileoverview-extra Handles routing */\nexport const router = true;\n',
      'Handles routing',
      'extended-custom.ts',
      '@fileoverview-extra',
    );
  });

  test('ignores @fileoverview when a different custom tag is requested', async () => {
    await expectDescription(
      [
        '/** @fileoverview Default description */',
        '// @overview Custom description',
        'export const value = 1;',
        '',
      ].join('\n'),
      'Custom description',
      'custom-tag.ts',
      '@overview',
    );
  });

  test('ignores default overview tags when a custom tag is requested', async () => {
    await expectDescription(
      [
        '/** @fileoverview Default description */',
        '// @file Short default description',
        '# @overview General default description',
        'export const value = 1;',
        '',
      ].join('\n'),
      undefined,
      'custom-only.ts',
      '@custom',
    );
  });

  test('rejects an empty custom tag', async () => {
    await expectExtractionFailure(
      '/** @fileoverview Valid description */\n',
      'empty-invalid.ts',
      '',
      'Invalid tag "" — expected a tag like "@fileoverview" using letters, numbers, underscores, or hyphens.',
    );
  });

  test('stops before later docblock annotations', async () => {
    await expectDescription(
      [
        '/**',
        ' * @fileoverview Handles auth state',
        ' * across page loads',
        ' * @param token - auth token',
        ' */',
        'export const value = 1;',
        '',
      ].join('\n'),
      'Handles auth state across page loads',
      'annotation.ts',
    );
  });

  test('preserves multiline descriptions across blank docblock lines', async () => {
    await expectDescription(
      [
        '/**',
        ' * @fileoverview First paragraph',
        ' *',
        ' * Second paragraph',
        ' */',
        'export const value = 1;',
        '',
      ].join('\n'),
      'First paragraph Second paragraph',
      'blank-line.ts',
    );
  });

  test('collects continuation lines from // comments', async () => {
    await expectDescription(
      '// @fileoverview Handles auth\n// and session management\nconst x = 1;\n',
      'Handles auth and session management',
      'line-comment.ts',
    );
  });

  test('collects continuation lines from # comments', async () => {
    await expectDescription(
      '# @fileoverview Handles auth\n# and session management\nimport os\n',
      'Handles auth and session management',
      'hash-comment.py',
    );
  });

  test('collects block comment continuation without leading star', async () => {
    await expectDescription(
      '/* @fileoverview\n   Handles auth and sessions\n*/\n',
      'Handles auth and sessions',
      'block-no-star.ts',
    );
  });

  test('ignores a tag after a closed block comment on the same line', async () => {
    await expectDescription(
      '/* old */ const x = "@fileoverview fake";\n',
      undefined,
      'closed-block-string.ts',
    );
  });

  test('ignores an unquoted tag after a closed block comment on the same line', async () => {
    await expectDescription(
      '/* old */ const x = @fileoverview fake;\n',
      undefined,
      'closed-block-code.ts',
    );
  });

  test('skips tag inside string literal and finds comment match', async () => {
    await expectDescription(
      'const x = "@fileoverview";\n/** @fileoverview Real description */\n',
      'Real description',
      'string-literal.ts',
    );
  });

  test('skips an early string literal and finds a later comment match', async () => {
    await expectDescription(
      [
        'const text = "@fileoverview";',
        'const filler = true;'.repeat(120),
        '/** @fileoverview Real later description */',
        '',
      ].join('\n'),
      'Real later description',
      'early-string-later-comment.ts',
    );
  });

  test('skips tag inside string literal before a // comment match', async () => {
    await expectDescription(
      'const x = "@fileoverview foo";\n// @fileoverview Real description\n',
      'Real description',
      'string-then-line.ts',
    );
  });

  test('stops // continuation at a non-// line', async () => {
    await expectDescription(
      '// @fileoverview First\n// Second\nconst x = 1;\n// Unrelated\n',
      'First Second',
      'stop-at-code.ts',
    );
  });

  test('stops // continuation at next @-annotation', async () => {
    await expectDescription(
      '// @fileoverview Handles auth\n// @param token - the token\n// more\n',
      'Handles auth',
      'stop-at-annotation.ts',
    );
  });

  test('stops # continuation at blank line', async () => {
    await expectDescription(
      '# @fileoverview Handles auth\n# and sessions\n\n# Unrelated\n',
      'Handles auth and sessions',
      'stop-at-blank.py',
    );
  });

  test('collects continuation lines from /// doc comments', async () => {
    await expectDescription(
      '/// @fileoverview Handles auth\n/// and session management\nfn main() {}\n',
      'Handles auth and session management',
      'doc-comment.rs',
    );
  });

  test('collects continuation lines from //! inner doc comments', async () => {
    await expectDescription(
      '//! @fileoverview Handles auth\n//! and session management\nfn main() {}\n',
      'Handles auth and session management',
      'inner-doc.rs',
    );
  });

  test('does not mix /// and // continuation lines', async () => {
    await expectDescription(
      '/// @fileoverview Handles auth\n// not part of doc comment\n',
      'Handles auth',
      'mixed-prefix.rs',
    );
  });

  test('given a complete early overview, when extracting, then it returns the description', async () => {
    await withWorkspace('filemap-extract-', async (cwd) => {
      const fileName = 'mocked-early-overview.ts';
      const filePath = join(cwd, fileName);

      await createFixture(
        cwd,
        fileName,
        [
          '/** @fileoverview Handles early file content */\n',
          buildFillerLines(5_000),
        ].join(''),
      );

      const fileHandle = await open(filePath, 'r');

      try {
        await expect(extractFileoverviewFromHandle(fileHandle)).resolves.toBe(
          'Handles early file content',
        );
      } finally {
        await fileHandle.close();
      }
    });
  });
});

async function expectDescription(
  contents: string,
  expected: string | undefined,
  fileName: string,
  tag?: string,
): Promise<void> {
  await withWorkspace('filemap-extract-', async (cwd) => {
    const filePath = join(cwd, fileName);

    await createFixture(cwd, fileName, contents);
    const fileHandle = await open(filePath, 'r');

    try {
      await expect(
        extractFileoverviewFromHandle(fileHandle, tag),
      ).resolves.toBe(expected);
    } finally {
      await fileHandle.close();
    }
  });
}

async function expectFileDescription(
  filePath: string,
  expected: string | undefined,
): Promise<void> {
  const fileHandle = await open(filePath, 'r');

  try {
    await expect(extractFileoverviewFromHandle(fileHandle)).resolves.toBe(
      expected,
    );
  } finally {
    await fileHandle.close();
  }
}

async function expectExtractionFailure(
  contents: string,
  fileName: string,
  tag: string,
  expectedMessage: string,
): Promise<void> {
  await withWorkspace('filemap-extract-', async (cwd) => {
    const filePath = join(cwd, fileName);

    await createFixture(cwd, fileName, contents);
    const fileHandle = await open(filePath, 'r');

    try {
      await expect(
        extractFileoverviewFromHandle(fileHandle, tag),
      ).rejects.toThrow(expectedMessage);
    } finally {
      await fileHandle.close();
    }
  });
}
