import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import packageJson from '../package.json' with { type: 'json' };
import { createFixture, runSyncCommand, withWorkspace } from './helpers.js';

const COMMAND_TIMEOUT_MS = 60_000;
const DISALLOWED_PACKAGE_ENTRY_KEYS = [
  'browser',
  'deno',
  'esnext',
  'fesm2015',
  'fesm2020',
  'jspm',
  'jsdelivr',
  'jsnext:main',
  'less',
  'main',
  'module',
  'react-native',
  'sass',
  'sideEffects',
  'source',
  'style',
  'types',
  'typesVersions',
  'typings',
  'unpkg',
] as const;
const EXPECTED_PACKED_FILES = [
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'README.md',
  'RELEASE.md',
  'SECURITY.md',
  'SUPPORT.md',
  'THIRD_PARTY_NOTICES.md',
  'dist/cli.js',
  'package.json',
] as const;
const EXPECTED_PACKAGE_FILES = [
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'README.md',
  'RELEASE.md',
  'SECURITY.md',
  'SUPPORT.md',
  'THIRD_PARTY_NOTICES.md',
  'dist',
] as const;
const PROJECT_ROOT = process.cwd();

interface NpmPackFile {
  readonly path: string;
}

interface NpmPackResult {
  readonly filename: string;
  readonly files: readonly NpmPackFile[];
}

interface SyncCommandResult {
  readonly stderr: string;
  readonly stdout: string;
}

describe('package exports', () => {
  test('keeps filemap packaged as a CLI without programmatic imports', () => {
    expect(packageJson.bin).toEqual({ filemap: 'dist/cli.js' });
    expect(packageJson.exports).toEqual({ './package.json': './package.json' });
    expect(packageJson.files).toEqual(EXPECTED_PACKAGE_FILES);

    for (const key of DISALLOWED_PACKAGE_ENTRY_KEYS) {
      expect(packageJson).not.toHaveProperty(key);
    }
  });

  test('keeps bundled packages out of runtime dependencies', () => {
    expect(packageJson).not.toHaveProperty('dependencies');
    expect(typeof packageJson.devDependencies.commander).toBe('string');
    expect(typeof packageJson.devDependencies.ignore).toBe('string');
    expect(typeof packageJson.devDependencies.picomatch).toBe('string');
  });

  test('keeps third-party notices for bundled packages', async () => {
    const notices = await readFile(
      join(PROJECT_ROOT, 'THIRD_PARTY_NOTICES.md'),
      'utf8',
    );

    expect(notices).toContain('commander');
    expect(notices).toContain('ignore');
    expect(notices).toContain('picomatch');
  });

  test('packs only the files needed by the published CLI', () => {
    const packResult = runNpmPackDryRun();

    expect(getPackedFilePaths(packResult)).toEqual(EXPECTED_PACKED_FILES);
  });

  test('given npm prints lifecycle output before pack JSON, when parsing pack output, then the package entry is still read', () => {
    const packResult = parseNpmPackJson(
      [
        'HUSKY=0 skip install',
        JSON.stringify([
          {
            filename: 'dvyio-filemap-0.1.0.tgz',
            files: [{ path: 'dist/cli.js' }],
          },
        ]),
      ].join('\n'),
    );

    expect(packResult.filename).toBe('dvyio-filemap-0.1.0.tgz');
    expect(getPackedFilePaths(packResult)).toEqual(['dist/cli.js']);
  });

  test('given the packed package is installed, when a user runs it, then the CLI and exports work', async () => {
    await withWorkspace('filemap-pack-', async (cwd) => {
      const packDirectory = join(cwd, 'pack');
      const installDirectory = join(cwd, 'install');
      const repoDirectory = join(installDirectory, 'repo');

      await mkdir(packDirectory, { recursive: true });
      await mkdir(installDirectory, { recursive: true });
      await createFixture(
        installDirectory,
        'package.json',
        '{"type":"module"}\n',
      );
      await createFixture(
        repoDirectory,
        'src/app.ts',
        '/** @fileoverview App module */\nexport const app = true;\n',
      );

      const packResult = runNpmPack(packDirectory);
      const tarballPath = join(packDirectory, packResult.filename);

      runCheckedCommand(
        'npm',
        ['install', '--dry-run=false', '--ignore-scripts', tarballPath],
        {
          cwd: installDirectory,
        },
      );

      const versionResult = runInstalledFilemap(['--version'], repoDirectory);
      const helpResult = runInstalledFilemap(['--help'], repoDirectory);
      const cliResult = runInstalledFilemap([], repoDirectory);
      const rootImportResult = runInstalledNodeScript(
        [
          'try {',
          "  await import('@dvyio/filemap');",
          '} catch (error) {',
          "  if (error instanceof Error && 'code' in error && error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {",
          "    console.log('blocked');",
          '    process.exit(0);',
          '  }',
          '  throw error;',
          '}',
          "throw new Error('Expected @dvyio/filemap root import to be blocked.');",
        ].join('\n'),
        installDirectory,
      );
      const packageJsonImportResult = runInstalledNodeScript(
        [
          "const packageJson = await import('@dvyio/filemap/package.json', { with: { type: 'json' } });",
          "console.log(packageJson.default.name + '@' + packageJson.default.version);",
        ].join('\n'),
        installDirectory,
      );

      expect(versionResult.stderr).toBe('');
      expect(versionResult.stdout).toBe(`${packageJson.version}\n`);
      expect(helpResult.stderr).toBe('');
      expect(helpResult.stdout).toContain('Usage: filemap [options] [scope]');
      expect(helpResult.stdout).toContain('filemap is read-only');
      expect(cliResult.stderr).toBe('');
      expect(cliResult.stdout).toBe('./src/app.ts — App module\n');
      expect(rootImportResult.stdout).toBe('blocked\n');
      expect(packageJsonImportResult.stdout).toBe(
        `${packageJson.name}@${packageJson.version}\n`,
      );
    });
  });
});

