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

## Package entrypoints

The affected shared packages expose explicit public subpaths:

| Package                 | Framework-free entrypoint             | Outer adapter entrypoint                                         |
| ----------------------- | ------------------------------------- | ---------------------------------------------------------------- |
| `llm-agent`             | `@wispace/llm-agent/core`             | `@wispace/llm-agent/adapters`                                    |
| `wispace-client`        | `@wispace/wispace-client/core`        | `@wispace/wispace-client/adapters`                               |
| `student-report`        | `@wispace/student-report/core`        | `@wispace/student-report/adapters`                               |
| `chat-metering`         | `@wispace/chat-metering/core`         | `@wispace/chat-metering/adapters`                                |
| `scheduler-core`        | `@wispace/scheduler-core/core`        | `@wispace/scheduler-core/adapters`                               |
| `study-reminder-shared` | `@wispace/study-reminder-shared/core` | `@wispace/study-reminder-shared/adapters`                        |
| `ops-health`            | `@wispace/ops-health/core`            | `@wispace/ops-health/adapters`                                   |
| `account-link-core`     | `@wispace/account-link-core/core`     | `@wispace/account-link-core/adapters`                            |
| `cleanup-cron`          | —                                     | `@wispace/cleanup-cron/adapters` (intentionally framework-bound) |

The package root remains a backward-compatible migration façade. New code
should import the explicit subpath: core/application code uses `/core`, while
composition roots and NestJS/TypeORM/Redis wiring use `/adapters`. Existing
root imports remain supported until consumers are migrated in later issues.

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

The current application migration debt is recorded as exact file/module/symbol triplets in `LEGACY_APPLICATION_IMPORTS`. This is a ratchet, not a blanket exemption: adding a new edge or changing the imported symbol set fails CI; #429/#430 remove entries as adapters move outward.

## Explicit outer adapters

The exact framework-bound exclusions live in `FRAMEWORK_BOUND_ADAPTERS` in [`scripts/check-architecture.mjs`](../scripts/check-architecture.mjs). They are limited to:

- the privacy-state NestJS adapter in `llm-agent`;
- the platform student-report adapter in `student-report`.

The package `/adapters` barrels make the remaining NestJS/TypeORM/Redis
services explicit without widening the core rule. `cleanup-cron` is the only
affected package whose complete public implementation is intentionally
framework-bound.

The other mixed packages are enforced by selecting only their framework-neutral core paths; their runtime services are outside those scopes, not hidden behind a package-wide exemption. `cleanup-cron` is intentionally framework-bound and is not labelled as a core package.

Do not widen an adapter pattern merely to make CI green. A new entry needs an owner, a linked issue, and the narrowest file/path pattern that describes the adapter. The explicit core-entrypoint rule rejects framework, infrastructure, and adapter imports in every `/core` barrel; #429 owns the remaining application/account-link migration debt.

## Commands and CI

```bash
npm run architecture:test
npm run architecture:check
```

`npm run verify` and `npm run verify:affected` run the repository check. The pull-request workflow also runs the fixture suite, so malformed rule changes fail before the normal build/test matrix. A violation reports the owning package, source file and line, rule, imported symbols, and module specifier.
