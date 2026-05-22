# Contributing

Thanks for helping improve filemap.

## Setup

Use Node.js 20.19 or newer for local development.

```bash
npm ci
npm run check
```

`npm run check` typechecks, lints, checks formatting, runs `knip`, builds the CLI, runs `check:dist`, and runs the Vitest suite. You do not need to run `npm test` separately after `npm run check`.

## Local Workflow

Use the fix script before you open a pull request:

```bash
npm run fix
```

That runs typecheck, ESLint with fixes, Prettier with fixes, and the test suite.

Run focused tests while you work:

```bash
npm test -- test/pipeline
```

Run the full release gate before you publish or ask for review:

```bash
npm run ci
```

`npm run ci` runs the source checks, `knip`, the build, `check:dist`, coverage, and `pack:check:dist`. The main Vitest suite runs once under coverage in this gate.

## Build Constraints

The built CLI must start on every supported Node.js 20 version. The build and contribution path needs Node.js 20.19 or newer because some development tools require that newer patch version.

`scripts/build.mjs` reads `package.json` at build time and injects the package version as `FILEMAP_PACKAGE_VERSION`; `src/cli.ts` reads that compiled-in value for `filemap --version`. Keep that path in place. Do not import `package.json` from `src/cli.ts` with JSON import attributes, because that can break version output on Node.js 20.

## Pull Requests

- Keep the change focused.
- Add or update tests for changed behavior.
- Keep docs plain and short.
- Run `npm run ci` before marking the pull request ready.

## File Overview Tags

filemap uses source overview comments as part of its own check gate. New source files need a top-level `@fileoverview` comment unless they are tests, generated files, or files outside the discovered source set.
