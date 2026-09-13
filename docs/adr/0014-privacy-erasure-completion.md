# Privacy erasure completion and recovery

## Status

Accepted.

## Decision

Privacy erasure is complete only when the database transaction and every applicable platform-owned state cleanup succeed after a bounded request-time retry. The transaction creates one durable cleanup job per identity and store with a deterministic idempotency key; an own-platform reconciler retries those jobs with capped backoff until the store is cleared or the ownership-generation fence makes the job stale. The API returns an explicit `complete` or `incomplete` outcome (`202` for incomplete) and keeps `deleted`/`unlinked` as mutation booleans only. A generation conflict is a separate `409` outcome and creates no cleanup job.

## Consequences

Cleanup adapters must be idempotent, and job records contain the raw external identity needed to address Redis but never expose it in logs or metric labels. Each bot owns only its platform's state; WISPACE cache invalidation remains in #877 and ownership fencing remains in #856.

## Operational contract

Jobs use `pending → processing → completed|stale`; an expired processing lease returns to `pending`. Retryable Redis failures never become terminal merely because the request-time budget ended. The request uses three attempts; the reconciler uses a five-minute tick, a 100-row batch, and a 60-second lease. These are constants until operations show a need to tune them.

The transaction creates jobs even when the mapping is already absent if an applicable platform store may still contain state. Jobs are partitioned by the owning bot's platform; no cross-platform callback is reused. The additive migration has no backfill and must land before the new code through the existing migration barrier. Completed and stale jobs are retained for seven days.

The response keeps `deleted`/`unlinked` as DB-mutation booleans but makes `status` authoritative. Complete responses are `200`; incomplete responses are `202` and include `cleanupId` plus canonical store names. Expected-generation mismatches remain `409` conflicts. Coverage includes unit, transaction, relink-fence, Redis-unavailable, fresh-worker, and all-platform HTTP contract tests.
