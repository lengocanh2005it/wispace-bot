# Database portability boundary

## Status

Accepted.

## Context

PostgreSQL is the target database for the WISPACE bots. The codebase already
uses repository ports and persistence adapters, while the adapters use
PostgreSQL-specific SQL for locking, conditional writes, timestamps, and
query efficiency. What was missing was the rule that connects those facts:
reviewers had no written way to decide whether a new query belongs behind the
adapter boundary or has leaked a database behavior into a caller.

This is a boundary decision, not a promise of portable SQL. A hypothetical
engine change should replace persistence implementations, not force business
logic to understand a second SQL dialect. Conversely, a query that is correct
for PostgreSQL should not be rewritten into a slower or less-atomic sequence
merely to prepare for an engine that has not been chosen.

This decision records the boundary requested by
[#1222](https://github.com/lengocanh2005it/wispace-bot/issues/1222).

## Decision

### Portability promise

PostgreSQL remains the production target. If a real business reason later
requires another engine, the change may replace persistence and infrastructure
adapter implementations and the composition-root binding/configuration. It
must not require changes to domain code, application business logic, or public
port signatures.

No second engine, including MySQL, is selected or supported by this ADR.

The promise is that callers depend on domain outcomes and persistence
semantics, not on PostgreSQL SQL, TypeORM row shapes, driver errors, lock
function names, or database-specific defaults. A future engine is supported
only when its adapter preserves the observable contract and concurrency
invariants; an engine that cannot do so is unsupported rather than a reason to
weaken the contract.

### Adapter boundary

The adapter boundary includes TypeORM entities and repositories, database
connections and datasource configuration, database health and operations,
shared database services, and shared lock primitives when they implement or
support persistence behavior. Classification is by role, not by filename:
service-shaped code in a persistence package is still an adapter.

Physical storage details may change inside this boundary, including indexes,
views, column mappings, and engine-specific types or defaults, as long as the
logical data contract and persistence semantics remain intact. Composition
roots may rebind an implementation or configuration, but may not move
database rules into application business logic.

### Deliberately allowed

PostgreSQL-specific and portability-sensitive SQL is permitted and encouraged
inside persistence adapters. Current examples include:

- pg_advisory_* locks and PostgreSQL lock-key hashing;
- INSERT ... RETURNING;
- conditional ON CONFLICT upserts;
- PostgreSQL casts, now(), DISTINCT ON, and FOR UPDATE SKIP LOCKED.

INSERT ... RETURNING stays a single atomic write/read operation. Replacing it
with insert-then-select only to make the SQL look portable adds a round trip
and can weaken atomicity for no current benefit. Conditional ON CONFLICT
predicates likewise remain one atomic persistence operation; the adapter must
translate an empty result into a named domain outcome instead of making a
caller infer refusal from a raw row array.

When a lock and a row read must occur in one statement, the logical lock key is
derived once by the shared application-side helper and passed as a bound
parameter. SQL may hash that parameter, but it must not independently
reconstruct the same key.

### Not allowed

Database-specific behavior must not cross the port boundary:

- no port method whose signature or semantics only make sense for PostgreSQL;
- no caller branch based on raw query row shape, empty-array meaning, TypeORM
  conventions, PostgreSQL driver errors, or SQLSTATE details;
- no lock key derived independently in SQL when the same logical key exists in
  TypeScript;
- no raw SQL in domain, application business logic, or presentation code.

The exact path-based raw-SQL guard is owned by
[#1225](https://github.com/lengocanh2005it/wispace-bot/issues/1225). This ADR
defines the rule; the guard keeps new violations from accumulating. Shared
advisory-lock helpers may contain PostgreSQL primitives because they are
infrastructure adapters; their callers depend only on documented lock
semantics.

### Migrations

Migration files are outside this portability promise. A genuine engine change
rewrites the migration history or establishes an engine-specific baseline.
Maintaining a dual-dialect migration suite for every future migration is not
required. The migration datasource and runner remain persistence
infrastructure, but the historical migration files themselves are not a
cross-engine contract.

### Concurrency and time assumptions

The adapter must preserve observable atomicity, ownership fencing, claim and
lease outcomes, and lock ordering. PostgreSQL's current READ COMMITTED
assumption is recorded in
[ADR-0008](0008-mvcc-and-optimistic-concurrency.md); an adapter may use
suitable isolation or locking for another engine, but may not silently weaken
those outcomes.

Timestamp and timezone semantics are a separate policy tracked by
[#1227](https://github.com/lengocanh2005it/wispace-bot/issues/1227). This ADR
does not rewrite the existing now() calls or decide which application clock is
authoritative. WISPACE HTTP/API contracts are also outside this local database
boundary.

## Evidence snapshot

Inventory taken 2026-09-16 from runtime code, excluding migrations, specs, and
generated output. The table is selected evidence, not an exhaustive catalog
or a CI threshold.

| Construct | Runtime sites | Portability note |
| --- | ---: | --- |
| pg_advisory_* | 14 | No equivalent with the same transaction/session semantics |
| hashtext / hashtextextended | 11 | Key derivation has no portable equivalent with the same contract |
| RETURNING | 58 | A portable rewrite changes atomicity and round trips |
| ON CONFLICT | 23 | Plain forms have partial equivalents; conditional predicates do not map directly |
| PostgreSQL casts | 162 | Often mechanically rewritable, but still adapter syntax |
| now() in SQL | 230 | Other engines have different clock/timezone semantics |
| DISTINCT ON | 2 | Can be rewritten with a window function |
| FOR UPDATE SKIP LOCKED | 1 | Some engines provide a similar construct |

The same snapshot found 93 timestamptz, 8 uuid, and 4 jsonb entity columns, plus
144 raw query call sites across 39 runtime files. These numbers explain why a
written boundary is useful; they do not define a permanent inventory.

## Enforcement and follow-ups

The persistence-semantics smoke suite, port-level specifications, and affected
application integration tests are the acceptance proof for any future adapter.
[#1228](https://github.com/lengocanh2005it/wispace-bot/issues/1228) makes the
smoke suite engine-parameterized without adding a second engine now.

The follow-up issues enforce separate parts of this decision:

- [#1223](https://github.com/lengocanh2005it/wispace-bot/issues/1223) makes lock-key derivation single-sourced;
- [#1224](https://github.com/lengocanh2005it/wispace-bot/issues/1224) extracts the shared Discord/Zalo account-link persistence adapter;
- [#1225](https://github.com/lengocanh2005it/wispace-bot/issues/1225) guards raw-SQL location;
- [#1226](https://github.com/lengocanh2005it/wispace-bot/issues/1226) names conditional-upsert outcomes in ports;
- [#1227](https://github.com/lengocanh2005it/wispace-bot/issues/1227) defines timestamp and timezone policy;
- [#1228](https://github.com/lengocanh2005it/wispace-bot/issues/1228) parameterizes the persistence smoke contract.

#1224 follows #1223. The remaining follow-ups may proceed independently once
this boundary is recorded.

## Consequences

Reviewers may accept efficient PostgreSQL SQL in the persistence adapter
without treating it as portability debt. They must reject PostgreSQL-specific
semantics in ports or callers, even when the current PostgreSQL behavior is
correct.

An eventual engine change remains a deliberate adapter and schema exercise,
not a claim that SQL or migration files copy unchanged. The trade-off is
intentional: the project pays the cost of a new adapter only when a real
business reason exists, while current code keeps its atomic and concurrency
properties.

## Alternatives considered

- **Restrict runtime SQL to a portable subset:** rejected because it would
  discard useful PostgreSQL atomicity and performance before another engine is
  needed.
- **Hide every query behind a new universal database abstraction:** rejected
  because the existing port and adapter seams already provide the required
  boundary; a second abstraction would add indirection without a consumer.
- **Maintain dual-dialect migrations now:** rejected because migration history
  is rewritten for a real engine change and would otherwise impose permanent
  cost on every migration.
