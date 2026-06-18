# Changelog

## 0.4.8

### Patch Changes

- 3981af9: Fix provider name mismatch that hid all models from pi's model selector. The registered provider name ("kiro AWS") did not match the auth.json key ("kiro"), causing pi's AuthStorage to fail credential lookup.

## 0.4.7

### Patch Changes

- fix: use reasoningContent with signature for thinking history instead of inline XML tags

  Bedrock rejects replayed history with THINKING_SIGNATURE_INVALID when thinking
  blocks use inline `<thinking>` XML tags without the cryptographic signature.
  Now accumulates thinking text and signature from upstream content blocks and
  sends them as proper `reasoningContent.reasoningText` with `text` + `signature`.
  Silently drops reasoning when the signature is missing rather than crashing.

  Also adds opt-in file-based debug logging (KIRO_FILE_LOG) for API interactions.

## 0.4.6

### Patch Changes

- Fix duplicate browser tab during Enterprise sign-in and resolve profileArn immediately after successful login and token refresh.

## 0.4.5

### Patch Changes

- fix: resolve profileArn automatically for Builder ID accounts

  Builder ID device-code login never receives a profileArn, which prevented
  model fetching and streaming. Now the startup resolves it via
  `ListAvailableProfiles` and persists it to auth.json.

## 0.4.4

### Patch Changes

- fix: refresh token at startup before fetching models

  - Always refresh the access token at startup so `ListAvailableModels` never hits an expired token
  - Persist refreshed credentials back to `auth.json` for other extensions (e.g. pi-usage-bars)
  - Simplify profileArn store from Map to single variable
  - Remove unused debug request-shape summary interfaces
  - Use `dashToDot` in `resolveKiroModel` instead of duplicated regex

## 0.4.3

### Patch Changes

- Port profileArn improvements from opencode-kiro: seed profileArn cache from auth.json on startup to avoid ListAvailableProfiles round-trip, add fallbackProfileArn parameter to fetchAvailableModels, and declare supportsThinkingConfig on Claude 4.6+/4.7/4.8/Fable 5 static models.

## 0.4.2

### Patch Changes

- 615afc2: Align stream request headers with real Kiro CLI traffic. Updates User-Agent to match the current AWS SDK Rust client format, sets `Accept: */*` and `Accept-Encoding: gzip`, bumps `amz-sdk-request` max attempts to 3, adds `Pragma`/`Cache-Control: no-cache`, and removes the `x-amzn-kiro-agent-mode` header that is no longer sent by the real client.

## 0.4.1

### Patch Changes

- Fix Kiro CLI/IDE token import and refresh sync. Node runtimes now fall back to the system sqlite3 CLI for local DB access, refresh write-back only updates the exact imported CLI token row, and IDE/desktop refresh tokens are never written into kiro-cli storage.

## 0.4.0

### Minor Changes

- Import from Kiro now reads the real kiro-cli SQLite DB at `data.sqlite3` in the platform's standard data directory (previously a non-existent `~/.kiro/db/kiro.db` path inherited from the old `pi-provider-kiro`). When the kiro-cli DB is unavailable, falls back to the AWS SSO OIDC cache JSON at `~/.aws/sso/cache/kiro-auth-token.json` (the file Kiro IDE writes). The primary path now also includes the OIDC clientId/secret when present, so users with kiro-cli installed can refresh via the OIDC endpoint instead of the desktop endpoint.

## 0.3.0

### Minor Changes

- Add Claude Fable 5 and Claude Opus 4.8 to the static model catalog, region allowlists, and README.

## 0.2.1

### Patch Changes

- [#3](https://github.com/javargasm/pi-kiro/pull/3) [`3bdf8dd`](https://github.com/javargasm/pi-kiro/commit/3bdf8dd2480eca7a2ab6a653a90c74c64c5e088f) Thanks [@javargasm](https://github.com/javargasm)! - Post-release hardening: type safety, Node engine, coverage gate, and release docs.

  - Remove all `as unknown as` casts from `src/extension.ts` (was 4). The
    model-config types are now aligned so `kiroModels` flows into the provider
    config and `modifyModels` stamps `Model<Api>` values without casts —
    satisfying the project's "no type casts in extension.ts" constraint.
  - Declare `engines.node: ">=20"` to fail fast on unsupported Node versions.
  - Add a coverage gate: `@vitest/coverage-v8` with floor thresholds
    (statements/lines 75%, branches 65%, functions 80%) wired into CI via a
    new `test:coverage` script. Current offline coverage is ~81% lines.
  - Add `RELEASING.md` documenting the Changesets + OIDC flow and the release
    gotchas (GITHUB_TOKEN for changelog links, workflow-must-be-on-master for
    tag triggers, new-scope bootstrap with `--provenance=false`, spent tags).

## 0.2.0

### Minor Changes

- [#1](https://github.com/javargasm/pi-kiro/pull/1) [`2e0975a`](https://github.com/javargasm/pi-kiro/commit/2e0975a02b0961d85add9bfd6e06b39b9bc63ef5) Thanks [@javargasm](https://github.com/javargasm)! - Harden packaging and release infrastructure.

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

## 0.1.4

- Fix: `ThinkingTagParser` runs unconditionally when `reasoning` is
  enabled. Previously gated on `!reasoningHidden` on the assumption
  that Anthropic's adaptive-thinking "omitted" policy was binding;
  it isn't — Opus 4.7 intermittently leaks `<thinking>...</thinking>`
  tags. Defensive parsing splits them into proper thinking blocks
  instead of rendering as raw tags in text. No-tag streams are a
  no-op (text-buffer scan).
- Change: the redacted-thinking breadcrumb now emits lazily. Previously
  pushed on `start` then possibly updated after a 2s countdown,
  leaving an empty thinking block at `content[0]` on every fast
  response — a representation bug downstream consumers worked around
  by filtering empty thinking blocks. Now: a 2s timer arms on `start`;
  if content or a tool call arrives first, the timer is cancelled and
  no shim is emitted; otherwise the full shim (`thinking_start` +
  `thinking_delta` with marker + `thinking_end`) flushes in one shot.
- `reasoningHidden` still controls: (a) skipping the `<thinking_mode>`
  system-prompt directive, (b) the lazy shim. It no longer gates the
  parser.
- Consumers that filtered empty redacted-thinking blocks
  (Inkstone, pi-coding-agent, OpenCode) see no user-visible change.
  Consumers that relied on the literal empty-shim breadcrumb at
  `content[0]` on fast responses should verify behavior.

## 0.1.3

- Drop `@mariozechner/pi-coding-agent` as a dependency and peer. pi-kiro
  used it only for the `ExtensionAPI` type; the minimal shape is now
  declared locally in `src/extension.ts`. Hosts on any pi version can
  install pi-kiro without a resolution error.
- Add `@mariozechner/pi-ai` `^0.72.1` as an explicit devDep (previously
  transitive via pi-coding-agent).
- `@mariozechner/pi-ai` stays declared as peer `*`.
- `ExtensionAPI` / `ProviderConfig` in the emitted `dist/extension.d.ts`
  are now local, not re-exported from pi-coding-agent. Consumers should
  keep importing these types from `@mariozechner/pi-coding-agent`
  directly; pi-kiro does not re-export them.
- Public API surface (`streamKiro`, `kiroModels`, `loginKiro`,
  `refreshKiroToken`, `resolveApiRegion`, `filterModelsByRegion`,
  `KiroCredentials`, `KiroModel`, etc.) is unchanged.
