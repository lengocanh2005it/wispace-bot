# Bounded Context Map

This is the domain-level context map. The canonical glossary is in
[CONTEXT.md](CONTEXT.md).

This map describes intended ownership and compares it with the current code.
The repo is a modular monolith with a shared database; these contexts are not
independent services or databases.

## Contexts

| Context                   | Responsibility and ownership                                                                                                                                                                                                  | Current code                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Platform Interaction**  | Receives webhooks/gateway events, applies Messenger/Discord/Zalo-specific rules, sends messages, and owns delivery behavior.                                                                                                  | `apps/messenger-bot/`, `apps/discord-bot/`, `apps/zalo-bot/`, `packages/database/src/services/platform-interaction/` (mis-housed services) |
| **Account Linking**       | Pairs `externalUserId` with WISPACE `userId`; owns linking, relinking, and token verification.                                                                                                                                | `apps/*/src/modules/account-link/`, `apps/*/src/modules/*-oauth/`, Messenger linking, `packages/database/src/services/account-linking/` (mis-housed services) |
| **Learning Data ACL**     | Adapts WISPACE data and roadmap exercise commands; WISPACE owns goals, scores, `UserCalendar`, roadmap state, exercise state, and precreation idempotency. The bot keeps only normalized views/ports needed by its use cases. | `packages/wispace-client/`                                                           |
| **Free-form Chat**        | Owns debounce, history, LLM tool orchestration, and chat replies. It does not own report/reminder entities.                                                                                                                   | `packages/chat-agent/`, `packages/chat-pipeline/`, `packages/chat-history/`          |
| **Study Reminder**        | Calculates `remindAt`, syncs `UserCalendar` into outbox jobs, dispatches, retries, and cleans up jobs.                                                                                                                        | `packages/study-reminder-shared/`, app-specific reminder modules                     |
| **Student Report**        | Builds `StudentCapacityReport` from a learning-data snapshot; owns the canonical report prompt, parsing, fallback, and report formatting.                                                                                       | `packages/student-report/`, app-specific report delivery                             |
| **Metering & Operations** | Owns quota, idempotency, LLM usage/safety, health, cleanup, and operational endpoints. This is a supporting context.                                                                                                          | `packages/chat-metering/`, `packages/ops-health/`, `packages/cleanup-cron/`, `packages/database/src/services/metering-and-operations/` (mis-housed services) |

## Relationships

```text
WISPACE Learning Data
        │  upstream external system
        ▼
Learning Data ACL ───────────────┬──> Student Report ──> Platform Interaction
                                 └──> Study Reminder ──> Platform Interaction

Account Linking ──> externalUserId / WISPACE userId ──> Chat, Report, Reminder

Platform Interaction ──> Free-form Chat ──> Learning Data ACL / Report / Reminder
Free-form Chat ──> Metering & Operations
Student Report ──> Metering & Operations
Study Reminder ──> Metering & Operations
```

Exercise precreation remains a capability of the Learning Data ACL consumed by
Free-form Chat; it is not a separate bounded context while the bot only
requests the next exercise and sends WISPACE's link.

## Boundary Rules

1. Each context owns its domain types, invariants, and persistence.
2. Other contexts communicate through ports or DTOs; they do not import another context's TypeORM entities.
3. `wispace-client` is an Anti-Corruption Layer, not a domain model shared by every context.
4. `externalUserId`, `userId`, and `platform` are shared identity vocabulary; they must not become a reason to put all business logic in one package.
5. Platform-specific delivery crosses an outbound port; Reminder and Report do not call Messenger/Discord/Zalo services directly.
6. `bot-common`, `bot-metrics`, `date-utils`, `llm-agent`, and database connection utilities are shared kernel/infrastructure, not bounded contexts. `llm-agent` is consumed by four contexts and has no runtime dependency on any of them; `bot-metrics` is consumed only at app composition roots.
7. The daily report wave — leader election, per-learner claim, retry dispatch, and delivery — belongs to Platform Interaction and lives inside that platform's own feature module. The report window and report content remain Student Report's. See [ADR 0055](docs/adr/0055-messenger-report-scheduling-is-messenger-behaviour.md).

## Known Boundary Debt

The following points are recorded as boundary debt, not complete boundaries:

- `chat-agent` currently knows about goals, calendar, report delivery, and rescheduling directly.
- `study-reminder-shared` currently contains calendar commands/rescheduling and cross-platform job-cancellation policy.
- `packages/database` owns every entity and migration, which is correct by
  design. It also still hosts services owned by other contexts: Platform
  Interaction, Account Linking, and Metering & Operations services live under
  `services/<context>/`, and `services/cross-cutting/` holds four modules no
  context owns — `canonical-platform`, `web-activity`, `learner-usage-query`,
  `cron-leader-lease`. The folder records that debt; the fix is moving each
  module to an owning package.
- `student-report` currently has direct Wispace and LLM-metering adapters; `StudentReportCore` is the closest part to a clean boundary.
- Account linking currently has platform-specific storage/flows and no unified context contract.
- `llm-agent` is shared kernel by the evidence in rule 6, and it also holds free-form-chat-specific content: the chat system prompt core, the canned learner-facing reply copy, the WISPACE chat tool catalog, the greeting fast path, the scope gate, and the input classifier prompt. Its three `chat-history` imports are type-only uses of `ChatHistoryMessage`, which is why they do not make it a Free-form Chat package. A cross-context package carrying one context's prompt and tools is a placement question rather than a rule violation — nothing imports the package *because* of that content — and moving it is a separate decision from classifying it.

When a context develops a sufficiently distinct language, invariant, or set of
decisions, create `<context>/CONTEXT.md` and add its path to the table above.
Do not split out a service or database merely because a context map exists.
