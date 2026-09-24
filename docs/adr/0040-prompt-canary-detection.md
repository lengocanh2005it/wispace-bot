---
status: accepted
---

# Per-process prompt canary detection

Issue #1285 adds one 128-bit CSPRNG canary per bot process to the shared composed chat system prompt; startup fails if it cannot be generated. The composer carries it as data-only `Process marker: <value>`; the existing core non-disclosure rule supplies behavior, and `CHAT_SYSTEM_PROMPT_CORE` and fixture hashes remain unchanged. The shared final-output guard checks the canary before static leak markers using existing canonical candidates, reports a distinct reason, and replaces a hit with the exact `buildNonDisclosureReply()` used for static prompt leaks and disclosure probes.

The offline eval harness uses a fixed test-only 32-hex marker. Each runtime hit increments a bounded counter and fires a critical alert immediately, labeled only by job and platform. No database event is written. Canary text, raw replies, and raw reply content must not appear in logs, history, events, metrics, alerts, or other persisted telemetry. Masked external IDs may follow the existing logging policy; external IDs must not enter metrics, alerts, or events. ADR-0035's pinned-facts boundary remains unchanged; #1055 stays separate.
