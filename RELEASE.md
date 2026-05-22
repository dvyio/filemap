# Release Process

Use this flow for npm releases. GitHub Actions publishes the package, so npm can attach provenance to the release.

## Before Publishing

1. Check the working tree. Do not publish with unrelated local changes.
2. Update `CHANGELOG.md`.
3. Update the package version in `package.json` and `package-lock.json`.
4. Run the full release gate. This includes the dependency audit:

```bash
npm run ci
```

5. Check the package shape:

```bash
npm publish --dry-run
```

## Publish

1. Push the version commit to `main`.
2. Create and push a version tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

3. Create a GitHub release for that tag.
4. Wait for the `Publish to npm` job to pass.

Do not use local `npm publish` as the normal release path. The package sets `publishConfig.provenance` to `true`, and the GitHub Actions publish job has `id-token: write` so npm can attach provenance to the package.

Before the first release, enable npm trusted publishing for this GitHub repository in the npm package settings. If npm requires the package to exist first, publish the first version with a short-lived token or manual 2FA, then switch to trusted publishing right away.

## After Publishing

1. Check the npm package page.
2. Check that the README install command works.
3. Check that npm shows provenance for the published version.
