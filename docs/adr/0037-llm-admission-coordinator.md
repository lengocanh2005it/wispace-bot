---
status: accepted
---

# LLM admission coordinator across local and Redis capacity

Issue #867 unifies the admission contract for interactive chat, reports, and
study reminders. The contract is shared by all three bot processes while the
fairness policies owned by #580, #585, and #586 remain separate.

## Decision

- Each bot process has one admission coordinator shared by chat, reports, and
  reminders. The coordinator owns the local bounded FIFO queue and the optional
  Redis aggregate lease; feature adapters retain provider retry, breaker, and
  usage concerns.
- Admission uses a bounded probe loop. A request waits for a local permit,
  performs one signal-bounded Redis lease probe, and is admitted only when both
  scopes are held. A saturated or failed global probe releases the local permit
  before jittered backoff and re-queue; the local permit is never held across
  global-capacity waiting. A global lease is never held while waiting in the
  local queue.
- One Redis lease covers one provider generation, including its provider
  retries and failover. A new generation caused by persisted capacity overload
  acquires a new lease.
- Chat and report paths receive the same configured Redis client and use the
  `llm:concurrency:global` key. Enabling the global budget without a wired
  client fails startup; there is no silent local-only fallback.
- The existing bounded outcomes remain the public contract: `queue_full`,
  `wait_timeout`, `global_saturated`, and `redis_unavailable`. A single caller
  deadline covers local admission, Redis acquisition, retries, backoff, and
  provider calls; caller cancellation and deadline expiry are not rewritten as
  overload outcomes.
- Local ordering remains FIFO and this decision does not add reserved
  interactive capacity, per-learner caps, per-bot floors, or a priority queue.
  Those policies belong to the related issues above.
- Admission telemetry exposes local/global wait, local active/capacity,
  queue depth/drain lag, retry attempts, and bounded feature-class/outcome
  labels. It does not poll Redis to invent a global-active gauge or emit user,
  correlation, or raw feature identifiers as labels.

## Consequences

- Discord and Zalo no longer create independent local admission pools for chat
  and reports; one process-local cap becomes the actual cap seen by all LLM
  features.
- Redis saturation can shed a request without consuming a local permit during
  the global wait, so aggregate contention cannot occupy the whole local pool.
- The coordinator may re-queue a request after a failed global probe. Its wait
  budget and caller deadline bound that churn, and FIFO remains the only
  ordering guarantee until the fairness work in #580 lands.
- Turning on the global budget now has an explicit deployment prerequisite:
  every participating chat and report path must be wired to Redis.

## Rejected alternatives

- Local-first admission with an internally retrying Redis acquisition: this
  holds local permits while the aggregate budget is saturated.
- Redis-first admission followed by a local queue wait: this holds scarce global
  leases while local capacity is unavailable.
- Separate chat/report queues or Redis clients: this makes the configured cap
  feature-dependent and lets one path bypass the other.
- A central broker or a new priority scheduler: the admission contract does
  not own the fairness policies tracked by #580, #585, and #586.

## Verification boundary

The regression suite must use a fake Redis and fake time to cover global
contention, shared chat/report wiring, FIFO re-queue, local/global release on
success/error/abort, queue-full and wait-timeout outcomes, background versus
interactive traffic, and the no-provider-call guarantee for pre-provider
overload. Format, lint, typecheck, tests, and build remain required before
implementation is considered complete.
