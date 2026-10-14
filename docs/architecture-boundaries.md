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

One consequence is that per-platform **table and column names** are shared
contracts rather than database-owned code (#1079, ADR-0042). `PLATFORM_STORAGE`
lives in `packages/contracts` because `@wispace/study-reminder-shared` must not
depend on the database package yet must read the same mapping table the erasure
path reads. It is data, not a type, and the boundary above still holds: the
contracts package stays dependency-free and no consumer gains a database import
by reading a table name. Entities, migrations, and raw SQL stay in
`packages/database`; a new platform's entity, migration, and composition-root
wiring remain that package's and the app's work.

JavaScript operational scripts are scanned alongside TypeScript source,
including static imports/exports, type queries, dynamic imports, and CommonJS
`require` forms. Direct database imports are allowed only in
`scripts/database-bootstrap-smoke.mjs`,
`scripts/database-persistence-semantics-smoke.mjs`,
`scripts/database-privacy-smoke.mjs`, `scripts/study-reminder-delivery-smoke.mjs`,
and `scripts/privacy-erasure-drill.mjs`. The checker fails closed when a
required scan root is missing or the production TypeScript scan is empty.
There are no legacy application-import exceptions.

## Database service folders (#1349)

`packages/database/src/services/` is grouped by the owning context named in
[`CONTEXT-MAP.md`](../CONTEXT-MAP.md). A folder name states which context a
service belongs to; it does not transfer ownership.

| Folder                   | Owning context        |
| ------------------------ | --------------------- |
| `account-linking/`       | Account Linking       |
| `platform-interaction/`  | Platform Interaction  |
| `metering-and-operations/` | Metering & Operations |
| `cross-cutting/`         | none — see below      |

`cross-cutting/` holds four modules that no context owns: `canonical-platform`,
`web-activity`, `learner-usage-query`, and `cron-leader-lease`. Each carries a
header comment naming its real consumers. The folder records existing debt — the
fix is moving each module into an owning package, the way #1078 moved the report
and reschedule adapters. Add a fifth folder only together with a new context in
`CONTEXT-MAP.md`.

`packages/database/src/index.ts` stays the single export surface; there are no
per-folder barrels.

## Cross-feature module boundaries (#435, generalised in #1445)

A **feature module** is a top-level directory under a bot's `modules`
directory. Two feature modules in the same bot may depend on each other only in
one of two ways:

- through the other module's **ports** — a path segment `ports/`, or a file
  named `*.port.ts`; or
- from a **composition root** — a `*.module.ts` file, which may bind the
  concrete adapters.

Any other cross-feature import fails `npm run architecture:check` — another
module's application services, domain types, infrastructure, presentation, or
plain utilities. The exemption is defined by what the import *is* (a port), not
by which layer it sits in, so moving a shared helper into `domain/` or
`infrastructure/` does not make a concrete cross-feature import legal.
Violations name both the importing and the target feature module. Tests are
exempt and may assemble concrete implementations.

**Currently enforced for `discord-bot` and `zalo-bot`.** `messenger-bot` is not
yet under this rule. It has 23 concrete cross-feature imports, and no baseline or
allow-list may be written to absorb them. #1446 folds the context-free
`scheduler` module into `messenger`, clearing 5 of them ([ADR
0055](adr/0055-messenger-report-scheduling-is-messenger-behaviour.md) records the
per-cluster breakdown); #1447 clears the rest and adds the app. The enforced set
is `FEATURE_MODULE_RULE_APPS` in
[`scripts/check-architecture.mjs`](../scripts/check-architecture.mjs).

There is no baseline, ratchet, or per-edge allow-list. Both bots' existing
violations are resolved in the change that enabled the rule, so the check has no
exceptions to grandfather — adding an app to `FEATURE_MODULE_RULE_APPS` is the
entire cost of extending coverage.

A feature module with **no layer directory** yet — a module skeleton, or a
feature nobody has split — is exempt rather than failed, and reported as a
`feature-module-not-layered` warning with the list asserted by a test. Failing it
would only move a file into an application directory to satisfy a path
predicate. The exemption is listed rather than silent so it cannot quietly grow.

A file placed in a subdirectory of a feature module that is not a layer
directory is a build failure (`module-layout-unclassified`), not a gap: it
escapes every layer rule at once. Unlike the cross-feature rule, this one applies
to **every** bot, not just the two above — a layout the checker cannot read is
worth failing everywhere. Files directly at a feature root are not flagged (a
config or controller there is a placement question, not a hole in the check), and
neither are modules with no layer directory, which are exempt above.

### Messenger ↔ Study Reminder (#435)

The messenger and study-reminder pair is the original, and keeps its own
identifiers and wording because it is a documented behavioural contract. It is
enforced regardless of the rollout stage above.

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
  Messenger adapters. Messenger and study-reminder feature code — in
  `application`, `domain`, `infrastructure` and `presentation` alike — may not
  cross-import each other's concrete services or utilities. Tests may assemble
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
| Apps — layer rules                                             | Every `domain/**` and `application/**` directory                    |
| Apps — cross-feature rule                                      | Every feature module; concrete paths in all four layers (`domain`, `application`, `infrastructure`, `presentation`) are covered, for `discord-bot` and `zalo-bot` only |
| Apps — module layout rule                                     | Every bot; a feature-module file outside a layer directory is reported |
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

The mixed-package rule decides by symbol name, so two things follow. A `/core` subpath imports are judged the same way as any other — a core symbol *named* `SomethingCache` is reported, because the rule has no `/core` carve-out and no such symbol exists in the tree today. And a namespace or `export *` import from a framework-bound subpath cannot be judged at all, so it is reported as `mixed-import-unclassifiable` rather than passing silently.

**Bind a port in the module that provides the class which consumes it.** Nest resolves a `useExisting` target only through the module's own providers or an imported module that exports it. A class token also had app-wide visibility through the `@Global()` RedisModule; a `Symbol` token has none. Binding a port token somewhere that does not provide its consumer resolves it to `undefined`, and an `@Optional()` parameter swallows the resulting `UnknownDependenciesException` — which is how rate limiting came to be silently off in two bots and a privacy erasure hook went missing, with no failing test. Where a dependency is always supplied, do not mark the parameter `@Optional()`; let Nest throw. #1450.

The cross-feature rule has no exemptions either — no baseline, no ratchet, no allow-list. The one exception is structural rather than per-edge: a feature module with no layer directory is skipped until it is split, and the list of those is asserted by a test rather than left to drift. See "Cross-feature module boundaries" above.

The same check enforces **declaration** ownership, not only import edges. A type listed as contracts-owned — `ChatQuotaDenyReason` and `ChatQuotaReleaseReason` (#1346, [ADR 0043](adr/0043-contract-ownership-taxonomy.md)) — may only be declared under `packages/contracts/src/`. A second copy elsewhere fails the build rather than drifting, which is what a cast at one call site once used to hide: a narrow copy declared that the core could never return a value it does return. How to decide which package owns a contract is recorded in that ADR.

## Explicit outer adapters

The exact framework-bound exclusions live in `FRAMEWORK_BOUND_ADAPTERS` in [`scripts/check-architecture.mjs`](../scripts/check-architecture.mjs). They are limited to:

- the platform student-report adapter in `student-report`.

The package `/adapters` barrels make the remaining NestJS/TypeORM/Redis
services explicit without widening the core rule. `cleanup-cron` is the only
affected package whose complete public implementation is intentionally
framework-bound.

The other mixed packages are enforced by selecting only their framework-neutral core paths; their runtime services are outside those scopes, not hidden behind a package-wide exemption. `cleanup-cron` is intentionally framework-bound and is not labelled as a core package.

Do not widen an adapter pattern merely to make CI green. A new entry needs an owner, a linked issue, and the narrowest file/path pattern that describes the adapter. The explicit core-entrypoint rule rejects framework, infrastructure, and adapter imports in every `/core` barrel.

### Vendor-named exports from a core entrypoint (#1439)

Every other rule keys on the module **specifier**, so a vendor-named symbol re-exported from a neutral-looking path — `export { isOpenAiRateLimitError } from '../provider/failure-classifiers'` — reached the framework-free surface with the guard green. That is how a vendor-specific failure classifier came to decide which message a learner sees. A second rule therefore matches on the **exported identifier**: a `/core` entrypoint may not export a symbol named after a banned vendor. It reads export declarations only, because publishing is the surface in question, and an adapter is allowed to be vendor-specific by design.

Two boundaries on that rule, both measured rather than assumed:

- **Platform names are not vendor names.** This repo is multi-platform, so `discord` is a platform and appears legitimately in a core type (`ReengagementDiscordPayload` in `wispace-client`). Only the SDK spelling `discordjs` is a vendor token. Including the bare platform name produced one false positive on the real repository and is why that token is absent.
- **The framework-bound allowlist is untouched.** The rule reports rather than allowlists, because a core entrypoint is not legitimately framework-bound. An allowlist entry here would be the permanent exemption the rest of this document refuses.

`CORE_OUTER_PATH` does not cover a `provider` path segment, which is a pre-existing and separate gap: `core` already imported from the provider tree before #1430. It is deliberately not fixed here, because a specifier rule there has a wider blast radius than a name rule and would need its own measurement.

## Commands and CI

```bash
npm run architecture:test
npm run architecture:check
```

`npm run verify` and `npm run verify:affected` run the repository check. The pull-request workflow also runs the fixture suite, so malformed rule changes fail before the normal build/test matrix. A violation reports the owning package, source file and line, rule, imported symbols, and module specifier.
