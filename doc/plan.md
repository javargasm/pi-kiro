# pi-kiro Design Plan

> **Status note (post-rewrite drift).** This document records the *original*
> greenfield-rewrite plan. Some scope that was dropped here was later
> reintroduced as the package matured against real Kiro CLI behavior:
> IAM Identity Center login, the Kiro IDE SQLite credential sync
> (`kiro-cli-sync.ts`), and a multi-layer credential refresh path all exist
> today. Static native tool schemas (`kiro-tools.ts`) and captured client
> identity defaults (`kiro-defaults.ts`) were also added for request
> fidelity. Treat `doc/architecture.md` and `doc/conformance.md` as the
> current source of truth; the sections below are kept as a design-history
> record, not a description of the present file set.

## Why a new package

`pi-provider-kiro` (3,349 lines) accumulated a lot of scaffolding that pi-mono
now handles or that supports features we don't need:

- kiro-cli SQLite interop (~270 lines of native deps + subprocess fallback)
- Social login (Google / GitHub) delegated to kiro-cli (~200 lines)
- IdC (IAM Identity Center) region probing across 10 regions
- Echo-loop retry + bracket-style tool-call fallback (artifacts of a history bug
  that the rewrite eliminates at the source)
- 5-layer credential cascade across Kiro IDE / kiro-cli / stale tokens
- 65-line capacity log file and ad-hoc `console.warn` scatter

pi-kiro is a greenfield rewrite with one goal: minimal Kiro provider that
leverages pi-mono utilities, supports AWS Builder ID only, and carries no
optional dependencies.

## Design decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Drop `fetchUsage` in v1 | Field is not part of the documented `ProviderConfig` contract. Keeps `extensions/index.ts` free of type casts. TODO noted for when upstream documents the hook. |
| D2 | Port all 11 pi-mono standard test suites | Gold-standard compliance per `docs/custom-provider.md`. |
| D3 | 4-level debug logger (error/warn/info/debug) | More than two states useful for future triage; trace level adds no real value over debug. |
| D4 | Keep `addPlaceholderTools` | Defensive code for mid-session tool-set changes. Cheap (~15 lines), real bug fix. |
| D5 | Delete bun-init leftovers, rewrite README | Keeps the package self-describing. |

| Scope | Drop | Reason |
|---|---|---|
| Echo-loop retry (`"Continue"` / `"."`) | ✓ | Root cause was synthetic history padding. Rewrite merges consecutive messages instead of padding, removing the cause. |
| Bracket-tool-call fallback (`[Called X with args: …]`) | ✓ | Only triggers on broken streams. First-token and idle timeouts + retry cover the same failure modes. |
| `injectSyntheticToolCalls` | ✓ | `sanitizeHistory` already drops orphan tool-result entries before the injector could fire. Dead in practice. |
| kiro-cli SQLite reader/writer | ✓ | Hard native dep, social-login-only pathway. Users re-login with native device-code flow. |
| Social login (Google / GitHub) | ✓ | Required kiro-cli. Builder ID covers the majority case. |
| IdC region probing | ✓ | Builder ID is us-east-1 only. |
| Custom TUI login component | ✓ | Stock `OAuthLoginCallbacks` sufficient for Builder ID device-code flow. |

## Retry / recovery scope

Kept (all Kiro-specific, pi-mono does not handle):

- 403 → token refresh → retry (up to 3, 500ms base backoff)
- Capacity (`INSUFFICIENT_MODEL_CAPACITY`) → 5s/10s/20s backoff, up to 3 retries
- First-token timeout (90s default, per-model override)
- Idle timeout (300s rolling between reads)
- Empty-response retry (no text AND no tool calls)
- Stream-level `error` event retry
- profileArn resolution via `ListAvailableProfiles`, cached per endpoint
- Truncation continuation notice (`stopReason: "length"` → prepend hint)
- 413 / `CONTENT_LENGTH_EXCEEDS_THRESHOLD` → throw with `context_length_exceeded`
  prefix so pi-mono's `isContextOverflow()` matches
- `MONTHLY_REQUEST_COUNT` → throw immediately (non-retryable)

## Success criteria

1. `bun run typecheck` passes with `strict` + `noUncheckedIndexedAccess`.
2. `bun run test` passes including all 11 pi-mono standard suites
   (any skipped with `// SKIP: <reason>` comment).
3. `wc -l src/**/*.ts` ≤ 1,400.
4. Zero `any` in `src/**/*.ts`. Zero type casts in `extensions/index.ts`.
5. Fresh `bun install && bun run typecheck && bun run test` on a clean checkout
   works without `kiro-cli` installed.
6. **Extension-load verification:**
   - pi lists pi-kiro as loaded
   - `--list-models` shows the Kiro catalog
   - `kiro` appears in `/login` options
   - Unlogged-in Kiro-model request produces "credentials not set" error
     (not crash, not missing-provider error)
7. **Live smoke (human-run):**
   - Builder ID login completes
   - Single text turn → `stopReason: "stop"`
   - Tool-using turn completes
   - 20+ message session truncates cleanly
   - Forced 413 surfaces as `context_length_exceeded`

## Implementation order

1. Scaffold — package.json, vitest.config.ts, smoke test, deps
2. `src/models.ts` — model catalog + resolvers
3. `src/oauth.ts` — Builder ID device-code + refresh
4. `src/transform.ts` + `src/history.ts` — message → Kiro history
5. `src/thinking-parser.ts` + `src/event-parser.ts` — streaming parsers
6. `src/tokenizer.ts` + `src/debug.ts` — utilities
7. `src/stream.ts` — orchestrator
8. `extensions/index.ts` — pi registration
9. Port 11 pi-mono standard test suites to `test/pi-mono-suite/`
10. Extension-load verification
