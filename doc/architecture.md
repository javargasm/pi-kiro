# Architecture

## What this package does

pi-kiro gives pi a way to talk to Kiro. Three jobs, nothing else:

1. **Get a valid credential.** Login + token refresh via AWS SSO-OIDC
   (Builder ID for personal accounts, IAM Identity Center for enterprise).
2. **Translate pi's provider-agnostic calls into Kiro's request shape.**
   pi sends `Message[]` + tools + system prompt. Kiro wants
   `userInputMessage`/`assistantResponseMessage` entries with strict
   alternation, its own tool-use schema, and a CodeWhisperer streaming
   endpoint with AWS-SDK-style headers.
3. **Translate Kiro's streaming response back into pi's event stream.**
   Kiro emits brace-balanced JSON frames over an AWS Event Stream binary
   envelope, with reasoning inlined as `<thinking>` tags in the text
   stream. pi expects typed events (`text_delta`, `thinking_delta`,
   `toolcall_end`, etc.).

Everything else — history sizing, compaction, retry-on-overload, message
sanitization for cross-provider handoff — is pi-mono's responsibility and
is handled upstream before pi-kiro ever sees the context.

## Client-fidelity modules

Beyond the three core jobs, a few modules exist to make pi-kiro's traffic
indistinguishable from the real Kiro CLI and to smooth the login UX:

- **`kiro-defaults.ts`** — captured Kiro CLI identity constants: the
  synthetic system seed pair every conversation opens with, the
  `__tool_use_purpose` field appended to every tool schema, the
  `process.platform → operatingSystem` map, and the context-usage percent
  (`COMPACTION_THRESHOLD_PCT`) at which we inflate `usage.input` to force
  pi's overflow detection before a 413.
- **`kiro-tools.ts`** — static native Kiro CLI tool schemas extracted from
  real request captures, injected verbatim so the request is structurally
  identical to the official client. MCP tools (codegraph, pencil) are
  intentionally omitted because pi handles those directly.
- **`kiro-cli-sync.ts`** — optional zero-friction login. If Kiro IDE is
  installed and logged in, this reads its local SQLite credential DB
  (readonly) and adapts the tokens into `KiroCredentials`, and can write
  refreshed tokens back for bidirectional sync.
- **`health.ts`** — classifies error strings as permanent (expired/revoked
  grants → surface a re-login error) vs transient (let the retry loop run).

## File map

```
pi-kiro/
├── src/
│   ├── extension.ts        Entry point. Registers provider with pi. Reads
│   │                       auth.json, fetches the dynamic model catalog,
│   │                       self-heals a missing `type:"oauth"` marker.
│   ├── core.ts             Standalone re-exports for non-pi consumers.
│   ├── oauth.ts            (1) Auth. Device-code login + token refresh
│   │                       (Builder ID + IAM Identity Center).
│   ├── kiro-cli-sync.ts    (1) Optional zero-friction login: imports
│   │                       credentials from Kiro IDE's local SQLite DB.
│   ├── models.ts           Model catalog, SSO→API region map, dynamic
│   │                       model fetch + cache, runtime-url resolver.
│   ├── kiro-defaults.ts    Kiro CLI identity constants (system seed,
│   │                       tool-purpose field, OS map, compaction pct).
│   ├── kiro-tools.ts       Static native Kiro CLI tool schemas, injected
│   │                       verbatim so requests match the real client.
│   ├── transform.ts        (2) pi Message[] → Kiro request body + history
│   │                       maintenance (merge, truncate, sanitize).
│   ├── stream.ts           (2)+(3) HTTP orchestrator. Builds request,
│   │                       consumes stream, handles Kiro-specific errors.
│   ├── event-parser.ts     (3) Kiro JSON frame extractor.
│   ├── thinking-parser.ts  (3) Splits inline <thinking> tags into
│   │                       structured ThinkingContent blocks.
│   ├── tokenizer.ts        ~4-chars/token heuristic when usage event absent.
│   ├── health.ts           Permanent-vs-retryable error classification.
│   └── debug.ts            Leveled logger gated by KIRO_LOG.
└── test/
    ├── <per-module>.test.ts
    └── pi-mono-suite/      pi-mono standard suites (live-gated).
```

## Data flow — streaming request

```
pi.Context (Message[])
        │
        ▼
transform.normalizeMessages ── drops errored/aborted assistants
        │
        ▼
transform.buildHistory  ── merges consecutive user / tool-result entries
                          to satisfy Kiro's strict alternation
        │
        ▼
stream.streamKiro       ── POST /generateAssistantResponse
        │
        ├── resolveProfileArn (cached)     ── AmazonCodeWhispererService.ListAvailableProfiles
        ├── first-token timeout (90s)
        ├── idle timeout (300s rolling)
        ├── 403 → bust profileArnCache, surface re-login error
        ├── INSUFFICIENT_MODEL_CAPACITY → backoff → retry
        ├── MONTHLY_REQUEST_COUNT → non-retryable, throw
        ├── 413 / CONTENT_LENGTH_EXCEEDS_THRESHOLD → context_length_exceeded
        ├── empty response → retry
        └── stream error → retry
        │
        ▼
event-parser.parseKiroEvents ── brace-balanced JSON extraction
        │
        ▼
thinking-parser.ThinkingTagParser ── splits <thinking> from text
        │
        ▼
pi.AssistantMessageEventStream ── start/text_delta/toolcall_end/done/error
```

