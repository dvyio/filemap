# filemap

Print a read-only file map from source overview comments.

```bash
npm install -D @dvyio/filemap

npx @dvyio/filemap
npx @dvyio/filemap --strict
npx @dvyio/filemap src/auth
```

filemap prints to stdout, so humans, scripts, and coding agents can inspect a repo or subtree. It does not change repo files.

## What You Get

Add a short overview near the top of a file:

```ts
/** @fileoverview Builds user-facing CLI commands */
```

filemap prints that purpose next to the path:

```txt
./src/cli.ts — Builds user-facing CLI commands
```

## Use This When

Use filemap when you want a fast, readable map of what files do. It is useful for repo handoffs, agent context, looking around large repos, and checking that important source files explain their purpose.

Do not use filemap as a generated docs store. Run it when you need the map, then use what it prints.

## Pick Your Task

| Task | Command |
| --- | --- |
| Print the full map | `npx @dvyio/filemap` |
| Print one subtree or file | `npx @dvyio/filemap src/auth` |
| Check overview coverage | `npx @dvyio/filemap --strict > /dev/null` |
| Include docs pages | `npx @dvyio/filemap --ext md --ext html` |
| Collapse a noisy directory | `npx @dvyio/filemap --collapse-dir scripts` |
| Debug a missing file or slow run | `npx @dvyio/filemap --debug` |

## Common Tasks

### Print a map

```bash
npx @dvyio/filemap
```

Example output:

```txt
./src/cli.ts — CLI entry point
./src/discovery/index.ts — Finds visible source files
./src/pipeline/index.ts — Builds file and directory map entries
```

Pass a path when you only need one area:

```bash
npx @dvyio/filemap src/auth
```

### Check coverage

Use `--strict` when missing overview text should fail the command:

```bash
npx @dvyio/filemap --strict
```

Use this when you only want the exit code:

```bash
npx @dvyio/filemap --strict > /dev/null
```

Strict mode fails when a visible file has no overview tag. It also fails when a collapsed directory has no `.overview` file.

When the CLI fails, stderr starts with a readable message:

```txt
filemap: 1 file missing an overview tag (@fileoverview, @file, or @overview):
```

Use the process exit code in scripts. `0` means success. Any non-zero exit means filemap could not print a complete map.

### Map docs and HTML files

Markdown and HTML files can use HTML comments:

```md
<!-- @fileoverview Builds user-facing docs -->
```

Markdown and HTML files are not discovered by default. Add them with `--ext`:

```bash
npx @dvyio/filemap --ext md --ext html
```

### Collapse noisy directories

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

### Debug missing files or slow runs

Use `--debug` when discovery is slow or a file is missing. The map still prints to stdout. Discovery inputs and the final file count print to stderr.

`--max-files` caps discovered or visible source files before filemap reads overview tags. Raise it for large repos where the default limit is too low. The maximum is 200,000 files.

Before sharing debug output in a public issue, redact private paths, private source names, overview text, and any secret-looking values.

Git ignore checks time out after 5 seconds by default. Set `FILEMAP_GIT_CHECK_IGNORE_TIMEOUT_MS` to a decimal integer from `1` to `60000` milliseconds when a very large repo needs more time. Values outside that range fail the run.

## Source Tags

`@fileoverview` is the clearest spelling:

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

filemap also accepts `@file` and `@overview` by default. Use `--tag @custom` when a project should use one custom tag instead.

filemap scans the first 64 KiB of each file. Put the overview near the top.

## Agent Snippet

Add this small note to agent instructions when you want agents to discover the tool:

```md
## Repo map

This repo uses filemap for live file-purpose lookup.

- Run `npx -y @dvyio/filemap` for the full map.
- Run `npx -y @dvyio/filemap path/to/subtree` for a scoped map.
- Run `npx -y @dvyio/filemap --strict > /dev/null` to check coverage.
```

Use the scoped command when an agent only needs one part of the repo:

```bash
npx -y @dvyio/filemap src/discovery
```

```txt
./src/discovery/index.ts — Finds visible source files
./src/discovery/exclusions.ts — Applies default and user exclude rules
```

This keeps the agent focused on the files it is likely to touch.

For repeatable local use, put common commands in package scripts:

```json
{
  "scripts": {
    "filemap": "npx -y @dvyio/filemap --depth 2",
    "filemap:strict": "npx -y @dvyio/filemap --strict > /dev/null"
  }
}
```

## Discovery Defaults

`--ext` replaces the default source extension list. By default, filemap discovers `ts`, `tsx`, `mts`, `cts`, `js`, `jsx`, `mjs`, `cjs`, `php`, `py`, `rb`, `go`, `rs`, `java`, `swift`, and `kt`.

filemap always excludes `node_modules`, `vendor`, `dist`, `build`, `out`, `.cache`, `.next`, `.nuxt`, `.turbo`, `.agent-batch`, `.git`, and `coverage` directories.

filemap has exclude groups for tests, fixtures, generated files, stories, lock files, types, config files, and migrations. Run `npx @dvyio/filemap --help` for the exact patterns. Disable the default-on groups with `--no-default-excludes`.

## Include and Exclude Rules

`--include` and `--exclude` take one glob pattern per flag. `--include-groups` and `--exclude-groups` take one group name per flag, such as `tests` or `config`. Repeat the same flag to pass more than one value.

Include flags rescue files from soft excludes only when those files are already in the candidate set built from `[scope]` and `--ext`. Exclude flags add to soft excludes and win when both match. Patterns starting with `!` are not supported. Use `--exclude` for files you want to hide and `--include` for files you want to rescue.

Files matched by `.gitignore` are also excluded.

## Compatibility

filemap supports Node.js 20 and newer.

Use Node.js 20.19 or newer when you build this repo or work on filemap locally. Some development tools need that newer Node 20 patch version.

## Maintainer Docs

- [Contributing](CONTRIBUTING.md)
- [Release process](RELEASE.md)
- [Changelog](CHANGELOG.md)
- [Security policy](SECURITY.md)
- [Support](SUPPORT.md)
