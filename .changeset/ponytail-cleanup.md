---
"@javargasm/pi-kiro": minor
---

Trim the provider down to its three jobs (credentials, request translation, stream translation).

- **Requires Node >= 22.13.** Kiro CLI DB import now uses `bun:sqlite` or Node's built-in `node:sqlite`; the optional `better-sqlite3` and system `sqlite3` CLI fallbacks are gone.
- Token refresh cascade is now 3 layers; the "expired kiro-cli import" layers never produced a different credential and were removed.
- Removed: applying `chat.defaultModel` from `~/.kiro/settings/cli.json` on session start, collapsing repeated tool-call loops in replayed history, and the `scripts/pi-kiro-debug.sh` launcher (use `KIRO_LOG=debug KIRO_LOG_FILE=<path> pi`).
- `pi-kiro/core` no longer exports `getKiroCliCredentialsAllowExpired` or `collapseAgenticLoops`.
- The browser sign-in pages are now plain HTML.
