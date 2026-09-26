# Architecture boundaries

This document is the executable boundary map for [#432](https://github.com/lengocanh2005it/wispace-bot/issues/432). The design decision remains [ADR-0002](adr/0002-clean-architecture.md); detailed coding examples remain in [`.claude/rules/clean-architecture.md`](../.claude/rules/clean-architecture.md).

## Dependency direction

Within an app, dependencies point inward:

```text
presentation -> application -> domain <- infrastructure
                         ^
                         |
                  composition root wires adapters
```

- Domain code may use pure types and inner ports. It must not import NestJS, TypeORM, database packages, application services, or presentation/infrastructure paths.
- Application code may use inner contracts and framework-neutral policy packages, but concrete repositories, entities, SDK clients, Redis, HTTP transports, and presentation types stay outside the application layer.
- Application ports are stricter: they may use inner contracts only; concrete adapters never belong in a port.
- Composition roots (`*.module.ts`, app bootstrap) may import both sides to bind an implementation to a port.
- Shared packages must never import app aliases (`@messenger/*`, `@discord/*`, `@zalo/*`).

## Database dependency roles (#1088)

`@wispace/database` is an outer persistence dependency, not a general-purpose
application service package. In apps, its imports belong in infrastructure,
persistence, adapter, or database source paths and composition roots (`*.module.ts`,
`main.ts`, `app.module.ts`). Domain/application rules still reject database
dependencies there, and presentation code must not reach the database directly.
Shared packages may import it only from their `src/adapters/**` subtree; keep
database-owned code in `packages/database` and shared contracts in
`packages/contracts`.

JavaScript operational scripts are scanned alongside TypeScript source,
including static imports/exports, type queries, dynamic imports, and CommonJS
`require` forms. Direct database imports are allowed only in
`scripts/database-bootstrap-smoke.mjs`,
`scripts/database-persistence-semantics-smoke.mjs`,
`scripts/database-privacy-smoke.mjs`, `scripts/study-reminder-delivery-smoke.mjs`,
and `scripts/privacy-erasure-drill.mjs`. The checker fails closed when a
required scan root is missing or the production TypeScript scan is empty.
There are no legacy application-import exceptions.

## Messenger ↔ Study Reminder boundary (#435)

The two features communicate through capability ports, not each other's concrete
application services, utilities, or transport implementations:

- Messenger consumes `StudyReminderOperationsPort` for chat/calendar actions and
  `StudyReminderSyncPort` for the post-link per-user sync side effect.
- The Messenger calendar adapter delegates common listing/reschedule orchestration
  to `PlatformStudyCalendarCommandService` at the infrastructure/composition
  boundary. Messenger-only psid mapping, unscoped-read fallback, and the
  post-mutation reminder sync remain in that adapter.
- Study Reminder dispatch consumes the shared `MESSAGE_SENDER` port and receives
  Messenger's delivery-failure classifier through the existing dispatch options
  seam. It does not import Messenger error utilities.
- Messenger delivery errors and pure delivery predicates live in a neutral
  Messenger application contract; user-facing chat copy remains in Messenger's
  message formatter.
- Existing `*.module.ts` files are composition roots and may bind the concrete
  Messenger adapters. Feature application/domain/infrastructure/presentation
  code may not cross-import concrete services or utilities. Tests may assemble
  concrete implementations.

Behavior remains owned by the existing use cases: a failed post-link sync does
not roll back a committed mapping; `StudyReminderDispatchService` remains the
owner of retry/terminal persistence; and `sent`, `not_sent`, `ambiguous`, and
`rate_limited` keep their current delivery semantics. The refactor adds no new
lock or concurrency policy.

## Package entrypoints (selected #1126 target)

The packages in this table use explicit public subpaths. This convention does not apply to every package with an `exports` map; feature-oriented exports such as `bot-common` remain separate.

| Package                 | Core entrypoint                       | Outer adapter entrypoint                                         |
| ----------------------- | ------------------------------------- | ---------------------------------------------------------------- |
| `llm-agent`             | `@wispace/llm-agent/core`             | `@wispace/llm-agent/adapters`                                    |
| `wispace-client`        | `@wispace/wispace-client/core`        | `@wispace/wispace-client/adapters`                               |
| `student-report`        | `@wispace/student-report/core`        | `@wispace/student-report/adapters`                               |
| `chat-metering`         | `@wispace/chat-metering/core`         | `@wispace/chat-metering/adapters`                                |
| `scheduler-core`        | `@wispace/scheduler-core/core`        | `@wispace/scheduler-core/adapters`                               |
| `reschedule-confirm`    | `@wispace/reschedule-confirm/core`    | `@wispace/reschedule-confirm/adapters`                           |
| `study-reminder-shared` | `@wispace/study-reminder-shared/core` | `@wispace/study-reminder-shared/adapters`                        |
| `ops-health`            | `@wispace/ops-health/core`            | `@wispace/ops-health/adapters`                                   |
| `account-link-core`     | `@wispace/account-link-core/core`     | `@wispace/account-link-core/adapters`                            |
| `cleanup-cron`          | —                                     | `@wispace/cleanup-cron/adapters` (intentionally framework-bound) |

Bare package-root imports are forbidden for packages in this table; there is no
root compatibility facade. Domain and application code use `/core` where it
exists, while infrastructure and composition roots import `/adapters`. The
adapter-only `cleanup-cron` package has no `/core` surface. #1126 owns the
specifier migration; #1088 removed existing application adapter edges and
their legacy exceptions. TypeORM implementations moved
out of `database` are available only from their owner adapter subpaths and are
not re-exported by `database`.

The database package owns TypeORM entities, migrations, connection/circuit
breaker primitives, and persistence-only state. It must not import
`@wispace/scheduler-core`, `@wispace/reschedule-confirm`, or
`@wispace/bot-metrics`. Scheduled-report adapters live in
`@wispace/scheduler-core/adapters`; reschedule store/recovery live in
`@wispace/reschedule-confirm/adapters`. Messenger, Discord, and Zalo bind the
real metrics service to `DB_CIRCUIT_BREAKER_METRICS` in their local database
composition roots, preserving telemetry without an upward package dependency.

## Enforced core scopes

`npm run architecture:check` parses production TypeScript import/export declarations and enforces these source scopes:

| Area                                                             | Framework-agnostic scope                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| Apps                                                             | Every `domain/**` and `application/**` directory                    |
| `contracts`                                                      | Entire package; it has zero imports                                 |
| `chat-history`, `chat-queue-core`, `chat-pipeline`, `date-utils` | Entire package                                                      |
| `llm-agent`                                                      | `src/core/**` plus framework-free orchestration implementations     |
| `student-report`                                                 | `src/core/**` plus `StudentReportCore` implementations              |
| `wispace-client`                                                 | Types, errors, utilities, cache policy/core, and plain HTTP clients |
| `chat-metering`                                                  | Types, policy cores, cost/safety functions, and memory counter      |
| `scheduler-core`, `study-reminder-shared`                        | Ports, types, and pure utilities                                    |
| `ops-health`                                                     | `src/core/**`: health/data-quality types, ports, evaluator, policy  |
| `account-link-core`                                              | Completion/reconcile/OAuth-state policies and ports                 |
| `cleanup-cron`                                                   | Framework-bound package; no claimed core                            |

Tests/specs, generated output, `dist`, and `node_modules` are excluded. Test code may import adapters to assemble a harness, but production code cannot hide a forbidden edge there.

Application and domain scopes have no legacy import exemptions. Every concrete outer-layer edge fails the architecture check; add a narrow inner-layer port when application policy needs an outer adapter.

## Explicit outer adapters

The exact framework-bound exclusions live in `FRAMEWORK_BOUND_ADAPTERS` in [`scripts/check-architecture.mjs`](../scripts/check-architecture.mjs). They are limited to:

- the privacy-state NestJS adapter in `llm-agent`;
- the platform student-report adapter in `student-report`.

The package `/adapters` barrels make the remaining NestJS/TypeORM/Redis
services explicit without widening the core rule. `cleanup-cron` is the only
affected package whose complete public implementation is intentionally
framework-bound.

The other mixed packages are enforced by selecting only their framework-neutral core paths; their runtime services are outside those scopes, not hidden behind a package-wide exemption. `cleanup-cron` is intentionally framework-bound and is not labelled as a core package.

Do not widen an adapter pattern merely to make CI green. A new entry needs an owner, a linked issue, and the narrowest file/path pattern that describes the adapter. The explicit core-entrypoint rule rejects framework, infrastructure, and adapter imports in every `/core` barrel.

## Commands and CI

```bash
npm run architecture:test
npm run architecture:check
```

`npm run verify` and `npm run verify:affected` run the repository check. The pull-request workflow also runs the fixture suite, so malformed rule changes fail before the normal build/test matrix. A violation reports the owning package, source file and line, rule, imported symbols, and module specifier.
