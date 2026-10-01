# Timestamp and timezone policy

## Status

Accepted. Settles the timestamp policy requested by
[#1227](https://github.com/lengocanh2005it/wispace-bot/issues/1227), the sibling
of [ADR-0025](0025-database-portability-boundary.md) that ADR already points at.

## Context

Time is read from four sources in this repository, and nothing states which is
authoritative for what:

- the database clock, through `now()` evaluated inside a statement;
- a database clock column default, including TypeORM's create/update date
  decorators;
- the application clock, when a value is computed in TypeScript;
- a per-feature configured timezone, which decides where a calendar-day
  boundary falls.

The timezone inventory is the finding that matters most, and it has nothing to
do with portability. A daily-bucket boundary computed one way at a write site
and compared another way at a read site is a defect that surfaces only for a
learner in one timezone at one hour of the day.

The portability angle is real but secondary. MySQL has no timezone-aware column
type at all: `TIMESTAMP` converts to and from the session timezone, and
`DATETIME` stores a naive wall-clock value. The existing timezone-aware columns
carry an offset that neither type preserves.

## Decision

### Which clock is authoritative, per category of column

| Category | Authoritative clock | Reason |
| --- | --- | --- |
| Audit timestamps — row created/updated, delivery journals, message logs, safety and usage events | Database clock, via a column default | Written by the same statement that writes the row. No application round trip, and the value cannot disagree with the row it describes. |
| Lease and claim expiries — report claims, webhook inbox leases, reschedule confirmations, cron leader leases | Database clock, evaluated inside the statement | The comparison and the write are one atomic statement. An application-supplied timestamp opens a clock-skew window between deciding and recording. |
| Learner-facing daily buckets — `usage_date`, `report_date` | Application clock, resolved in the configured learner timezone | Must be reproducible from a test and identical at every write site and every read site. A database-clock bucket makes a test depend on when it ran. |

The bucket rule is asymmetric on purpose. A bucket is computed once, in the
application, and passed as a bound parameter; it is never derived from `now()`
inside SQL.

### The `now()` sites are not to be rewritten

`now()` inside a statement is the correct implementation for an atomic lease or
claim comparison: it removes a round trip and the clock-skew window. Replacing
it with an application-supplied parameter makes today's code measurably worse in
exchange for a portability benefit that may never be collected. A pull request
that rewrites these sites should be rejected as out of scope.

This is the same reasoning [ADR-0025](0025-database-portability-boundary.md)
applies to `RETURNING`: the atomic primitive stays; the boundary around it is
what gets recorded.

### Timezone variables

Two settings carry a decision:

- `APP_TIMEZONE` — the learner's calendar day. Quota reset, report scheduling,
  reminder scheduling, LLM usage bucketing, data-quality baselines, and the
  re-engagement scan all resolve through it.
- `CRON_TIMEZONE` — the cleanup-cron schedule. This name previously denoted a
  hardcoded constant that was never read from the environment; it is now
  configurable, with the same value as its fallback.

Five per-feature variables remain readable as legacy aliases:
`CHAT_USAGE_TIMEZONE`, `LLM_USAGE_TIMEZONE`, `STUDY_REMINDER_TIMEZONE`,
`DATA_QUALITY_TIMEZONE`, `REENGAGEMENT_TIMEZONE`.

These five are **not duplicates by value** — every default is
`Asia/Ho_Chi_Minh`. They are duplicates by decision shape: each one answers the
same question, "which day is it for the learner", under a different name. That
is what makes consolidation load-bearing rather than cosmetic. Their names are
not evidence that they may legitimately diverge; they are the drift.

Resolution order, owned by `resolveTimezone` in
[`@wispace/contracts`](../../packages/contracts/src/index.ts): `APP_TIMEZONE`,
then the caller's own legacy key, then the hardcoded default. A set-but-blank
value counts as unset.

The ordering is what makes consolidation non-behavioural. A deployed
environment that sets only legacy variables resolves exactly as it did before.
An environment that adopts `APP_TIMEZONE` gets one answer everywhere.

Removing the legacy variables needs its own issue with a migration path; until
then they stay readable, and this ADR does not fail startup when a legacy
variable disagrees with `APP_TIMEZONE`.

### What a bucket boundary is computed against

`resolveTimezone` produces the zone, and the existing per-feature date helpers
(`currentChatUsageDate`, `todayInTimezone`) turn it into a `YYYY-MM-DD` value in
the application. That value is the bucket key at every write site and every read
site. The database never derives it.

Three features previously read each other's timezone names: the report cron
read `CHAT_USAGE_TIMEZONE` to place the 08:00 wave, and the study-reminder
schedule fell back through `CHAT_USAGE_TIMEZONE` when its own variable was
unset. Changing the quota timezone therefore changed the report schedule.
Consolidation removes that coupling; the aliases keep existing environments
working until they are updated.

### Storage guarantee the portability boundary depends on

No application logic may depend on the column type carrying an offset. Every
comparison that matters is a comparison between two timestamps, never an
inspection of stored text, and every daily bucket is a separate date column
rather than a truncated timestamp.

Under that rule a naive UTC timestamp column is a drop-in substitute for the
timezone-aware one. That is the guarantee
[ADR-0025](0025-database-portability-boundary.md) depends on, and it is why the
column type is a storage detail rather than a contract.

### Isolation level is an assumption, not an implementation detail

The concurrency reasoning in
[ADR-0008](0008-mvcc-and-optimistic-concurrency.md) assumes PostgreSQL's
default `READ COMMITTED`. An adapter for another engine must preserve the
observable atomicity, ownership fencing, claim and lease outcomes, and lock
ordering, and may not silently weaken them.

This is recorded here as an assumption because it is the one difference no
adapter layer can hide. A portable timestamp column does not make a weaker
isolation level safe; the timestamp policy and the concurrency policy are
independent, and an engine change has to satisfy both.

## Evidence snapshot

Measured from runtime entity and application code, excluding migrations, specs,
and build output. This is a dated snapshot for orientation, not a threshold.

| Construct | Sites | Note |
| --- | ---: | --- |
| `type: 'timestamptz'` in entity columns | 96 across 32 entity files | Grandfathered; the guard is diff-based |
| `type: 'date'` in entity columns | 9 | The daily-bucket category |
| `type: 'timestamp'` in entity columns | 3 | Naive wall-clock, not guided by this policy |
| `@CreateDateColumn` / `@UpdateDateColumn` | 38 | Framework-native database-clock convention |
| `default: () => 'now()'` column defaults | 8 | Database clock for audit columns |
| `now()` in runtime TypeScript | 305 | Not to be rewritten |

The figures published in
[#1227](https://github.com/lengocanh2005it/wispace-bot/issues/1227) were taken
on 2026-09-16 and have drifted since; the decorator count in particular is 38,
not 72. Re-measure before quoting any of these numbers again.

## Enforcement

`@wispace/contracts` exports `TIMESTAMPTZ` and `DATE` as the single
declarations of those column types, plus `DEFAULT_TIMEZONE`,
`APP_TIMEZONE_ENV_KEY`, `LEGACY_TIMEZONE_ENV_KEYS`, and `resolveTimezone`. All
six packages that declare a timezone-aware column already depend on that
package, which has no imports of its own, so no new dependency is introduced.

`check-timestamp-policy.sh` fails a pull request that adds a bare
`type: 'timestamptz'` or `type: 'date'` literal in an entity file.

The guard is diff-based and inspects added lines only. A whole-repo scan would
fail on all 96 existing literals and force a rewrite this policy explicitly does
not ask for; a whole-file scan would force a caller who adds one column to a
legacy entity to migrate every literal already in that file. Diff-based means
the allowlist is empty and cannot rot.

Deliberately not guarded:

- raw SQL, including `now()` and `AT TIME ZONE` — a SQL-scanning guard over
  hundreds of call sites would introduce false positives and buy nothing, since
  every existing `now()` is correct for its category;
- the naive `timestamp` type;
- the TypeORM create/update date decorators and database-clock column defaults,
  which are the framework's and database's own expressions of the same policy.

## Consequences

A reviewer can tell a correct `now()` comparison apart from an accidental one,
and can tell a deliberate bucket boundary apart from a defect, by reading the
category the column belongs to.

An operator can set one variable to change the learner calendar day everywhere,
and can stop setting the five legacy variables whenever they are ready to.
Existing environments need no coordinated change.

New timestamp columns are guided to one declaration, and a reviewer sees the
drift at the moment it is introduced rather than after it has accumulated.

## Alternatives considered

- **Rewrite the `now()` sites to application-supplied parameters:** rejected
  because it makes the current implementation worse in exchange for a benefit
  that may never be collected.
- **Collapse the timezone variables immediately and fail startup on the old
  names:** rejected because a partially migrated environment would refuse to
  boot. Removal needs its own migration issue.
- **Enforce a whole-repo column-type allowlist:** rejected because it trades 96
  existing columns for a 96-line maintenance list that decays.
- **Guard raw SQL for time patterns:** rejected because the pattern is rare, the
  false-positive cost across hundreds of `now()` sites is real, and the rule
  belongs in review rather than in a regex.
