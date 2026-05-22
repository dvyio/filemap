# Release Process

Use this flow for npm releases. GitHub Actions publishes the package from the GitHub Release, so npm can attach provenance.

Do not run local `npm publish` for normal releases.

## Before Publishing

1. Check the working tree. Do not publish with unrelated local changes.
2. Move `CHANGELOG.md` items from `Unreleased` into the new version.
3. Update the version in `package.json` and `package-lock.json`.
4. Run the full release gate:

```bash
npm run ci
```

5. Check the package shape:

```bash
npm pack --dry-run --json --silent
```

6. Check that the version is not already on npm. Replace `<version>` with the version from `package.json`:

```bash
npm view @dvyio/filemap@<version> version
```

That command should fail with `E404`. If it returns a version, choose a new version before you continue.

## Publish

1. Merge the version commit to `main`.
2. Create and push a tag for the version in `package.json`:

```bash
version="$(node -p "require('./package.json').version")"
git tag -a "v$version" -m "v$version"
git push public "v$version"
```

3. Create a GitHub Release for that tag.
4. Wait for the `Publish to npm` job to pass.

If the version already exists on npm, the release job skips `npm publish`. This makes the workflow safe to rerun, but it should not be the normal path for a new release.

## After Publishing

1. Check npm metadata:

```bash
npm view @dvyio/filemap version gitHead repository.url
```

2. Check the install path:

```bash
npx -y @dvyio/filemap --version
```

3. Check that npm shows provenance for the published version.
