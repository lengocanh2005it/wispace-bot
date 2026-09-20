---
status: accepted
---

# Input-classifier failure policy

The optional Messenger-only Tier-2 input classifier is a safety check, not the
source of truth for ordinary chat routing. Its existing timeout and local
circuit protect the provider call, but the old caller contract treated every
failure as an implicit `SAFE` result and let raw learner text continue to the
main LLM. That made outages silent and left classifier usage outside the LLM
cost view.

## Decision

- Keep the classifier's dedicated timeout, no-retry call, and local circuit
  (five consecutive failures, 30-second open period, one half-open probe).
- Keep shadow mode observational. A typed classifier-unavailable result emits
  bounded failure telemetry and the normal chat path continues.
- In enforce mode, classifier unavailability returns the existing deterministic
  chat failure fallback, does not call the main LLM or tools, and is not added
  to history. It records a bounded `classifier_unavailable` degraded outcome.
- A real `CRISIS` verdict in enforce mode uses the existing crisis handoff and
  bypasses the normal confidence floor. Shadow mode still records the verdict
  without changing the reply. An outage never fabricates a `CRISIS` verdict.
- Classifier input uses credential redaction plus the existing bounded
  full/head-tail projection. Injection text remains visible to the classifier;
  the prompt-sanitization pipeline must not neutralize the signal first.
- Classifier usage is recorded under the separate `LLM_INPUT_CLASSIFIER`
  feature. Successful responses and parse failures preserve provider metadata;
  attempted calls without metadata write a zero-token error row. An open
  circuit made no provider attempt and therefore writes no usage row.
- The framework-free classifier port returns completion metadata; the platform
  agent owns usage recording because it owns the learner identity and
  correlation context. The classifier remains Messenger-only; Discord/Zalo
  parity is tracked separately by #864.

## Alternatives rejected

- Failing closed in every mode would turn the optional shadow rollout into a
  broad availability gate and would block ordinary chat during a classifier
  outage.
- Treating every outage as `CRISIS` would invent a sensitive verdict without
  evidence and would send a crisis handoff for ordinary learner messages.
- Reusing `FREE_FORM_CHAT` would hide classifier spend inside conversational
  cost and prevent per-feature cost attribution.
- Running the classifier through the main shared admission/retry path would
  couple its small safety check to the main chat budget and multiply latency.

## Consequences

The glossary distinguishes a classifier verdict from `classifier unavailable`
and from the `classifier safety fallback`. The classifier-down regression
fixtures must cover shadow pass-through, enforce fallback, low-confidence
`CRISIS` enforcement, metadata-preserving parse failure, redacted provider
input, and the no-call open-circuit path. The original #649 shadow-first
behavior remains valid for shadow mode; this ADR supersedes its fail-open
description for enforce-mode outages.

Related: #1256, #649, #1054, #982, #864, ADR-0026.
