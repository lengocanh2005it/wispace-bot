---
status: accepted
---

# Per-learner LLM admission cap

Issue #1261 adds a per-learner in-flight cap for `FREE_FORM_CHAT` before local FIFO and global admission. A linked turn uses the WISPACE `userId`; an anonymous turn uses `(platform, externalUserId)`, captured as a snapshot for the execution. The cap defaults to one, holds through queue waits and provider retries, and reports the typed `user_saturated` overload without user IDs in metric labels. Redis-enabled deployments enforce the key across the fleet; without Redis the scope is explicitly process-local. Reports, reminders, reserved interactive capacity, and priority scheduling remain outside this slice and belong to #580.
