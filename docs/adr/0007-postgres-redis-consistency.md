# ADR-0007 — Postgres/Redis consistency boundaries

## Status

Accepted and implemented for issue #609.

## Decision

Postgres is authoritative whenever a Redis value represents a persisted quota
or idempotency decision. Redis is an advisory acceleration layer and may be
missing or stale for at most its configured TTL. A reconciliation pass never
blindly overwrites Redis with a count: it invalidates a divergent advisory key
so the next request is rebuilt from Postgres.

The burst policy remains a sliding 60-second window in the Postgres reserve
transaction. Redis retains its fixed epoch-minute bucket as an approximation;
the boundary difference is documented and is not rewritten by the audit.
Advisory keys are not decremented when a persisted reservation is refunded:
the key has no idempotency token, so a late or cross-pod refund could decrement
another reservation. The audit includes users whose eligible Postgres count is
zero, then deletes any present stale key.

| Datum | Authority | Redis role | Repair direction |
| --- | --- | --- | --- |
| Daily usage and idempotency | `chat_daily_usage` / `chat_idempotency` | none | N/A |
| Burst counter | Postgres reservation rows | fast advisory precheck | delete divergent key; PG enforces final decision |
| Display-name cache | `users` / `"Users"` view | TTL cache | miss/refetch only |
| Chat queue buffer + indexes | Redis buffer JSON | durable queue state and indexes | rebuild indexes from valid buffer; remove stale indexes |
| Malformed queue payload | quarantine key | retained for inspection | rename to hashed quarantine key, never replace with empty state |
| Chat history | Redis/memory TTL store | context only | no Postgres counterpart |
| LLM global slot | Redis lease | cross-pod concurrency lease | lease expiry/fencing, never synthesize a PG row |

The queue has no current Postgres job table (the historical
`messenger_chat_queue_buffer` table was removed), so Redis is its source of
truth. A buffer without an index is indexed from its JSON; an index without a
buffer is removed. Processing leases are not replayed by reconciliation: the
existing lease/stuck recovery path owns that safety decision.

## Operational contract

The burst audit runs once per minute when Messenger uses `CHAT_BURST_STORE=redis`.
The shared queue worker runs one bounded reconciliation pass per minute on each
bot. Candidate reads are bounded; incomplete scans report `partial`. Repairs
are idempotent and use platform-prefixed keys (`burst:<platform>:...` and
`chat:queue:<platform>:...`); Messenger reads/migrates its legacy keys once.

`<prefix>_redis_consistency_drift{datum}` reports unresolved drift and
`<prefix>_redis_consistency_events_total{datum,outcome}` records detection,
repair, quarantine, and infrastructure outcomes. `RedisConsistencyDrift`
alerts after two minutes of unresolved drift; recent quarantine/unavailable
events also trigger it even after a quarantined key leaves the active index.
Redis outages remain visible via the existing readiness/Redis health signals
(#516); a failed audit never makes the quota or queue path fabricate state.
