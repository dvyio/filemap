# filemap

Print a read-only file map from source overview comments.

```bash
npm install -D @dvyio/filemap

npx @dvyio/filemap
npx @dvyio/filemap --strict
npx @dvyio/filemap src/auth
```

filemap is read-only. It prints to stdout, so humans, scripts, and coding agents can inspect a repo or subtree. It does not change repo files.

## Setup

1. Add an overview tag near the top of each source file.
2. Run `npx @dvyio/filemap` to print the map.
3. Run `npx @dvyio/filemap --strict > /dev/null` when you only want to check coverage.

## Compatibility

filemap supports Node.js 20 and newer. The built CLI avoids JSON import attributes at startup, so `filemap --version` works across the full engine range.

Use Node.js 20.19 or newer when you build this repo or work on filemap locally. Some development tools need that newer Node 20 patch version.

## Output

```txt
./src/cli.ts — CLI entry point
./src/discovery/index.ts — Finds visible source files
./src/pipeline/index.ts — Builds file and directory map entries
```

## Source Tags

Add a short overview at the top of source files. `@fileoverview` is the clearest spelling:

```ts
/** @fileoverview Builds user-facing CLI commands */
```

Other supported comment styles:

```py
# @fileoverview Builds user-facing CLI commands
```

```go
// @fileoverview Builds user-facing CLI commands
```

Markdown and HTML files can use HTML comments:

```md
<!-- @fileoverview Builds user-facing docs -->
```

filemap also accepts `@file` and `@overview` by default. Use `--tag @custom` when a project should use one custom tag instead.

filemap scans the first 64 KiB of each file for an overview. A tag after that limit is ignored. If a block or HTML overview starts before the limit but does not close before the limit, filemap uses the description text it has already read. In strict mode, that counts as documented.

Markdown and HTML files are not discovered by default. Add them with `--ext`:

```bash
npx @dvyio/filemap --ext md --ext html
```

## Strict Checks

Use `--strict` when missing overview text should fail the command:

```bash
npx @dvyio/filemap --strict
```

Use this when you only want the exit code:

```bash
npx @dvyio/filemap --strict > /dev/null
```

Strict mode fails when a visible file has no overview tag. It also fails when a collapsed directory has no `.overview` file.

## Failure Output

When the CLI fails, stderr starts with a readable message:

```txt
filemap: 1 file missing an overview tag (@fileoverview, @file, or @overview):
```

Use the process exit code in scripts. `0` means success. Any non-zero exit means filemap could not print a complete map.

## Directory Overviews

Sometimes a file map should show one line for a directory instead of listing every file in it. A `.overview` file gives that directory its one-line description.

Put the file inside the directory it describes:

```txt
scripts/.overview
```

```txt
Build, release, and local maintenance commands
```

When `scripts` is collapsed with `--collapse-dir`, filemap uses that text for the directory row:

```bash
npx @dvyio/filemap --collapse-dir scripts
```

```txt
./scripts/ — Build, release, and local maintenance commands (4 files)
```

The goal is to keep large, low-detail areas readable without losing their purpose.

## Agent Snippet

Add this small note to agent instructions when you want agents to discover the tool:

```md
## Repo map

This repo uses filemap for live file-purpose lookup.

- Run `npx @dvyio/filemap` for the full map.
- Run `npx @dvyio/filemap path/to/subtree` for a scoped map.
- Run `npx @dvyio/filemap --strict > /dev/null` to check coverage.
```

## Repeatable Commands

Put common commands in package scripts or agent instructions:

```json
{
  "scripts": {
    "filemap": "filemap --depth 2",
    "filemap:strict": "filemap --strict > /dev/null"
  }
}
```

## Discovery Defaults

`--ext` replaces the default source extension list. By default, filemap discovers `ts`, `tsx`, `mts`, `cts`, `js`, `jsx`, `mjs`, `cjs`, `php`, `py`, `rb`, `go`, `rs`, `java`, `swift`, and `kt`.

Markdown and HTML files are not discovered by default. Add `md`, `mdx`, `html`, or `htm` when you want docs pages to appear in the map.

filemap always excludes `node_modules`, `vendor`, `dist`, `build`, `out`, `.cache`, `.next`, `.nuxt`, `.turbo`, `.agent-batch`, `.git`, and `coverage` directories.

These exclude groups are available:

| Group | Default | Patterns |
| --- | --- | --- |
| `tests` | yes | `**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`, `**/test/**`, `**/tests/**`, `**/e2e/**`, `**/cypress/**`, `**/playwright/**` |
| `fixtures` | yes | `**/__fixtures__/**`, `**/__mocks__/**`, `**/__snapshots__/**`, `**/fixtures/**` |
| `generated` | yes | `**/*.generated.*`, `**/__generated__/**` |
| `stories` | yes | `**/.storybook/**`, `**/stories/**`, `**/*.stories.*` |
| `locks` | yes | `**/package-lock.json`, `**/pnpm-lock.yaml`, `**/yarn.lock`, `**/bun.lock`, `**/bun.lockb`, `**/composer.lock`, `**/Gemfile.lock`, `**/Cargo.lock`, `**/go.sum`, `**/poetry.lock`, `**/Pipfile.lock` |
| `types` | yes | `**/*.d.ts` |
| `config` | no | `**/*.config.*` |
| `migrations` | no | `**/migrations/**` |

Disable the default-on groups with `--no-default-excludes`.

## Include and Exclude Rules

`--include` and `--exclude` take one glob pattern per flag. `--include-groups` and `--exclude-groups` take one group name per flag, such as `tests` or `config`. Repeat the same flag to pass more than one value.

Include flags rescue files from soft excludes only when those files are already in the candidate set built from `[scope]` and `--ext`. Exclude flags add to soft excludes and win when both match. Patterns starting with `!` are not supported. Use `--exclude` for files you want to hide and `--include` for files you want to rescue.

Files matched by `.gitignore` are also excluded.

## Large Repos and Debugging

`--max-files` caps discovered or visible source files before filemap reads overview tags. Raise it for large repos where the default limit is too low. The maximum is 200,000 files.

Use `--debug` when discovery is slow or a file is missing. The map still prints to stdout. Discovery inputs and the final file count print to stderr. Before sharing debug output in a public issue, redact private paths, private source names, overview text, and any secret-looking values.

Git ignore checks time out after 5 seconds by default. Set `FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS` to a decimal integer from `1` to `60000` milliseconds when a very large repo needs more time. Values outside that range fail the run.

## Maintainer Docs

- [Contributing](CONTRIBUTING.md)
- [Release process](RELEASE.md)
- [Changelog](CHANGELOG.md)
- [Security policy](SECURITY.md)
- [Support](SUPPORT.md)
