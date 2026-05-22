# filemap

Read-only CLI tool that prints file maps from overview tags in source code. It discovers files, builds file and directory entries, renders a markdown list, and prints it to stdout.

## Architecture

Pipeline: **discover** (glob files) → **buildMap** (collapse directories, read visible overview tags, and read needed `.overview` sidecars) → **render** (sort + markdown) → **stdout**.

Each stage is a pure-ish function with its own module. The CLI discovers files, calls `buildMap()` from the pipeline, and prints `renderFileMapChunks()` output to stdout. It does not change repo files.

Runtime source stays read-only. Discovery and pipeline code return data or throw errors; only the CLI entrypoint writes to stdout or stderr.

Primary CLI modes:

- **Stdout** (`filemap`): prints the rendered list to stdout with no summary line or discoverability note.
- **Strict stdout** (`filemap --strict`): exits non-zero when a visible file lacks an overview tag or a collapsed directory lacks `.overview`.
- **Scoped stdout** (`filemap src/auth`): prints a map for one subtree or file with scope-relative paths.

Use this in agent instructions when needed:

```md
## Repo map

This repo uses filemap for live file-purpose lookup.

- Run `npx @dvyio/filemap` for the full map.
- Run `npx @dvyio/filemap path/to/subtree` for a scoped map.
- Run `npx @dvyio/filemap --strict > /dev/null` to check coverage.
```

## Conventions

### TypeScript

- ESM-only. All imports use `.js` extension (NodeNext module resolution).
- `readonly` on every interface property and function parameter that accepts arrays/objects.
- `as const` on static arrays and objects (see `HARD_EXCLUDE_PATTERNS`, `EXCLUDE_GROUPS`).
- `undefined` over `null` everywhere — no `null` in the codebase.
- Path strings must pass through the helpers in `src/paths`; brand casts belong only in those helpers.
- Prefer `if/else` and guard clauses for branching. Existing small ternaries are allowed when they keep object construction clear.
- TSDoc on every exported function: describe what it does, `@param`, `@returns`.

### Error handling

All boundary validation follows this pattern:

```typescript
throw new Error(
  `Invalid ${fieldName} "${String(value)}" — expected a non-empty string.`,
);
```

Three parts: what failed, the bad value, what was expected. Every public function validates its inputs before doing work. Internal errors wrap with `{ cause: error }`.

### Review-only conventions

Keep these small enough for review instead of custom lint rules:

- Runtime code stays read-only. Do not write files from `src/`.
- Only `src/cli.ts` writes to stdout or stderr.
- Do not import `src/cli.ts` from runtime modules.
- Do not use dynamic `import()` in runtime source.
- Keep glob package use inside discovery code.
- Keep tests under `test/`.
- Exported default arrays and objects stay frozen with `as const` or `satisfies`.
- Read caught errors only after `error instanceof Error` or a named error guard.

### Testing

- Vitest with explicit imports (`globals: false`).
- Keep tests under the root `test/` tree. Do not colocate tests with source files.
- Tests use `withWorkspace()` and `createFixture()` helpers from `test/helpers.ts` to create isolated workspaces.
- Test workspaces are always cleaned up in `finally` blocks.
- CLI tests call the exported `runCli` function in-process so they can inject stdout and stderr writers. `spawnSync` is only used for test setup commands such as `git init`.
- Test names describe behavior directly: `'extracts from a single-line JSDoc comment'`.

### Build and check

```bash
npm run test          # vitest
npm run check:source  # read-only verification: typecheck → lint → format
npm run check         # full verification: check:source → knip → build → check:dist → test
npm run ci            # release gate: check → coverage:dist → pack:check:dist
npm run fix           # mutating repair: typecheck → lint:fix → format:fix → test
```

`npm test` does not build. `npm run check` already runs tests after the build and `check:dist`. `npm run ci` adds `coverage:dist` and `pack:check:dist`.

Use `node dist/cli.js --strict > /dev/null` after build when you only need the file overview gate.

### File discovery defaults

Keep the exact default extensions and exclude groups in code, not in this file. When defaults change, update `src/shared/defaults.ts`, help text, README, and discovery tests together.

`--include` and `--include-groups` rescue matching files from soft excludes only. They do not broaden beyond the active extension filter. Explicit excludes win when both include and exclude match.

### Explicit CLI only

A run is controlled by the command, the optional scope, and explicit flags only. Keep repeatable commands in package scripts or agent instructions.

Useful repeatable commands:

```json
{
  "scripts": {
    "filemap": "filemap --depth 2",
    "filemap:strict": "filemap --strict > /dev/null"
  }
}
```

For monorepos, pass a scope or run filemap from the package directory:

```bash
filemap packages/api
filemap packages/web --depth 2
cd packages/api && filemap
```
