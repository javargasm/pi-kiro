---
"@javargasm/pi-kiro": minor
---

Harden packaging and release infrastructure.

- Scope the package as `@javargasm/pi-kiro` and point `repository`,
  `homepage`, and `bugs` at the fork.
- Add a rich `description` and discoverability `keywords`
  (`provider`, `kiro`, `aws`, `codewhisperer`, `amazon-q`, `claude`).
- Add lifecycle and convenience scripts: `check` (typecheck + test),
  `publish:dry-run`, `prepack` (build), and a `prepublishOnly` that runs
  the full `check`. The published tarball is now always type-checked,
  tested, and freshly built.
- Adopt Changesets for versioning and changelog generation with
  PR/commit links via `@changesets/changelog-github`.
- Align CI/release workflows: CI runs on push to `master` and on pull
  requests; the release workflow runs the full `check` plus an explicit
  `build` before `npm publish`.
