---
status: accepted
---

# The LLM retry substrate stays hand-rolled

`packages/llm-agent` implements its own retry, backoff and circuit logic (`retry.utils.ts`, the execution-port circuit, the provider failover adapter) rather than adopting a retry library such as `cockatiel`, `p-retry` or `async-retry`. None of these libraries is a dependency anywhere in the workspace today. This is a deliberate choice, not unfinished work: a 2026-09 design review of #847/#848 considered replacing the stack and concluded against it.

The reason is that the hand-rolled code carries four contracts a general-purpose retry policy does not express. (1) Abort semantics are distinguished by signal state, not error type: a per-attempt timeout whose own signal aborted is retryable, while a caller abort or a global deadline is terminal (`retry.utils.ts:78-87`). (2) Every repo delay that many jobs can align on goes through one equal-jitter helper, uniform in `[nominal/2, nominal)` (`packages/bot-common/src/utils/jitter.utils.ts:11`), shared by the LLM, WISPACE, and durable outbox retry paths; library jitter is additive/subtractive around the nominal and would change that distribution. (3) `LlmAttemptBudget` is threaded through the request signature, the request types, and the observer hooks (`execution/attempt-budget.ts:43-113`) because it is the accounting unit ADR-0031 and ADR-0032 depend on, not a retry counter. (4) `boundaries.spec.ts:32-38` fails closed on vendor-named exports from the core barrel, so a library's policy types cannot reach `@wispace/llm-agent/core` consumers.

The migration was also dropped for a second, more immediate reason: the amplification it was meant to remove is not in this code. At the time of this record the worst case per tool round was **18 HTTP requests** (24 at the hard `LLM_MAX_TOTAL_PROVIDER_ATTEMPTS` cap) — `LLM_OPENAI_RETRY_MAX_ATTEMPTS` defaults to 1, so 1 execution attempt becomes 6 adapter invocations (2 quick-retries × 3 providers) and each invocation becomes 3 requests because the OpenAI client is constructed with no `maxRetries`. The `2N ≤ 8` budget recorded in `docs/project-overview.md` §7.1.1 assumed the SDK contributes zero retries, so it only holds once #750 pins `maxRetries: 0`. `attemptBudget.consume()` runs once per adapter invocation (`openai-adapter.ts:65,113`), so the budget structurally cannot bound the transport layer. The load spec from #514 (`execution/env-llm-execution-port-load.spec.ts`) counts adapter invocations against a jest mock and therefore cannot observe transport retries at all.

> **Superseded measurement (#1473).** The 18/24 figures above are kept as the record of what was true at this revision and are no longer correct. The `2N` derivation also never matched a shipped configuration: the per-provider retry count of 2 is the failover adapter's constructor fallback, and all three bots resolve it to 1. The client is now constructed with `maxRetries: 0` and an explicit timeout, so one provider attempt issues exactly one provider request and the real ceiling is `min(N, LLM_MAX_TOTAL_PROVIDER_ATTEMPTS)` — 3 provider requests for a three-provider order at the default budget, measured under a total outage. See #1473 and `docs/llm-fallback-policy.md`.

## Consequences

- A new retry path must use the shared jitter helper and must decide retryability per ADR-0033, or it will break the herd-safety and abort guarantees that the rest of the platform relies on.
- `LLM_OPENAI_RETRY_MAX_ATTEMPTS` above 1 multiplies against the failover layer, so raising it is a capacity decision, not a tuning decision. The shipped default is 1.
- The agent-loop retry layer has been removed outright (#1473). It was already disabled at every composition root; deleting it keeps the "one retry owner" rule from depending on a default nobody sets.
- #1087 is open against this substrate: `FailoverLlmProviderAdapter.isRetryableError()` returns a hardcoded `false` (`failover-adapter.ts:109-111`). That is deliberate today, because it stops outer layers re-running the whole provider chain, but it is tracked as a contract question. #953 was closed on 2026-09-09; its fix is why the failover layer now costs `providers x 1` rather than `providers x maxAttempts` during a total outage, so any future migration must preserve the post-#953 behaviour rather than the pre-#953 one.

## Rejected alternatives

- **Adopt cockatiel for retry + circuit breaker** (#847, #848): its retry handle-all cannot distinguish a per-attempt timeout from a caller abort without duplicating the signal inspection, its jitter changes a repo-wide delay contract, and `LlmAttemptBudget` would have to be rebuilt as an observer — leaving the fragile part and replacing the parts that work.
- **Compose cockatiel policies internally behind a repo-owned interface**: keeps the boundary guard, but pays a new runtime dependency in a package shared by all three bots for no reduction in amplification while #750 is open.
- **Measure before deciding**: the ceiling is derivable from the source and the existing load spec cannot observe the layer that matters; a throwaway measurement would reproduce a known number and would not have changed the verdict.
- **Fix the known defects first, then migrate**: correct in principle, but it presupposes a migration that the numbers do not justify.
