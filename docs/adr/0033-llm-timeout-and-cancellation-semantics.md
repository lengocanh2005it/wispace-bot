---
status: accepted
---

# LLM timeout and cancellation semantics

The shared execution boundary distinguishes caller cancellation, a provider-side per-attempt timeout, and the global execution deadline. Caller cancellation is terminal and excluded from breaker accounting; a per-attempt timeout reaches the provider classifier and may be retried; a global deadline starts no new provider attempt and counts as an execution-circuit failure only when a provider call was in flight.

Execution-circuit accounting is per failed top-level execution, not per retry attempt, and excludes admission/Redis failures. Messenger's Opossum path and the shared Discord/Zalo execution port use per-request failure context rather than error names alone; the provider failover circuit keeps its existing abort guard so this decision does not create another retry layer.

## Consequences

- Slow providers can consume the configured retry budget and eventually open the shared execution circuit instead of remaining invisible as cancellations.
- A learner who cancels a request cannot poison the shared breaker, and queue/Redis pressure cannot be mistaken for provider health.
- Wrapped SDK timeout errors remain classifier-owned once the attempt signal proves the timeout was internal.

## Rejected alternatives

- Treating every `AbortError`/`TimeoutError` as caller cancellation: this hides slow providers and prevents recovery protection.
- Retrying every abort-shaped error unconditionally: this would retry caller cancellations and can amplify load.
- Incrementing the breaker for each provider attempt: this opens the circuit after one request exhausts its local retry budget.
