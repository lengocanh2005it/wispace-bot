---
status: accepted
---

# Classifier admission and telemetry boundary

Issue #861 brings the Messenger-only input classifier under the shared local
and Redis-global LLM admission contract without changing its safety posture.
The classifier keeps a hard deadline, one provider attempt, fail-open handling,
and its own local circuit; it does not inherit the main chat retry or circuit
policy. Every classifier invocation has at most one separate
`LLM_INPUT_CLASSIFIER` usage event: provider metadata and actual tokens are
preserved, failures without metadata use zero-token bounded error data, and an
open-circuit skip makes no provider call and writes no usage row. Admission,
Redis, timeout, provider, and parse failures remain bounded labels.

The existing execution API gains an explicit single-attempt/isolated-circuit
policy rather than a second classifier limiter. The classifier timeout starts
before admission, so it bounds the complete invocation; no classifier-specific
admission env var is added. When completion metadata is absent, usage
attribution uses the resolved classifier provider/model with zero tokens. The
existing shared admission rejection counter and classifier verdict counter are
reused with their closed label sets; no new classifier outcome metric is
needed.

The policy is selected by one classifier execution mode rather than independent
retry/circuit booleans. If `LLM_EXECUTION_ENABLED=false`, the optional
classifier is skipped with bounded `execution_disabled` telemetry: it never
passthroughs to the provider and creates no usage row. Verdict and failure
labels come from closed registries in `llm-agent`, so metric labels cannot grow
from arbitrary provider or model text.

`PlatformAgentService` remains the sole usage owner because it carries learner
identity and correlation context; the framework-free classifier only returns
metadata. Caller cancellation is the bounded `aborted` outcome, distinct from
the deadline `timeout`, and neither is retried. Admission, Redis, and caller
abort do not increment the classifier provider-health circuit; provider error,
provider timeout, and parse failure do. Shadow mode always proceeds to normal
chat, while enforce mode maps every unavailable outcome to the deterministic
classifier safety fallback and never fabricates `CRISIS`.

Model-generated reasons stay available in memory for extraction/non-disclosure
routing, but persistence redacts them at the `LlmSafetyCore` boundary and
never stores raw reason text in safety-event columns or payloads. Caller
cancellation is propagated through admission and the provider request so no
slot survives abort or completion. Discord/Zalo rollout and the #650 verdict
cache remain separate scope.

This supersedes only the shared-admission exclusion in ADR-0030. ADR-0030's
no-retry, fail-open, local-circuit, and Messenger-only decisions remain in
force.

## Alternatives rejected

- Routing the classifier through the full chat execution path would introduce
  retries and couple classifier health to the main chat circuit.
- Keeping a classifier-only limiter would make `LLM_MAX_CONCURRENT` and the
  Redis-global budget lie about actual fleet usage.
- Redacting only at the caller would leave future safety-event writers able to
  persist the raw model-generated reason.

The regression suite must prove single usage ownership, redaction in both the
`reason` column and JSON payload, in-memory extraction routing, and exactly-once
local/global slot release across success, provider error, timeout, caller
abort, and pre-provider rejection. Verification remains limited to
`llm-agent`, `chat-agent`, `chat-metering`, and Messenger; Discord/Zalo parity
and the #650 cache stay out of scope.
