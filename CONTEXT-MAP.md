# Bounded Context Map

This is the domain-level context map. The canonical glossary is in
[CONTEXT.md](CONTEXT.md).

This map describes intended ownership and compares it with the current code.
The repo is a modular monolith with a shared database; these contexts are not
independent services or databases.

## Contexts

| Context | Responsibility and ownership | Current code |
|---|---|---|
| **Platform Interaction** | Receives webhooks/gateway events, applies Messenger/Discord/Zalo-specific rules, sends messages, and owns delivery behavior. | `apps/messenger-bot/`, `apps/discord-bot/`, `apps/zalo-bot/` |
| **Account Linking** | Pairs `externalUserId` with WISPACE `userId`; owns linking, relinking, and token verification. | `apps/*/src/modules/account-link/`, `apps/*/src/modules/*-oauth/`, Messenger linking |
| **Learning Data ACL** | Adapts WISPACE data and roadmap exercise commands; WISPACE owns goals, scores, `UserCalendar`, roadmap state, exercise state, and precreation idempotency. The bot keeps only normalized views/ports needed by its use cases. | `packages/wispace-client/` |
| **Free-form Chat** | Owns debounce, history, LLM tool orchestration, and chat replies. It does not own report/reminder entities. | `packages/chat-agent/`, `packages/chat-pipeline/`, `packages/chat-history/` |
| **Study Reminder** | Calculates `remindAt`, syncs `UserCalendar` into outbox jobs, dispatches, retries, and cleans up jobs. | `packages/study-reminder-shared/`, app-specific reminder modules |
| **Student Report** | Builds `StudentCapacityReport` from a learning-data snapshot; owns parsing, fallback, and report formatting. | `packages/student-report/`, app-specific report delivery |
| **Metering & Operations** | Owns quota, idempotency, LLM usage/safety, health, cleanup, and operational endpoints. This is a supporting context. | `packages/chat-metering/`, `packages/ops-health/`, `packages/cleanup-cron/` |

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
6. `bot-common`, `date-utils`, LLM provider adapters, and database connection utilities are shared kernel/infrastructure, not bounded contexts.

## Known Boundary Debt

The following points are recorded as boundary debt, not complete boundaries:

- `chat-agent` currently knows about goals, calendar, report delivery, and rescheduling directly.
- `study-reminder-shared` currently contains calendar commands/rescheduling and cross-platform job-cancellation policy.
- `packages/database` currently exports report-claim, dead-letter, and reschedule domain entities/services from one package.
- `student-report` currently has direct Wispace and LLM-metering adapters; `StudentReportCore` is the closest part to a clean boundary.
- Account linking currently has platform-specific storage/flows and no unified context contract.

When a context develops a sufficiently distinct language, invariant, or set of
decisions, create `<context>/CONTEXT.md` and add its path to the table above.
Do not split out a service or database merely because a context map exists.
