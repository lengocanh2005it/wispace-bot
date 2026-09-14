# Shared locked-tick batch orchestration

## Status

Accepted.

## Decision

Use one shared locked-tick wrapper from `@wispace/bot-common`, which already
owns the PostgreSQL advisory-lock infrastructure. Cron services in
`@wispace/database` and the related webhook, metering, Messenger, and Discord
workers may use it without making `chat-metering` depend on `database`.

The wrapper owns the orchestration boundary for one bounded batch: validated
configuration resolution, enabled checks, advisory-lock skip behavior, batch
iteration, common outcome accounting, summary construction, and cron success
metrics. Its common summary envelope is `{ processed, succeeded, failed,
skipped }`; service-specific counters remain in `details`.

`CleanupCronService.execute` uses the compact
`execute(name, advisoryLockId, deleteFn)` contract. `name` is a stable policy
key, not merely a display label. An explicit registry supplies the enabled
setting, retention policy, and default; unknown keys fail rather than falling
back silently. Jobs without retention declare `retention: null`.

Leader gates and other domain-specific preconditions remain outside the
wrapper. Claim, lease, retry, stuck-row, and terminal-state transitions remain
owned by the persistence/service layer. An item failure is counted and the
batch continues; a fetch, configuration, or lock failure fails the tick. A
disabled tick or lock contention is not a successful tick, while the existing
`CleanupCronService` null result is retained for caller compatibility.

Existing lock IDs, cron names and intervals, batch limits, lease durations,
retry backoffs, stale thresholds, retention windows, and enabled-flag meaning
do not change. Configuration is validated and snapshotted through the shared
reader from #876.

## Consequences

The seven audited bounded workers can share behavior without forcing their
domain outcomes into one lossy vocabulary: platform dead-letter retry,
privacy cleanup reconciliation, webhook inbound retry, Redis burst
reconciliation, Messenger link reconciliation, Messenger report retry, and
Discord report retry. Their persistence and platform-specific outcome details
remain local.

Behavioral tests cover disabled ticks, lock contention, empty batches,
per-item failures, common summaries, and metrics. Service tests cover mapping
their domain outcomes into the shared envelope. Configuration-plumbing tests
are removed rather than layered on top.

## Rejected alternatives

- Putting the cross-package wrapper in `database` would add an unnecessary
  dependency from `chat-metering` to a persistence package.
- Inferring env keys from a cron display name fails for the existing platform
  prefixes and jobs without retention.
- Letting each service keep its own loop and counters would preserve the
  duplication this decision is intended to remove.
- Creating a new scheduler package adds a boundary without a second consumer
  need; `bot-common` is the existing shared infrastructure boundary.
