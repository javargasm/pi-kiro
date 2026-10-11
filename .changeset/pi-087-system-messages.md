---
"@javargasm/pi-kiro": patch
---

Support pi >= 0.87 system messages: fold `role: "system"` transcript entries into the Kiro system prompt and tool list instead of treating them as tool results, which crashed every request with `The "data" argument must be of type string ... Received undefined`.
