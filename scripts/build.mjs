/** @fileoverview Builds the CLI with esbuild and injects the package version. */

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const packageVersion = readPackageVersion();
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const sourceRoot = fileURLToPath(new URL('../src', import.meta.url));

await rm(new URL('../dist', import.meta.url), {
  force: true,
  recursive: true,
});

await build({
  absWorkingDir: projectRoot,
  alias: {
    '@': sourceRoot,
  },
  // Commander is bundled as CommonJS and still requires Node built-ins.
  banner: {
    js: [
      "import { createRequire } from 'node:module';",
      'const require = createRequire(import.meta.url);',
    ].join('\n'),
  },
  bundle: true,
  define: {
    FILEMAP_PACKAGE_VERSION: JSON.stringify(packageVersion),
  },
  entryPoints: ['src/cli.ts'],
  format: 'esm',
  outfile: 'dist/cli.js',
  platform: 'node',
  sourcemap: false,
  target: 'node20',
});

function readPackageVersion() {
  const rawPackageJson = readFileSync(
    new URL('../package.json', import.meta.url),
    {
      encoding: 'utf8',
    },
  );
  /** @type {unknown} */
  const packageJson = JSON.parse(rawPackageJson);

  if (!isPackageJsonObject(packageJson)) {
    throw new Error('Invalid package.json — expected an object.');
  }

  const version = packageJson['version'];

  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error(
      `Invalid package.json version "${String(version)}" — expected a non-empty string.`,
    );
  }

  return version;
}

/**
 * Checks that parsed package JSON can be read by key.
 *
 * @param {unknown} packageJson - Parsed JSON from package.json.
 * @returns {packageJson is Record<string, unknown>} True when the value is a plain object.
 */
function isPackageJsonObject(packageJson) {
  return (
    typeof packageJson === 'object' &&
    packageJson !== null &&
    !Array.isArray(packageJson)
  );
}
