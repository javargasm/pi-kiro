# Releasing `@javargasm/pi-kiro`

Versioning is managed by [Changesets](https://github.com/changesets/changesets);
publishing is done by GitHub Actions via **npm OIDC trusted publishing**
(provenance-signed, no `NPM_TOKEN` secret).

## TL;DR (normal release)

```bash
# 1. Record what changed (pick patch/minor/major, write a summary)
bun run changeset

# 2. Merge that changeset to `master` (PR or direct)

# 3. Apply the bump — needs a GitHub token for changelog links (see gotchas)
GITHUB_TOKEN="$(gh auth token)" bun run version

# 4. Commit the bump, tag, and push the tag
git commit -am "release: v$(node -p "require('./package.json').version")"
git tag "v$(node -p "require('./package.json').version")"
git push origin master --follow-tags
```

Pushing the `v*` tag triggers `.github/workflows/release.yml`, which runs
`check` + `build` and then `npm publish` under OIDC. Done.

## How it fits together

- **`.changeset/`** — pending change notes. `config.json` uses
  `@changesets/changelog-github` with `repo: "javargasm/pi-kiro"` and
  `baseBranch: "master"`.
- **`bun run version`** — consumes changesets, bumps `package.json`, and
  prepends the entry to `CHANGELOG.md` with PR/commit links.
- **`.github/workflows/release.yml`** — on tag `v*`: `bun run check`,
  `bun run build`, `npm publish`. Has `permissions: id-token: write` for OIDC.
- **npm Trusted Publisher** — configured at npmjs.com for
  `@javargasm/pi-kiro` → repo `javargasm/pi-kiro`, workflow `release.yml`.
- **Lifecycle hooks** — `prepublishOnly` runs the full `check`; `prepare`
  runs `build`. The published tarball is always type-checked, tested, and
  freshly built. `prepare` also covers `pi install git:…`, which clones the
  raw repo without the gitignored `dist/`.

## Gotchas (learned the hard way)

### 1. `bun run version` needs `GITHUB_TOKEN`

`@changesets/changelog-github` calls the GitHub API to resolve PR/commit
links. Without a token it errors:

```
error Please create a GitHub personal access token ... and add it as the
GITHUB_TOKEN environment variable
```

Changesets escapes cleanly (no files touched), so just re-run with a token.
The simplest source is the `gh` CLI:

```bash
GITHUB_TOKEN="$(gh auth token)" bun run version
```

Export it in your shell to avoid repeating it. The token only needs read
access for changelog generation.

### 2. The workflow must already be on `master` for a tag to trigger it

A tag only triggers a workflow if that workflow file exists in the repo at
the tagged commit's history. If you add/modify `release.yml` and tag in the
same breath before it's on `master`, **no run is created**.

Symptom: tag pushed, `gh run list` shows nothing.

Fix: ensure `release.yml` is merged to `master` first, then re-emit the tag
(same commit is fine):

```bash
git push origin :refs/tags/vX.Y.Z   # delete remote tag
git tag -d vX.Y.Z                    # delete local tag
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z               # re-push -> triggers the run
```

### 3. First publish of a new scope can't be done by OIDC alone

OIDC trusted publishing can publish to an existing package/scope, but it
cannot *create* a brand-new scope from zero. The first publish under a new
scope (`@javargasm/*`) returns `404 Not Found - PUT .../@javargasm%2fpi-kiro`
even though provenance is signed correctly.

One-time bootstrap from your machine:

```bash
npm login
npm whoami                                  # confirm it's you
npm publish --access public --provenance=false
```

`--provenance=false` is required for the **local** publish because there is
no OIDC provider outside CI; otherwise npm errors with:

```
Automatic provenance generation not supported for provider: null
```

Do **not** remove `publishConfig.provenance: true` from `package.json` — that
flag is correct for CI. Use the CLI flag only for the bootstrap. After the
scope/package exists, configure the Trusted Publisher and every subsequent
release publishes via OIDC with provenance automatically.

### 4. Don't re-push a tag for an already-published version

npm rejects republishing the same version. Once `vX.Y.Z` is live on npm, the
tag is "spent". Bump to the next version for the next release; don't re-push
`vX.Y.Z` hoping CI will publish it.

## Forking / re-scoping note

This is a fork. `repository`, `homepage`, and `bugs` point at
`javargasm/pi-kiro`, and the package is scoped `@javargasm/pi-kiro`. If you
re-fork, update those four fields, the `.changeset/config.json` `repo`, and
the npm Trusted Publisher repository before releasing.
