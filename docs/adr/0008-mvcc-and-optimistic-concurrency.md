# ADR-0008 — MVCC and optimistic-concurrency direction

## Status

Accepted for issue #576. Decision/documentation only — no runtime code changed.
The concurrent-flow inventory below was reviewed and every flow already has a
correct guard, so no version/CAS guard was added.

## Decision

PostgreSQL MVCC at the default `READ COMMITTED` isolation level is the baseline
for every concurrent flow in this repo. The codebase does **not** add a generic
application-level MVCC / "version column on every table" layer. A concurrency
mechanism is only introduced for a flow with a concrete stale-update or
lost-update problem, and then the narrowest tool that solves it:

| Mechanism | Use when | Reference in this repo |
| --- | --- | --- |
| `READ COMMITTED` (default), no extra locking | The write is a single atomic statement, or a unique constraint already prevents the bad interleaving. Most flows. | Quota reserve — `chat_idempotency` row written in the reserve transaction (`packages/chat-metering/src/chat-rate-limit/chat-rate-limit.repository.ts`). |
| Single-statement compare-and-set (`INSERT … ON CONFLICT … DO UPDATE … WHERE <guard>`, or `UPDATE … WHERE <guard>`) | Claiming/leasing a row, or a counter cap, where the guard and the write must be one atomic statement. Correct under `READ COMMITTED` without row locks. | Report/job claim — `INSERT INTO scheduled_report_claims … ON CONFLICT (platform, external_user_id, report_date) DO UPDATE … WHERE scheduled_report_claims.status = 'released'` (`packages/database/src/services/platform-report-claim.repository.ts`, and an identical copy in `apps/messenger-bot/src/modules/messenger/infrastructure/persistence/messenger.repository.ts`). Webhook inbox claim — `UPDATE webhook_inbound_events SET status='processing', lease_token=… WHERE id=… AND status IN ('pending','failed')` (`packages/webhook-inbound/…/platform-webhook-inbound-event.service.ts`). Reschedule confirmation claim — `takeValid()` `UPDATE reschedule_confirmations SET status='processing', lease_token=… WHERE external_id=… AND status='pending' AND expires_at > now()` (`packages/database/src/services/typeorm-reschedule-store.ts`). Reschedule daily budget — `INSERT … ON CONFLICT DO UPDATE SET count = count + 1 WHERE count < cap RETURNING count` on `chat_tool_daily_usage` (#626). |
| Opaque lease token + time-based stale recovery | Long-running processing of a claimed row across pods, where the worker may crash mid-way. The token gates every later transition; a separate time threshold reclaims abandoned rows. | Webhook inbox — `lease_token` (random UUID, **no expiry column**); stale recovery compares `updated_at < now() - processingStuckMs` and marks `abandoned` with no replay. Reschedule confirmation — `lease_token` + `processing_started_at`; `recoverStaleProcessing()` reverts to `pending` past a threshold. Report claim — `lease_token` + `lease_expires_at`. |
| `SELECT … FOR UPDATE` + re-read inside a transaction | A single row must be read, decided on, and written with no other writer in between, and the decision cannot be expressed as one statement. | Zalo OA token refresh — `pessimistic_write` lock, re-read after lock, so a single-use refresh token is never submitted twice (`apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-token.service.ts`). |
| Optimistic `version` column CAS (`UPDATE … WHERE id=… AND version=… SET version = version + 1`) | Multiple equal writers, no natural key or status to CAS on, and pessimistic locking is undesirable. | **Only** `zalo_oa_tokens.version` (plain `@Column`, not `@VersionColumn`), and there it is a *second* layer on top of the `FOR UPDATE` above — belt-and-suspenders, kept because a wrong outcome burns a single-use token. This is the reference implementation if a second flow ever genuinely needs the pattern. |
| PostgreSQL advisory lock (`pg_try_advisory_lock` via `PgAdvisoryLockService`) | Cross-pod mutual exclusion of a whole periodic job — leader election — not per-row contention. | Cron leader election: study-reminder sync/cleanup, report cron, webhook-inbound retry + retention cron. Registry/scope tracked in #688. |
| Redis Lua script (atomic per key) | A cross-pod counter/limiter that must not touch PostgreSQL. | LLM global slot limiter (`INCR`/`PEXPIRE` + lease key); outbound rate limiter (reads `redis.call('TIME')` rather than trusting a client timestamp). See ADR-0007 for the Redis↔Postgres authority rules. |
| `SERIALIZABLE` / `REPEATABLE READ` transactions | A multi-row invariant that cannot be expressed as a constraint or a single-statement guard, and the write rate is low enough to absorb serialization failures + retry. | **Not used anywhere.** No code passes `isolationLevel`; the only `SET TRANSACTION` in the tree is `SET TRANSACTION READ ONLY` in `packages/ops-health/src/typeorm-data-quality.repository.ts`. Reach for this only with a concrete invariant in hand. |

### Do not

- Do not add a generic `@VersionColumn` / optimistic-lock layer across entities.
  There is exactly one flow (`zalo_oa_tokens`) that needs version CAS; a repo-wide
  layer is speculative flexibility.
- Do not raise the isolation level globally. If a specific flow needs
  `SERIALIZABLE`, scope it to that transaction and document the invariant here.

## Read-side (session) consistency

The table above is the write-side view. The read side has its own guarantee —
"does a read observe the caller's own prior write" — and today it is upheld by
app wiring convention, not by construction:

- **Goals cache** — `invalidateGoals` is called from **shared** code
  (`packages/chat-agent/src/agent/precreate-exercise-result.ts`), so no platform
  can forget it after a goal-mutating tool call.
- **Calendar cache** — `invalidateCalendar` is called only from **per-app module
  wiring** (`apps/discord-bot/.../discord-chat.module.ts`,
  `apps/zalo-bot/.../zalo-chat.module.ts`). Messenger has **no** calendar cache
  at all (`WispaceCalendarService` is constructed without the cache; only goals
  are memoized), so Messenger cannot serve a stale calendar read — a known and
  acceptable divergence, not a bug. The gap is that any *new* calendar-mutating
  path on Discord/Zalo could silently lose read-your-writes because the
  invalidation does not live next to the mutation in shared code. Tracked as
  #705.
- **Cross-pod invalidation** — `deleteByPrefix` on the shared Redis cache store
  (`packages/wispace-client/src/cache/redis-wispace-cache.store.ts`) is
  deliberately best-effort: its failure is caught and swallowed, with the
  calendar TTL (~15s) as the backstop. When it fails, a learner who just
  rescheduled can read pre-write calendar data for up to that TTL. This is an
  **explicit accept-stale decision**, bounded by the TTL — not a race to fix
  under this ADR.

Rule for new code: cache invalidation for a mutation should live with the
mutation in shared code, not in per-app wiring, so the guarantee cannot be
forgotten by a platform.

## Notes from the inventory

- The report/job claim CAS statement exists in **two identical copies** — the
  shared `platform-report-claim.repository.ts` (Discord/Zalo) and Messenger's
  `messenger.repository.ts`. Identical SQL, low risk; deduplication is cosmetic
  and not scheduled.
- Webhook inbox `listDue()` is a plain `SELECT … ORDER BY id LIMIT n` with **no
  `FOR UPDATE` / `SKIP LOCKED`**. Two workers can read the same due row, but only
  one wins the `WHERE status IN ('pending','failed')` CAS claim — correct result,
  at the cost of a wasted read. `SKIP LOCKED` is the upgrade path if claim
  contention ever shows up in metrics.

## Alternatives considered

| Alternative | Reason for rejection |
| --- | --- |
| Generic application-level MVCC / version column on all entities | No concrete lost-update problem justifies it. Postgres already provides MVCC; a second hand-rolled layer is pure maintenance cost and speculative flexibility. |
| Raise isolation to `SERIALIZABLE` for "safety" | Serialization failures + mandatory retry logic on every write path, for invariants that single-statement CAS already covers. Reach for it per-transaction with a named invariant, never globally. |
| Add lease-expiry columns everywhere for uniformity | Webhook inbox's `updated_at`-based staleness works and needs no schema change. Uniformity is not a requirement. |

## Consequences

- New concurrent flows must pick a row from the mechanism table and cite it in
  review, or add a new row here with the concrete problem that motivated it.
- A future reviewer seeing a `version` column outside `zalo_oa_tokens`, or an
  `isolationLevel` argument anywhere, should treat it as a deviation from this
  ADR that needs its own justification.

## Follow-up

- #705 — move `invalidateCalendar` invocation into shared `packages/chat-agent`
  code next to the calendar-mutating tool handler, so read-your-writes for
  calendar cannot be forgotten per platform (low priority — no stale read today
  because the only two platforms that cache calendar both wire it, and Messenger
  does not cache).

## References

- ADR-0007 — Postgres/Redis consistency boundaries (the Redis↔Postgres authority
  axis; this ADR is the in-Postgres concurrency-control axis).
- #576 — this decision.
- #659 — consistency-models sweep that produced the inventory.
- #688 — advisory-lock registry and scope.
