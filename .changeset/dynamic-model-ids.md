---
"@javargasm/pi-kiro": patch
---

Accept any model Kiro advertises, including ones loaded from the disk model cache. Newly launched Kiro models (e.g. `claude-sonnet-5-5`) showed up in pi's model picker but failed with `Unknown Kiro model ID` whenever pi started from a fresh cache, because only a live `ListAvailableModels` fetch registered their IDs.
