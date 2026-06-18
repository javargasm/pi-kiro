---
"@javargasm/pi-kiro": patch
---

fix: sanitize history to prevent Bedrock TOOL_DUPLICATE and TOOL_USE_RESULT_MISMATCH errors

Added `sanitizeHistory` defense-in-depth pass that runs after `collapseAgenticLoops`:

- Deduplicates toolUseIds within each assistant message (prevents TOOL_DUPLICATE)
- Removes orphan toolUses without matching toolResults (prevents TOOL_USE_RESULT_MISMATCH)
- Removes orphan toolResults without matching toolUses

These errors surfaced during retry loops where the same assistant message
with tool calls could be re-injected into the history.
