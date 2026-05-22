# Security Policy

## Supported Versions

Security fixes target the latest release on npm and the `main` branch.

## Report a Vulnerability

Please do not open a public issue for a security bug.

Email security reports to Davey Barker at <david@davidbarker.me>. Include:

- what you found
- how to reproduce it
- what version or commit you tested
- whether the issue affects the CLI, published package, or docs

I will confirm receipt, review the report, and share the next step when I understand the impact.

## Dependency Install Scripts

GitHub Actions installs dependencies with `npm ci --ignore-scripts`.

The lockfile currently marks these packages as having install scripts:

- `node_modules/esbuild`
- `node_modules/fsevents`

Check the list before release:

```bash
jq -r '.packages | to_entries[] | select(.value.hasInstallScript == true) | .key' package-lock.json
```

If a new package appears, review why it needs an install script before allowing it.
