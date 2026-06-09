# Changesets

This package uses [Changesets](https://github.com/changesets/changesets) to
manage versioning and the `CHANGELOG.md`.

## Recording a change

After making a user-facing change, run:

```bash
bun run changeset
```

Pick the bump type (patch / minor / major) and write a short summary. This
creates a markdown file under `.changeset/` that you commit alongside your
code.

## Cutting a release

1. Apply pending changesets to bump the version and update the changelog:

   ```bash
   bun run version
   ```

   This rewrites `package.json` version and prepends the collected notes to
   `CHANGELOG.md` (with PR/commit links via `@changesets/changelog-github`).

2. Commit the version bump, then tag and push:

   ```bash
   git commit -am "release: v$(node -p "require('./package.json').version")"
   git tag "v$(node -p "require('./package.json').version")"
   git push --follow-tags
   ```

3. Pushing the `v*` tag triggers `.github/workflows/release.yml`, which
   publishes to npm via OIDC trusted publishing (with provenance). No
   `NPM_TOKEN` secret is needed.

The publish itself is gated by the package `prepublishOnly` (typecheck +
tests) and `prepack` (build) lifecycle hooks, so the tarball is always
type-checked, tested, and freshly built.
