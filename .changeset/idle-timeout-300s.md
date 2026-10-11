---
"@javargasm/pi-kiro": patch
---

Stop dropping turns while a reasoning model is still thinking. The stream idle timeout was 60s (180s for Opus), so models such as GPT-5.6 Sol that think silently for over a minute were cancelled and retried mid-think, failing with `idle timeout after max retries`. Every model now gets the 300s idle window.