function getPackedFilePaths(packResult: NpmPackResult): readonly string[] {
  return packResult.files.map((file) => file.path);
}

function runNpmPackDryRun(): NpmPackResult {
  const result = runCheckedCommand(
    'npm',
    ['pack', '--dry-run', '--ignore-scripts', '--json'],
    { cwd: PROJECT_ROOT },
  );

  return parseNpmPackJson(result.stdout);
}

function runNpmPack(packDestination: string): NpmPackResult {
  const result = runCheckedCommand(
    'npm',
    [
      'pack',
      '--dry-run=false',
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      packDestination,
    ],
    { cwd: PROJECT_ROOT },
  );

  return parseNpmPackJson(result.stdout);
}

function parseNpmPackJson(stdout: string): NpmPackResult {
  const parsed: unknown = JSON.parse(
    stdout.slice(findNpmPackJsonStart(stdout)),
  );

  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(
      'Invalid npm pack output — expected one package entry in JSON output.',
    );
  }

  const packageEntry: unknown = parsed[0];

  if (
    !isJsonObject(packageEntry) ||
    typeof packageEntry['filename'] !== 'string' ||
    !Array.isArray(packageEntry['files'])
  ) {
    throw new Error(
      'Invalid npm pack output — expected a filename and packed file list.',
    );
  }

  return {
    filename: packageEntry['filename'],
    files: packageEntry['files'].map(readNpmPackFile),
  };
}

function findNpmPackJsonStart(stdout: string): number {
  if (stdout.startsWith('[')) {
    return 0;
  }

  const jsonStart = stdout.indexOf('\n[');

  if (jsonStart === -1) {
    throw new Error(
      'Invalid npm pack output — expected JSON output to start with an array.',
    );
  }

  return jsonStart + 1;
}

function readNpmPackFile(value: unknown): NpmPackFile {
  if (!isJsonObject(value) || typeof value['path'] !== 'string') {
    throw new Error(
      'Invalid npm pack output — expected each packed file to have a path.',
    );
  }

  return {
    path: value['path'],
  };
}

function isJsonObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function runInstalledFilemap(
  args: readonly string[],
  cwd: string,
): SyncCommandResult {
  return runCheckedCommand('npx', ['--no-install', 'filemap', ...args], {
    cwd,
  });
}

function runInstalledNodeScript(
  script: string,
  cwd: string,
): SyncCommandResult {
  return runCheckedCommand('node', ['--input-type=module', '--eval', script], {
    cwd,
  });
}

function runCheckedCommand(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string },
): SyncCommandResult {
  const commandText = [command, ...args].join(' ');
  const result = runSyncCommand(command, args, {
    cwd: options.cwd,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });

  if (result.status !== 0) {
    throw new Error(
      `Failed to run "${commandText}" — expected exit code 0, got ${String(result.status)}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  return {
    stderr: result.stderr,
    stdout: result.stdout,
  };
}
