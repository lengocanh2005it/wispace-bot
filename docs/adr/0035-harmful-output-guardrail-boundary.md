---
status: accepted
---

# Harmful-output guardrail boundary

Issue #1377 extends the shared final-output guard with bounded deterministic
patterns for `self_harm_instruction` and `targeted_harassment` in Vietnamese,
English, and Chinese, reusing the existing canonical scan candidates. A match
replaces the whole model reply with `buildFinalOutputBlockedMessage()`, marks
the reply `skipHistory`, and does not retry the model. Grounding and existing
prompt/credential/vendor leak checks retain their current precedence; pinned
facts remain a trusted, bounded server-derived post-processing boundary and do
not trigger a second scan.

Each harmful replacement emits one `HARMFUL_OUTPUT_BLOCKED` safety event with
the bounded reason/category and assistant text stored only as a redacted
excerpt, SHA-256 hash, and length. #1377 owns harmful egress, #651 owns the
semantic output judge, and #652 owns input moderation; the offline fixtures
must-block actionable instructions/targeted harassment and must-allow
academic, prevention, fictional, translation, and constructive-criticism
controls.
