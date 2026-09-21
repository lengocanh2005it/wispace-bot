---
status: accepted
---

# LLM execution breaker health classification

The two shared LLM execution breakers use one classification derived from the provider adapter's normalized error reason, extending the timeout and cancellation boundary in [ADR-0033](0033-llm-timeout-and-cancellation-semantics.md). Provider adapters normalize known request-validation statuses `400` and `422` to `bad_request` after applying quota, auth, and rate-limit precedence. A deterministic request rejection (`bad_request`) never counts toward the shared execution circuit; caller cancellation and non-provider failures remain excluded. Every other provider-side class, including `network`, `timeout`, and `unknown`, is treated as an upstream-health signal. For failover, the exhaustion error carries the normalized reasons seen across candidates: health wins when any candidate produced a health signal, and the generation is excluded only when every candidate rejection is deterministic.

The execution path exposes these low-cardinality classes through `llm_execution_circuit_failures_total{error_class}`, once per terminal top-level execution, including excluded `bad_request` outcomes for visibility. This decision covers the Messenger Opossum breaker and the shared Discord/Zalo/report execution port; failover cooldown policy (#1087) and the input-classifier breaker (#863) remain separate consumers.
