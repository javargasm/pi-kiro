# pi-kiro rules

- Goal: a minimal, faithful Kiro provider for the pi coding agent. Three
  jobs only: get a credential, translate pi → Kiro requests, translate
  Kiro → pi event streams. Everything else (history sizing, compaction,
  retry-on-overload, cross-provider sanitization) is pi-mono's job.
- The acceptance contract lives in `doc/conformance.md`. Items are numbered;
  test files reference item numbers in comments. Treat it as the source of
  truth — do not silently drift from a numbered item.
- Architecture and module map: `doc/architecture.md`. Design rationale and
  what was intentionally dropped from the old `pi-provider-kiro`: `doc/plan.md`.

## Fidelity to the real client

- Requests must stay structurally identical to the real Kiro CLI / Amazon Q
  CLI. Headers, body shape, the synthetic system seed, and tool schemas are
  captured from real traffic (Charles proxy) — see `kiro-defaults.ts` and
  `kiro-tools.ts`. Verify against a capture before changing them.
- `__tool_use_purpose` is appended to every tool schema by design. The
  static native tool schemas in `kiro-tools.ts` are injected verbatim;
  MCP tools (codegraph, pencil) are intentionally omitted because pi
  handles those directly.
- Region behavior: SSO region → API region is mapped in `models.ts`
  (`API_REGION_MAP`). Builder ID is `us-east-1` only; IdC can be probed or
  user-supplied.

## Code constraints

- TypeScript strict mode with `noUncheckedIndexedAccess`. No `any` in
  `src/**`. No type casts in `src/extension.ts` beyond the documented
  structural `ExtensionAPI`/`ProviderConfig` subset.
- Relative imports carry no file extension (Bun/bundler resolution).
- `src/core.ts` is the standalone surface: it must only pull in
  `@earendil-works/pi-ai`, never `@earendil-works/pi-coding-agent`, so
  non-pi consumers can embed the provider.

## Secrets

- `KiroCredentials` (`clientSecret` + pipe-packed `refresh`) can mint new
  access tokens for the user's AWS identity. Never log them, never send to
  telemetry, never embed in URLs. When reading `auth.json` or the Kiro IDE
  SQLite DB, reference values by key — do not echo them.

## Verification

- Before claiming done: `bun run check` (typecheck + test). The pi-mono
  standard suites under `test/pi-mono-suite/` are live-gated; skipped suites
  must carry a `// SKIP: <reason>` comment.
- After modifying a numbered conformance behavior, update the matching item
  in `doc/conformance.md` and its referencing test in the same change.

## Release

- Versioning is via Changesets. Record user-facing changes with
  `bun run changeset`; cut a release with `bun run version`, then tag `v*`.
  Pushing the tag triggers OIDC trusted publishing to npm. Do not publish
  manually and do not commit a release without the user asking.
