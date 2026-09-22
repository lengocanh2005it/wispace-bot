---
status: accepted
---

# Complete bounded, metered input-classifier execution path across all bots

Issue #868 completes the input-classifier execution path, expanding tier-2 input
classification into a cross-platform, bounded, fully metered phase of chat
execution while preserving fail-open, hard-deadline, and shadow-first semantics.
It resolves platform divergence (#864), refines breaker taxonomy (#863), and
coordinates with unified admission (#867).

## Decision

- **Cross-platform Parity (#864)**:
  `LlmContentClassifier` is wired in all three bot processes (Messenger, Discord,
  and Zalo) via their respective chat modules using the shared `LlmExecutionPort`
  and `LlmAdmissionCoordinator`.
  All five `LLM_INPUT_CLASSIFIER_*` environment variables are exposed across all
  platforms with identical shadow-first defaults (`ENABLED=false`, `ENFORCE=false`).
  Enabling `LLM_INPUT_CLASSIFIER_ENABLED=true` without required collaborators or
  configuration fails closed at bootstrap with explicit error feedback; silent
  no-ops are prohibited.

- **Circuit Breaker Taxonomy (#863)**:
  Classifier circuit breaker failures are partitioned into dependency-shaped and
  input-shaped classes.
  - **Dependency-shaped** (`timeout`, `error`, `rate_limited`): indicate provider
    unhealth or capacity exhaustion; they increment consecutive failures and trip
    the local breaker after reaching the failure threshold (5). A failure during
    a half-open probe re-opens the circuit for 30s.
  - **Input-shaped** (`parse_failed`): indicates learner text induced invalid JSON
    or unknown enum labels despite a healthy provider response. It fails open for
    that individual turn and emits verdict metric `llm_classifier_verdict_total{reason="parse_failed"}`,
    but does **not** increment consecutive failures. When encountered during a
    half-open probe, it confirms provider reachability and **closes** the circuit.
  - Pre-provider admission rejections, caller cancellations, and disabled execution
    bypass breaker accounting.

- **Rate Limit Classification**:
  HTTP 429 / provider rate limit errors during the classifier's single attempt are
  classified under a dedicated bounded label `rate_limited` in `CLASSIFIER_FAILURE_REASONS`
  and `ClassifierOutcomeLabel`, rather than generic `error`.

- **Kill-Switch Defense-in-Depth**:
  `LLM_EXECUTION_ENABLED=false` acts as a hard emergency stop. In addition to
  `LlmContentClassifier` skipping with `execution_disabled`, `EnvLlmExecutionPort`
  and `LlmExecutionService` reject any call with `executionMode === 'classifier'`
  when execution control is disabled, preventing unmetered passthrough calls.

- **Usage Ledger Attribution**:
  Every started classifier invocation that passes skip guards is recorded exactly
  once in the usage ledger under feature `LLM_INPUT_CLASSIFIER`.
  - Successful invocations and `parse_failed` with provider metadata record actual
    prompt, completion, cached tokens, and estimated cost.
  - Invocations failing at admission (`queue_full`, `wait_timeout`, `global_saturated`,
    `redis_unavailable`) or provider errors without completion metadata (`timeout`,
    `error`, `rate_limited`) record a single row with 0 tokens, `status: 'error'`,
    and `errorMessage: <reason>`.
  - Circuit-open skips (`skipped_circuit_open`) and execution-disabled skips
    (`execution_disabled`) produce no ledger row.
  - Raw learner text is never persisted.

## Consequences

- Discord and Zalo gain tier-2 prompt injection and disclosure probe defense,
  matching Messenger security posture.
- A single user submitting adversarial or malformed payloads cannot trip the fleet
  circuit breaker and disable safety gating for other learners.
- Rate limits and capacity issues are distinctly visible in metrics and usage
  telemetry without inspecting raw logs.
