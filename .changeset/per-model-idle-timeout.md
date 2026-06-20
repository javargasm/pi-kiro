---
"@javargasm/pi-kiro": patch
---

Add a per-model idle timeout and raise it to 180s for high-effort reasoning models (Opus 4.8 / 4.7, Fable 5).

The stream idle timer only resets on parsed events (not raw keepalive bytes), so during long silent deliberation at `high`/`xhigh` effort the upstream can go quiet for well over the previous hardcoded 60s window. The timer then fired and, after `MAX_RETRIES`, the stream died with `Kiro API error: idle timeout after max retries` mid-turn, even though the model was still working.

`idleTimeout` now mirrors the existing `firstTokenTimeout` pattern: a per-model override resolved from the catalog, defaulting to 60s and set to 180s for the slow reasoning models (and for any `claude-opus*` / `claude-fable*` id loaded dynamically from the API). Non-reasoning models keep the 60s default.
