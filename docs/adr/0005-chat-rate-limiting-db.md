# Chat rate limiting via DB instead of Redis

> Status note: this decision describes the PostgreSQL source of truth. Redis is now an optional acceleration/store for selected counters and queue features; quota audit events are retained by the monthly cleanup cron.

FREE_FORM daily quota, idempotency, and audit events are tracked via PostgreSQL tables (`chat_daily_usage`, `chat_idempotency`, `chat_quota_events`). Reserve/refund/markCompleted are DB transactions. Burst enforcement defaults to PostgreSQL and can use memory or Redis as an optional configured store; that does not replace the PostgreSQL quota source of truth.

## Rationale

- **Simplicity**: PostgreSQL atomic operations (`UPDATE ... SET free_form_count = free_form_count + 1`) and idempotency remain sufficient for quota correctness across pods. Redis is optional for acceleration and queue-related features.
- **Audit trail**: The `chat_quota_events` table records all state changes (reserved, released, denied). The optional Redis burst store holds counters only, no audit history.
- **Natural idempotency**: The `chat_idempotency` table uses `(platform, idempotency_key)` as its primary key; the message ID is the idempotency key, so each platform message is counted only once. Redis would need additional logic to achieve this.
- **Transaction safety**: Reserve + idempotency check in the same transaction. No race conditions between pods.
- **No Redis dependency for quota correctness**: PostgreSQL remains the durable source of truth. Redis is optional for burst/queue scale-out.

## Alternatives considered

| Alternative | Reason for rejection |
|-------------|---------------------|
| Redis counters | Requires Redis infrastructure. No audit trail. Race conditions between pods unless Lua scripts are used. |
| In-memory counters | Server crash loses all state. Not durable. |
| External rate limiting service (Upstash, etc.) | Vendor lock-in, additional cost, network latency. |
| Token bucket algorithm | More complex than needed for daily quota. Better suited for real-time rate limiting. |

## Consequences

- Each chat request requires at least one DB transaction for reserve. If DB latency is high (>50ms), user experience is affected.
- The burst counter currently uses postgres (default) but can be switched to memory or Redis (R3) when performance is needed.
- Multi-pod deployments use the existing Redis-backed queue/history/burst options where configured; quota reservation, idempotency, and audit correctness remain database-backed.
- The `chat_quota_events` table is retained by `ChatQuotaEventCleanupCronService` when `CHAT_QUOTA_EVENTS_CLEANUP_ENABLED=true`.
