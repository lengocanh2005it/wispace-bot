---
status: accepted
---

# Shared LLM provider-attempt budget

Issue #1247 introduces one shared provider-attempt budget for each top-level LLM generation so agent retry, execution retry, and provider failover cannot multiply actual provider calls. The budget counts the initial HTTP call, defaults to six calls, accepts only configured values from one through eight, and is consumed by a shared `LlmAttemptBudget` at the provider-call boundary; existing layer caps and app defaults remain independent ceilings, while abort/deadline and terminal-cause semantics stay unchanged.

The budget spans all tool rounds in one chat agent run and applies to report/reminder generations, but not to the dedicated no-retry input classifier or a later durable chat-queue flush replay. A replay starts a new generation and receives a fresh budget. When the budget is exhausted, the next retry/failover call is skipped and the existing normalized cause is preserved. Provider-attempt telemetry remains per actual provider call, with one additional total-attempt observation per generation; `LLM_EXECUTION_ENABLED=false` remains an uncontrolled passthrough exception.

## Consequences

- A total provider outage is bounded by the shared cap instead of the product of retry-layer caps, including across multiple chat tool rounds.
- Per-layer tuning remains backward-compatible, but a layer cannot exceed the shared cap in effect.
- Queue recovery can still multiply work across replays; durable replay budgeting is intentionally a separate decision.

## Rejected alternatives

- Deriving the total from the product of layer settings: the product was only documented, not enforced, and changes with provider topology.
- Persisting the counter through queue replay: this would turn a provider-call budget into a durable workflow concern and expand the issue boundary.
- Routing the input classifier through the shared budget: its dedicated timeout, circuit, and no-retry safety contract is recorded in ADR-0030.
