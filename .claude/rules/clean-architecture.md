# Clean Architecture — wispace-bots (Turborepo monorepo)

Repo uses **feature modules + 4 layers** following NestJS Clean Architecture (reference: [clean-nestjs-cli](https://github.com/jheisonnovak/clean-nestjs-cli), [NestJS-DDD-DevOps](https://andrea-acampora.github.io/nestjs-ddd-devops/)), inside `apps/messenger-bot/src/`. Paths below are relative to `apps/messenger-bot/src/` unless stated otherwise.

## Monorepo boundary: `packages/llm-agent`

`packages/llm-agent` (`@wispace/llm-agent`) is a **framework-agnostic** package shared across all bots (Messenger, Discord, Zalo) — contains LLM function-calling orchestration (`LlmAgentService`), provider abstraction (`LlmProviderAdapter` interface + OpenAI/OpenAI-compatible adapters), tool schema (`AGENT_TOOLS`), safety utils (prompt injection, grounding, LLM error), and WISPACE domain text/scope utils.

- **Do not** import NestJS/TypeORM/Express in `packages/llm-agent` — the `openai` npm package is still a dependency (used in the OpenAI adapter).
- **Do not** put Wispace API / DB business logic in this package — that belongs in tool handlers (`ToolExecutorPort`), living in each app (`apps/messenger-bot/src/modules/messenger/application/agent/messenger-agent-tools.service.ts`).
- Each app implements the ports (`LlmExecutionPort`, `LlmUsageRecorderPort`, `LlmSafetyEventPort`, `AgentMetricsPort`, `ToolExecutorPort<T>`) using real NestJS services, then calls `new LlmAgentService(config, ports)` — see `apps/messenger-bot/src/modules/messenger/application/agent/messenger-agent.service.ts` for a thin adapter example.
- Modify package → must rebuild + test all dependent apps (`npx turbo run build test --filter=@wispace/messenger-bot...`).

## Monorepo boundary: `packages/chat-metering`

`packages/chat-metering` (`@wispace/chat-metering`) is the second framework-agnostic package, shared across chat quota/rate-limit (`chat_daily_usage`, `chat_idempotency`) + LLM usage/safety event tracking (`llm_usage_events`, `llm_safety_events`) — all 4 tables generalized to `(platform, external_user_id)` since Phase 2, `platform` passed via constructor instead of hardcoded.

- **Do not** import NestJS in the package — only dependency is `typeorm` (uses `Repository<T>`/`EntityManager` directly, not `@nestjs/typeorm` decorators). Each app registers entities via `TypeOrmModule.forFeature([...])` then passes `Repository<T>` into the core class constructor (`ChatRateLimitCore`, `LlmUsageRecorderCore`, `LlmSafetyCore`) — same pattern as apps implementing ports for `@wispace/llm-agent`.
- **Do not move** into the package: whitelist/hint UX, quota-event audit table (`chat_quota_events`), stuck-reserved recovery cron, ops CLI scripts, BullMQ queue wiring, Redis burst counter, `MetricsService`/prom-client — these remain in each app (currently only `apps/messenger-bot` has them all; `apps/discord-bot` uses a simplified version: `MemoryBurstCounter` + `DirectUsageWriter`, no BullMQ).
- `apps/messenger-bot`'s `ChatRateLimitRepository`/`LlmUsageRepository`/`LlmSafetyEventRepository` (infrastructure layer) are **thin wrappers** around the package core (platform='messenger') — preserving the `*RepositoryPort` interface + all consumers unchanged. Ops-only methods (`incrementDailyUsage`, `countStuckReserved`, ...) are not in the package, remaining in the wrapper.
- `apps/discord-bot` uses the same entity/core class, platform='discord' — see `apps/discord-bot/src/modules/chat-metering/`.
- Modify package → rebuild + test both apps (`npx turbo run build test --filter=@wispace/messenger-bot... --filter=@wispace/discord-bot...`).

## Monorepo boundary: `packages/wispace-client`

`packages/wispace-client` (`@wispace/wispace-client`) is the third framework-agnostic package — HTTP client for calling Wispace API (User/goals, TaskScoreAverage, UserCalendar) + retry/error (`withRetry`, `WispaceApiError`) + date/timezone utils (`study-calendar.utils.ts`), shared by Messenger + Discord.

- **Do not** import NestJS — uses plain `fetch`. App reads `ConfigService` (URL, `WISPACE_INTERNAL_KEY`, retry settings) then passes `WispaceApiClientConfig` into the client constructor (`UserGoalsApiClient`, `TaskScoreAverageApiClient`, `UserCalendarApiClient`, `UserCalendarScheduleClient`).
- Student identification headers are generalized via `buildWispaceHeaders(idHeader, externalId, internalKey)` — `idHeader` ∈ `x-psid` \| `x-discordid` \| `x-zaloid` (Wispace API already supports all 3, confirmed by user — no changes needed on WISPACE side, just send the correct header for the platform).
- **Do not move** into the package: report-generation business logic (`StudentReportService`'s LLM call + capacity mapping), reschedule confirmation UI (Messenger postback button — `MessengerRescheduleConfirmationService`), notification-window subscription (`register_exam_report_notifications`) — these are platform-specific, remaining in each app.
- `apps/messenger-bot`'s `UserGoalsApiService`/`TaskScoreAverageApiService`/`UserCalendarApiService`/`UserCalendarScheduleService` are **thin wrappers** around the package client (idHeader='x-psid') — preserving public API; report-specific mapping (`mapToCapacityInput`) remains in the wrapper.
- `apps/discord-bot` uses `modules/wispace/` (`WispaceGoalsService`, `WispaceCalendarService`, idHeader='x-discordid') to wire real tool handlers in `DiscordAgentToolsService`.
- Modify package → rebuild + test both apps (`npx turbo run build test --filter=@wispace/messenger-bot... --filter=@wispace/discord-bot... --filter=@wispace/wispace-client...`).

## Monorepo boundary: `packages/chat-history`

`packages/chat-history` (`@wispace/chat-history`) is the fourth framework-agnostic package — `MemoryChatHistoryStore` (in-memory, TTL + turn cap) + `ChatHistoryStorePort`/`ChatHistoryMessage` shared across all bots.

- **Do not** import NestJS in the package — plain class, constructor accepts `{ ttlMs, maxMessages }`.
- Each app decides whether to wrap `MemoryChatHistoryStore` behind a distributed backend: `apps/messenger-bot`'s `MemoryChatHistoryStore` (infrastructure, Nest `@Injectable`) is a **thin wrapper** around the package core, reading TTL/maxMessages from `MessengerChatSharedConfigService`; `ChatHistoryStoreResolver` still selects Redis when `CHAT_HISTORY_STORE=redis` (Redis store is **not** in the package — it's infrastructure-specific to each app).
- `apps/discord-bot`'s `DiscordChatHistoryService` uses the package core directly (reads TTL/maxMessages via `CHAT_HISTORY_TTL_MS`/`CHAT_HISTORY_MAX_MESSAGES`, default 30 minutes / 20 messages) — no distributed backend yet, see `docs/turborepo-migration-plan.md` Phase 3.
- Modify package → rebuild + test both apps (`npx turbo run build test --filter=@wispace/messenger-bot... --filter=@wispace/discord-bot... --filter=@wispace/chat-history`).

## Monorepo boundary: `packages/student-report`

`packages/student-report` (`@wispace/student-report`) is the fifth framework-agnostic package — `StudentReportCore` (fetch capacity → call LLM → parse JSON → fallback → format student competency report text), types (`StudentCapacityInput`/`StudentCapacityReport`), errors (`StudentReportNoScoreDataError`, `StudentReportRetryableError`), and messages (R1/R3 guidance) shared across all bots.

- **Do not** import NestJS — only dependencies are `openai` + `@wispace/llm-agent` (reusing `LlmExecutionPort`/`LlmUsageRecorderPort`). App implements `CapacityDataPort` (calls Wispace API) + real LLM ports using NestJS services, then `new StudentReportCore(config, ports)` — see `apps/messenger-bot/src/modules/student-report/application/services/student-report.service.ts` for a thin adapter.
- Markdown-stripping (Messenger doesn't render Markdown) is **platform-specific** — passed via `config.sanitizeText` (optional hook), not hardcoded in the package. Discord/Zalo can leave it empty to preserve Markdown.
- **Do not move** into the package: `StudentCapacityService`/real Wispace API calls, scheduled report cron (`ReportCronService`), retry/outbox logic (`report-send-retry-dispatch.service.ts`) — these are app-specific, remaining in `apps/messenger-bot`.
- App-local domain error classes (`apps/messenger-bot/src/modules/student-report/domain/errors/*.ts`) only **re-export** the package's classes — required for `instanceof` to match between throw site (`TaskScoreAverageApiService`) and catch site (`MessengerService`, `ReportCronService`, `ReportSendRetryDispatchService`); do not create duplicate class names locally.
- Modify package → rebuild + test `apps/messenger-bot` (`npx turbo run build test --filter=@wispace/messenger-bot... --filter=@wispace/student-report`).

## Monorepo boundary: `packages/chat-queue-core`

`packages/chat-queue-core` (`@wispace/chat-queue-core`) is the sixth framework-agnostic package — `DebounceChatQueue<TContext>`, a per-user debounce/merge state machine (buffers during debounce window, merges incoming messages while previous batch is processing, evicts idle users) shared across all bots.

- **Do not** import NestJS — plain class. All content logic (merge/cap text, reserve quota, call LLM, send outbound) lives in `ChatQueueFlushHandler` injected by the app, **not** in the core.
- **Idempotency key**: the package exports type `IdempotencyKeyPort<TRawMessage>` — this is a **contract**, not logic running in the core. Idempotency key (Messenger: `message.mid`, Discord: `message.id`) is resolved by each platform at the ingestion layer (webhook/gateway) **before** calling `enqueue()`; core only carries that string through `ChatQueueBatch.idempotencyKey`, not interpreting it.
- `apps/messenger-bot`'s `MessengerChatQueueService` uses `DebounceChatQueue` for **memory mode** (`CHAT_QUEUE_STORE=memory`); Redis/distributed mode (`enqueueDistributed`, `flushDistributed`, `ChatQueueStorePort`) is **not** in the package — infrastructure-specific, kept in app (same pattern as `@wispace/chat-history`: only memory backend is split out, Redis stays in app).
- Modify package → rebuild + test `apps/messenger-bot` (`npx turbo run build test --filter=@wispace/messenger-bot... --filter=@wispace/chat-queue-core`). `apps/discord-bot` doesn't have debounce/queue yet — when adding, use this package directly instead of rewriting the state machine.

## Monorepo boundary: `packages/study-reminder-core`

`packages/study-reminder-core` (`@wispace/study-reminder-core`) is the seventh framework-agnostic package — pure functions for computing study reminder schedules (`computeRemindAt`, `getMinutesUntilSession`, `isSessionStarted`, `formatScheduledTimeLabel`), stateless, no config/IO.

- **Do not** import anything beyond `Intl`/`Date` built-ins. App reads `STUDY_REMINDER_*` from `ConfigService` then passes values (minutesBefore, minLeadMinutes, timezone) into pure functions — see `apps/messenger-bot/src/modules/study-reminder/application/services/study-reminder-schedule.service.ts` for a thin adapter.
- **Not yet split**: orchestration sync (`StudyReminderSyncService`: query mapping → fetch session → upsert job) and dispatch (`StudyReminderDispatchService`: claim job → send via `MESSAGE_SENDER`) — both are behind their own ports (`MessengerMappingReaderPort`, `StudyReminderJobRepositoryPort`) but **no second bot needs them yet** (Discord reads/writes calendar directly via `DiscordStudyCalendarCommandService`, including `reschedule_study_session`, but doesn't have its own job reminder/outbox sync system yet). Forcing the split now is premature abstraction with no real consumer to verify — save it when Discord/Zalo actually need separate reminder jobs.
- Modify package → rebuild + test `apps/messenger-bot` (`npx turbo run build test --filter=@wispace/messenger-bot... --filter=@wispace/study-reminder-core`).

## Dependency flow within one app (mandatory)

```
presentation → application → domain ← infrastructure
```

| Layer | Directory | Allowed | Not allowed |
|-------|-----------|---------|-------------|
| **Domain** | `domain/` | Types, pure entities, repository **interfaces** | Import NestJS, TypeORM, HTTP, LLM provider, services from other modules |
| **Application** | `application/` | Use cases / services, ports (interface + Symbol token) | Controller, TypeORM entity, direct `fetch` |
| **Infrastructure** | `infrastructure/` | Repository impl, API client, Meta profile | Import `presentation/` |
| **Presentation** | `presentation/` | Controller, (DTO if any) | Business logic — only delegate down to `application/` |

**Shared / cross-cutting** (not feature modules, inside `apps/messenger-bot/src/`):

- `shared/config/` — POC constants (`poc.constants.ts`)
- `shared/common/` — guards, shared modules
- `shared/prompts/` — `*.system.txt` (Messenger-specific content), loaded via `loadSystemPromptFile()` from `@wispace/llm-agent`
- `infrastructure/database/` — TypeORM entities, migrations, `DatabaseModule` (shared DB, not yet split into package — see `docs/turborepo-migration-plan.md` Phase 2)

## Feature module structure

```
apps/messenger-bot/src/modules/<feature>/
├── <feature>.module.ts
├── domain/
│   ├── entities/          # pure types (no @Entity)
│   └── repositories/      # *.repository.port.ts + export Symbol token
├── application/
│   ├── ports/             # cross-module communication interfaces
│   ├── services/          # orchestration / use cases (@Injectable)
│   ├── messages/          # user-facing copy (if needed)
│   └── utils/
├── infrastructure/
│   ├── persistence/       # TypeORM repository implements port
│   └── wispace/ | meta/   # HTTP client, Meta API
└── presentation/
    └── controllers/
```

## Existing modules (`apps/messenger-bot`)

| Module | Nest module | Notes |
|--------|-------------|-------|
| messenger | `MessengerModule` + `MessengerOutboundModule` | Webhook, chat queue/agent (adapter uses `@wispace/llm-agent`), shared state H7; outbound = Send API |
| chat-rate-limit | `ChatRateLimitModule` | FREE_FORM quota, idempotency, hard cap H3 |
| student-report | `StudentReportModule` | No controller |
| study-reminder | `StudyReminderModule` | Cron in worker; HTTP ops in `SchedulerModule` |
| scheduler | `SchedulerModule` | Report cron + ops HTTP `/messenger/*` |

## Ports & DI tokens (cross-module, in `apps/messenger-bot`)

| Token | Interface | Implementor | Consumer |
|-------|-----------|-------------|----------|
| `MESSENGER_REPOSITORY` | `MessengerRepositoryPort` | `MessengerRepository` | `MessengerService`, `ReportCronService` |
| `MESSENGER_MAPPING_READER` | `MessengerMappingReaderPort` | `MessengerRepository` | `StudyReminderSyncService`, `UserDisplayNameService` |
| `MESSAGE_SENDER` | `MessageSenderPort` | `MessengerOutboundService` | `StudyReminderDispatchService` |
| `CHAT_RATE_LIMIT_REPOSITORY` | `ChatRateLimitRepositoryPort` | `ChatRateLimitRepository` | `ChatRateLimitService` |
| `CHAT_QUEUE_STORE` | `ChatQueueStorePort` | `ChatQueueStoreResolver` → Redis | `MessengerChatQueueService` (distributed) |
| `CHAT_HISTORY_STORE` | `ChatHistoryStorePort` | `ChatHistoryStoreResolver` | `MessengerChatHistoryService` |
| `STUDY_REMINDER_JOB_REPOSITORY` | `StudyReminderJobRepositoryPort` | `StudyReminderJobRepository` | (backup inject via port) |

**Rule:** Application layer injects ports using `@Inject(TOKEN)` + `import type` for interfaces (isolatedModules). Outside apps (in `@wispace/llm-agent` package), uses plain port constructors (no NestJS DI).

**Do not** import `MessengerModule` from `StudyReminderModule` — use `MessengerOutboundModule`.

**Do not** use `forwardRef` between messenger ↔ study-reminder (removed).

## Adding new code — checklist

1. Identify the **app** (`apps/messenger-bot`, or new bot app) then the **feature module** within it — do not create loose files at `src/` root (except `app.*`, `main.ts`).
2. **Domain types** → `domain/entities/` or `domain/types/` — no ORM decorators.
3. **TypeORM entity** → `apps/messenger-bot/src/infrastructure/database/entities/` + migration.
4. **Repository** — interface in `domain/repositories/`; class in `infrastructure/persistence/`; bind token in `*.module.ts`.
5. **HTTP** → `presentation/controllers/` — call application service, do not call repository directly.
6. **Wispace / Meta / LLM provider** → `infrastructure/` of the corresponding module (in app), or `packages/llm-agent` if it's orchestration/schema shared across all bots.
7. **Platform-specific LLM prompts** → `apps/<bot>/src/shared/prompts/`; load via `loadSystemPromptFile()` from `@wispace/llm-agent`. **Shared messages** (not platform-specific) → `packages/llm-agent/src/messages.ts`.
8. After modifying prompts: `npx turbo run build --filter=@wispace/messenger-bot...` (assets → `apps/messenger-bot/dist/shared/prompts/`).

## Anti-patterns

| Wrong | Correct |
|-------|---------|
| `@Entity()` in `domain/` | ORM entity in `infrastructure/database/entities/` |
| `StudyReminderModule` imports `MessengerModule` | Import `MessengerOutboundModule` + port |
| `MessengerService` in dispatch | `MESSAGE_SENDER` + `StudyReminderService` |
| Reserve quota in webhook | `ChatRateLimitService` in `MessengerChatQueueService` flush |
| New service in `apps/messenger-bot/src/messenger/*.ts` (flat) | Correct layer in `apps/messenger-bot/src/modules/messenger/...` |
| Import NestJS/TypeORM in `packages/llm-agent` | Package only uses port interface, app implements with Nest |
| Wispace API business logic in `packages/llm-agent` | Tool handler stays in app, implements `ToolExecutorPort` |
| Hardcode old migration path `dist/database/` | `apps/messenger-bot/dist/infrastructure/database/data-source.js` |

## Verify

Before completing a task: `npx turbo run lint build test --filter=@wispace/messenger-bot...` (add `--filter=@wispace/llm-agent` if package was modified).
