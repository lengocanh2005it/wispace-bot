# ADR-0027 — Stable identity buckets for daily chat quota

## Status

Accepted; implemented in [#1177](https://github.com/lengocanh2005it/wispace-bot/issues/1177)
(migration `1789093800000-OwnerAwareChatDailyUsageKeys`).

## Context

The daily FREE_FORM quota currently stores one row per
`(platform, external_user_id, usage_date)` and rewrites its nullable `user_id`
when a channel is linked or unlinked. That makes an identity transition look
like a new counter: unlinking can discard a learner's consumed count, and a
relink can make the next turn admissible again. The same rewrite also means a
refund or stuck-reservation recovery may no longer find the bucket charged at
reserve time.

Issue #637 established a learner-wide daily quota, but its compatibility
hydration of anonymous rows through active mappings would make an anonymous
counter become learner-owned after a link. #1177 clarifies that the two
logical buckets must remain independent.

## Decision

### Logical buckets

- A **learner bucket** is owned by `(WISPACE userId, usage_date)` and is shared
  across that learner's Messenger, Discord, and Zalo links.
- An **anonymous bucket** is owned by
  `(platform, external_user_id, usage_date)` when no WISPACE `userId` is
  attached.
- Buckets never merge, reset, or transfer because a mapping changes. A
  relink from learner A to B leaves A's usage with A; B starts from B's own
  bucket. An anonymous count is never adopted by a learner.

The logical learner bucket may be represented by multiple channel-scoped
linked rows; the daily cap is enforced on their aggregate under the existing
learner/date critical section.

### Persistence and charge ownership

`chat_daily_usage` must allow a linked row and an anonymous row for the same
channel and date to coexist while preserving an immutable owner. The old
single unique key on `(platform, external_user_id, usage_date)` is replaced by
owner-aware uniqueness (linked rows are owner-scoped; the anonymous row is
unique per channel/date).

The idempotency row is the charge-owner snapshot. A non-null `user_id` refunds
or recovers the learner-owned row; a null `user_id` uses an explicit
`user_id IS NULL` predicate for the anonymous row. The current mapping is never
consulted to decide where an old reservation is released. Quota audit events
and `chat-quota:rebuild` use the same owner snapshot rather than joining the
current mapping.

Burst protection remains independently scoped to `(platform,
external_user_id)` and is not reset by link churn. Privacy erasure removes a
learner bucket but does not transfer or implicitly delete an anonymous bucket.

### Legacy data and rollout

Runtime learner aggregation no longer hydrates anonymous rows through active
links. A one-time migration may conservatively copy an ambiguous current-day
anonymous row into both the learner and anonymous logical buckets; older
ambiguous rows remain anonymous. This can deny extra quota for one day, but it
cannot grant quota that historical identity churn may already have consumed.

Because the migration owner deploys before the dependent bots, the rollout is
an actual expand/contract sequence. The shared repository detects the indexed
schema state: while the legacy key exists, every bot uses the old
mapping-aware reserve SQL; after the owner-aware indexes commit, it switches to
owner-scoped SQL. Self-pull deploys all three compatibility images first,
verifies their images are available, then runs the Messenger migration in a
forced second deploy. A failed migration therefore leaves the legacy schema
and the compatibility path serving safely.

The migration creates the owner-aware partial indexes before dropping the old
key inside the migration transaction, backfills the configured current quota
day, and then commits the contract. A failed release after that commit keeps
the new schema; the new repository remains compatible with it and the down
migration deliberately refuses to merge coexisting buckets. Pre-#1177 images
must not be restored after the contract has committed.

## Consequences

- Unlink/relink cannot lower a learner's consumed daily count.
- Anonymous and learner usage remain separate, including after repeated churn.
- Physical rows may be more numerous because one channel/date can hold both
  owners; learner reads aggregate linked rows.
- Ambiguous current-day migration data may over-deny temporarily.
- #1022's possible learner-wide burst policy remains separate and is not
  changed by this decision.

## Acceptance proof

The implementation must cover linked → unlink → anonymous → relink churn,
repeated churn in one usage date, anonymous/learner isolation, A → B relink,
refund and stuck recovery after ownership changes, cross-platform learner
aggregation, burst stability, privacy erasure, and the no-churn path. The
issue's command remains the release gate:

```text
npx turbo run lint test build --filter=@wispace/chat-metering... --filter=@wispace/messenger-bot...
```

## Alternatives considered

- **Mutable one-row identity:** rejected; it is the root cause of the reset
  and makes release/refund ownership time-dependent.
- **Active-mapping adoption of anonymous rows:** rejected by #1177; it makes
  an anonymous session inherit into a learner bucket.
- **Per-platform learner quota:** rejected; it preserves a bounded multi-bot
  multiplier instead of one learner-wide daily allowance.
- **New bucket table immediately:** not required yet; owner-aware rows in the
  existing table preserve the current persistence boundary with less schema
  surface. A dedicated table is an upgrade only if row-level complexity or
  throughput justifies it.
- **Breaking migration during the Messenger-first rollout:** rejected; the
  two-phase compatibility rollout keeps old and new images safe until the
  owner-aware contract commits.

## References

- [ADR-0005 — Chat rate limiting via DB](0005-chat-rate-limiting-db.md)
- [ADR-0007 — Postgres/Redis consistency boundaries](0007-postgres-redis-consistency.md)
- [ADR-0008 — MVCC and optimistic-concurrency direction](0008-mvcc-and-optimistic-concurrency.md)
- [#637 — Cross-platform learner quota](https://github.com/lengocanh2005it/wispace-bot/issues/637)
- [#1022 — Per-platform quota multiplier](https://github.com/lengocanh2005it/wispace-bot/issues/1022)
- [#1177 — Quota reset through identity churn](https://github.com/lengocanh2005it/wispace-bot/issues/1177)
