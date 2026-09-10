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

- Domain code may use pure types and inner ports. It must not import NestJS, TypeORM, database packages, or presentation/infrastructure paths.
- Application ports may use inner contracts only. Concrete repositories, SDK clients, Redis, HTTP transports, and presentation types stay outside the port.
- Composition roots (`*.module.ts`, app bootstrap) may import both sides to bind an implementation to a port.
- Shared packages must never import app aliases (`@messenger/*`, `@discord/*`, `@zalo/*`).

## Enforced core scopes

`npm run architecture:check` parses production TypeScript import/export declarations and enforces these source scopes:

| Area                                                             | Framework-agnostic scope                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| Apps                                                             | Every `domain/**` and `application/ports/**` directory              |
| `contracts`                                                      | Entire package; it has zero imports                                 |
| `chat-history`, `chat-queue-core`, `chat-pipeline`, `date-utils` | Entire package                                                      |
| `llm-agent`                                                      | Package core, excluding the explicit privacy-state NestJS adapter   |
| `student-report`                                                 | Package core, excluding `platform-student-report.service.ts`        |
| `wispace-client`                                                 | Types, errors, utilities, cache policy/core, and plain HTTP clients |
| `chat-metering`                                                  | Types, policy cores, cost/safety functions, and memory counter      |
| `scheduler-core`, `study-reminder-shared`                        | Ports, types, and pure utilities                                    |
| `ops-health`                                                     | Health/data-quality types, configuration, and pure evaluator        |
| `cleanup-cron`                                                   | Framework-bound package; covered by the shared-package-to-app rule  |

Tests/specs, generated output, `dist`, and `node_modules` are excluded. Test code may import adapters to assemble a harness, but production code cannot hide a forbidden edge there.

## Explicit outer adapters

The exact adapter path patterns live in `FRAMEWORK_BOUND_ADAPTERS` in [`scripts/check-architecture.mjs`](../scripts/check-architecture.mjs). They cover:

- NestJS runtime wrappers in `llm-agent`, `student-report`, and `wispace-client`;
- NestJS/TypeORM modules, entities, repositories, and platform adapters in `chat-metering`;
- runtime services/infrastructure in `scheduler-core`, `study-reminder-shared`, and `ops-health`;
- all of `cleanup-cron`, which is intentionally framework-bound and is no longer described as a core package.

Do not widen an adapter pattern merely to make CI green. A new entry needs an owner, a linked issue, and the narrowest file/path pattern that describes the adapter. #429 and #430 own the remaining migrations; the enforced scopes should expand as those adapters move outward.

## Commands and CI

```bash
npm run architecture:test
npm run architecture:check
```

`npm run verify` and `npm run verify:affected` run the repository check. The pull-request workflow also runs the fixture suite, so malformed rule changes fail before the normal build/test matrix. A violation reports the owning package, source file and line, rule, imported symbols, and module specifier.