Context-window management (history truncation, compaction, retry-on-
overload) happens upstream in pi-coding-agent. Kiro 413 responses surface
as `context_length_exceeded`, which pi's compactor recognizes and handles.

## OAuth flow

Two login methods, both using AWS SSO-OIDC device-code:

- **Builder ID** (personal) — fixed start URL
  `https://view.awsapps.com/start`, fixed region `us-east-1`.
- **IdC** (enterprise) — user-supplied start URL
  (e.g. `https://mycompany.awsapps.com/start`); region is either supplied by
  the user or auto-detected by probing common AWS regions.

```
loginKiro(callbacks)
  ├── prompt: blank → Builder ID, URL → IdC
  ├── (IdC) prompt: region (or blank to probe)
  ├── POST /client/register      → { clientId, clientSecret }
  ├── POST /device_authorization → { userCode, verificationUriComplete, deviceCode }
  ├── callbacks.onAuth({ url, instructions: "Your code: XXXX" })
  └── poll POST /token until {accessToken, refreshToken}

refreshKiroToken(credentials)
  └── POST https://oidc.{region}.amazonaws.com/token
        {grantType: "refresh_token", clientId, clientSecret, refreshToken}
```

Credentials shape (internal extension of `OAuthCredentials`):

```typescript
interface KiroCredentials extends OAuthCredentials {
  refresh: string;       // `${refreshToken}|${clientId}|${clientSecret}|${authMethod}`
  access: string;        // current access token
  expires: number;       // ms epoch, with 5-min buffer subtracted
  clientId: string;
  clientSecret: string;
  region: string;        // SSO region (Builder ID: us-east-1; IdC: probed or supplied)
  authMethod: "builder-id" | "idc";
}
```

## Region mapping

```
SSO region            → Kiro API region
us-east-1 / us-east-2 → us-east-1
eu-west-1 / eu-west-2 / eu-west-3 / eu-north-1 / eu-central-1 → eu-central-1
```

AP regions and any unmapped SSO region pass through unchanged. See
`API_REGION_MAP` in `src/models.ts` for the authoritative list.

Applied via the `modifyModels` hook in `src/extension.ts` after login,
before requests. It filters the model catalog to what's available in the
resolved API region and rewrites `baseUrl` to
`https://q.{apiRegion}.amazonaws.com/generateAssistantResponse`.

## Debug levels

```
export type LogLevel = "error" | "warn" | "info" | "debug";
```

- `error` — unconditional, goes to `console.error`.
- `warn` — default-on (retries, degraded paths).
- `info` — off by default (session milestones).
- `debug` — off by default (request/response snapshots).

Configured by `KIRO_LOG=debug|info|warn|error`. Default is `warn`.

## Component coupling

```
src/extension.ts
    └── imports: models, oauth, stream, debug

src/stream.ts (largest module)
    ├── imports: models, transform, event-parser, thinking-parser,
    │            tokenizer, kiro-defaults, kiro-tools, debug,
    │            pi-ai types + helpers
    └── no imports from: oauth (decoupled — token arrives via options.apiKey)

src/oauth.ts
    └── imports: debug, health — pure AWS SSO-OIDC otherwise

src/kiro-cli-sync.ts
    └── imports: debug — readonly SQLite access otherwise

src/transform.ts
    └── imports: kiro-defaults, pi-ai types

src/kiro-tools.ts
    └── imports: transform (KiroToolSpec type) only — static schema data

src/thinking-parser.ts + src/event-parser.ts
    └── imports: pi-ai types only (self-contained parsers)

src/health.ts + src/tokenizer.ts
    └── no internal imports (leaf utilities)
```

Low coupling. `stream.ts` is the only module that imports broadly; that's
appropriate for an orchestrator.

## What pi-mono handles (not our job)

| Concern | Where it lives |
|---|---|
| Message normalization across provider handoff | `pi-ai/providers/transform-messages.ts` (built-in providers) |
| Context-overflow detection from error messages | `pi-ai/utils/overflow.ts` (`isContextOverflow`) |
| Auto-compaction on overflow + threshold | `pi-coding-agent/core/agent-session.ts` |
| Auto-retry on overloaded / rate-limit / 5xx | `pi-coding-agent/core/agent-session.ts` (`_isRetryableError`) |
| Token refresh before stream when `expires` passed | `pi-coding-agent/core/auth-storage.ts` (`refreshOAuthTokenWithLock`) |
| Event stream factory | `pi-ai` (`createAssistantMessageEventStream`) |
| Cost calculation | `pi-ai` (`calculateCost`) |
| Type definitions | `pi-ai` (`Message`, `AssistantMessage`, `Tool`, `Model`, `Context`, `SimpleStreamOptions`, `OAuthCredentials`, etc.) |

If pi-mono grows a new capability that covers something we currently do
(e.g. exporting `transformMessages` from its package root), delete our
version.
