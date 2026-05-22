import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { createUserFacingPathRedactor } from '@/cli/path-redaction.js';

import { withWorkspace } from '../helpers.js';

describe('createUserFacingPathRedactor', () => {
  test('redacts cwd children when the cwd path already ends with a separator', async () => {
    await withWorkspace('filemap-redaction-', async (cwd) => {
      const redactor = createUserFacingPathRedactor(`${cwd}/`);

      expect(
        redactor.redactText(`Failed "${join(cwd, 'src', 'app.ts')}".`),
      ).toBe('Failed "./src/app.ts".');
    });
  });

  test('redacts quoted paths inside error text', async () => {
    await withWorkspace('filemap-redaction-', async (cwd) => {
      const redactor = createUserFacingPathRedactor(cwd);
      const message = [
        `Failed to read "${join(cwd, 'src', 'app.ts')}".`,
        `Also failed '${join(cwd, 'README.md')}'.`,
        `Home path "${join(homedir(), 'Documents', 'notes.md')}".`,
        'Outside path "/private/outside/secret.ts".',
        'Double Windows path "C:\\Users\\Davey\\repo\\double-secret.ts".',
        "Windows path 'C:\\Users\\Davey\\repo\\secret.ts'.",
      ].join(' ');

      expect(redactor.redactText(message)).toBe(
        'Failed to read "./src/app.ts". Also failed \'./README.md\'. Home path "~/Documents/notes.md". Outside path "<path:secret.ts>". Double Windows path "<path:double-secret.ts>". Windows path \'<path:secret.ts>\'.',
      );
    });
  });

  test('redacts paths even when the cwd cannot be read', () => {
    const cwd = join(tmpdir(), 'filemap-missing-cwd-for-redaction');
    const redactor = createUserFacingPathRedactor(cwd);

    expect(redactor.redactText(`Failed "${join(cwd, 'src', 'app.ts')}".`)).toBe(
      'Failed "./src/app.ts".',
    );
  });
});
