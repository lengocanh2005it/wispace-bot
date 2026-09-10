# 4-layer Clean Architecture

The executable boundary map is [docs/architecture-boundaries.md](../../docs/architecture-boundaries.md). The repository is migrating incrementally: the guard protects the named core scopes and app domain/application edges while #429/#430 complete the remaining mixed-package extraction.

Each feature module in `apps/messenger-bot/src/modules/` follows 4 layers: `domain` → `application` ← `infrastructure` → `presentation`. Domain contains only pure types and repository interfaces, with no NestJS or TypeORM dependencies.

## Rationale

- **Testability**: Domain and application services are framework-independent → fast unit tests, no need to mock NestJS container.
- **Safe cross-module DI**: Modules communicate via ports (`MESSAGE_SENDER`, `MESSENGER_REPOSITORY`) instead of importing services directly. Prevents circular dependencies (especially `StudyReminderModule` → `MessengerOutboundModule`, not `MessengerModule`).
- **Framework-agnostic package cores**: the named core scopes in shared packages are pure policy/client code; explicit outer adapters remain framework-bound during the migration. The cores can be used with any bot framework (NestJS, Express, Fastify).
- **Clear responsibility separation**: Thin controllers (delegate to application), services contain business logic, infrastructure handles persistence and external calls only.

## Alternatives considered

| Alternative                                     | Reason for rejection                                                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| NestJS default flat (everything in `services/`) | Circular dependencies occur easily when modules import each other. Hard to test because of NestJS container dependency. |
| Hexagonal architecture (ports & adapters)       | Similar but NestJS already has a built-in DI container, no need for an additional abstraction layer.                    |
| Full DDD (entities, value objects, aggregates)  | Too heavy at this stage. Requires more boilerplate than necessary.                                                      |

## Consequences

- Each module has more files (4 subdirectories). New developers need time to familiarize themselves.
- Discipline required: do not import TypeORM entities in the domain layer, do not use `@Inject()` in domain interfaces.
- When scaling, cross-module ports (`MESSAGE_SENDER` etc.) will need additional versioning or API contracts when splitting into microservices.
