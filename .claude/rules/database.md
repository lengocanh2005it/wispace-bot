---
alwaysApply: false
paths: apps/messenger-bot/src/infrastructure/database/**, packages/database/**
---

# Database & migrations

## Tables (migrations in repo)

- `user_platform_mappings` — `user_id` ↔ `(platform, external_user_id)` (renamed from `user_messenger_mappings` in Phase 2)
- `message_logs` — sent/received message audit for all platforms; Discord/Zalo delivery entities must map to this table and always write their `platform` value (no `discord_message_logs`/`zalo_message_logs` tables). Cron `messenger-message-log-cleanup` deletes rows older than `MESSENGER_MESSAGE_LOG_RETENTION_DAYS` (default 90) at 03:00 ICT every Monday
- `chat_daily_usage`, `chat_idempotency` — FREE_FORM chat quota + idempotency reserve/refund (renamed from `messenger_chat_*` in Phase 2) — entity + core logic owned by `packages/chat-metering` (shared with `apps/discord-bot`), messenger-bot is now just a thin wrapper
- `llm_usage_events`, `llm_safety_events` — token/cost + grounding-warning tracking — also owned by `packages/chat-metering`
- `study_reminder_jobs` — reminder outbox
- `users` + view `"Users"` — display name / exam date cache; only `user_id` entries with Messenger mapping
- `webhook_inbound_events` — durable authenticated Messenger/Zalo inbox; `raw_payload` is retained only for recovery and terminal rows are cleaned after `WEBHOOK_INBOUND_RETENTION_DAYS` (default 30)
- `webhook_dead_letters` — outbound delivery retry payloads; terminal rows are cleaned by the shared dead-letter cleanup

**Prod DB:** `ai_chat_bot_db`. Old hub `writing_ai_hub_db` — Tables already dropped (ops script). All tables above have been generalized to `(platform, external_user_id)` since Phase 2 — see `docs/turborepo-migration-plan.md`.

H7 migration created `messenger_chat_queue_buffer` + `messenger_chat_history` — **dropped** by `1717747200010-DropMessengerChatQueueBufferAndHistoryTables.ts` (queue/history moved to Redis or memory).

## User cache (dedicated DB, migration `1717747200008`)

- `users` — `user_id`, `display_name`, `exam_date` — only users with Messenger mapping (synced from Wispace `"Users"` on migration / new link).
- View `"Users"` — PascalCase mapping for `UserEntity` / `UserDisplayNameService` (read-only).
- Redis R5 (`RedisUserDisplayNameCache`): key `cache:user:display:{userId}` — read before Postgres when `REDIS_ENABLED=true`.

## Wispace hub (no migrations in repo)

- Sole HTTP API for calendar (`UserCalendar`, goals, scores) — **I3 ✓** no more `UserCalendars` DB fallback in app.
- `"Users"` view on `ai_chat_bot_db` (migration `1717747200008`) — read by the user display-name cache (`users` table / `"Users"` view, Redis R5 cache first). Calendar data is owned by Wispace and fetched through its HTTP API; the bot does not read the old `writing_ai_hub_db`.

## Adding a migration

1. Modify/add the entity in the owning package (`packages/database/src/entities/` for shared tables, or `apps/messenger-bot/src/infrastructure/database/entities/` for Messenger-only tables).
2. Create the migration in the owning package (`packages/database/src/migrations/` for shared tables, or `apps/messenger-bot/src/infrastructure/database/migrations/` for Messenger-only tables) with a timestamp prefix.
3. Run `npm run migration:run` in `apps/messenger-bot/`; its TypeORM options include the shared package migrations.

CLI generate (if needed): `npm run migration:generate -- src/infrastructure/database/migrations/TenMigration` (run in `apps/messenger-bot/`), then move shared-table entities/migrations to `packages/database/` when appropriate.

DB is shared across bots (Messenger, Discord, and Zalo) — keys generalized to `(platform, external_user_id)` in Phase 2, see `docs/turborepo-migration-plan.md`. Entities for the 4 chat-metering tables (`chat_daily_usage`, `chat_idempotency`, `llm_usage_events`, `llm_safety_events`) live in `packages/chat-metering` — **do not** add duplicate entities in `apps/*/infrastructure/database/entities/` — only migrations (run by messenger-bot) modify these tables' schemas.

## Naming convention for new migrations (applied going forward, not retroactively)

When adding a new migration (Discord, Zalo, or new shared table):

- **Platform-specific table** → platform prefix in class/file name: `Create<Platform><Feature>Table`, e.g. `CreateZaloAccountLinksTable` (consistent with existing `CreateDiscordAccountLinksTable`).
- **Truly cross-platform table** (entity lives in `packages/*`, following `chat-metering` pattern) → name reflects the domain, **no** misleading platform prefix (don't name `CreateMessenger...` for a shared table).
- **Do not rename existing migration files** to match this convention — TypeORM records executed migrations by **class name** in the `migrations` table in prod DB (`ai_chat_bot_db`); renaming a class = production thinks it's a new migration → re-runs/errors. Convention only applies to new files.

## Ownership of 18 existing migrations (static reference, not retroactive)

| Group                             | File                                                         | Tables touched                                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Messenger-only                    | `1717747200000-CreateMessengerTables`                        | `user_messenger_mappings`, `messenger_message_logs`                                                                                                                          |
| Messenger-only                    | `1717747200001-CreateStudyReminderJobs`                      | `study_reminder_jobs`                                                                                                                                                        |
| Messenger-only                    | `1717747200002-CreateMessengerChatRateLimitTables`           | `messenger_chat_daily_usage`, `messenger_chat_idempotency` (pre-rename generic names)                                                                                        |
| Messenger-only                    | `1717747200003-CreateMessengerChatSharedQueueTables`         | `messenger_chat_queue_buffer`, `messenger_chat_history`, `messenger_chat_webhook_seen`                                                                                       |
| Messenger-only                    | `1717747200004-CreateMessengerScheduledReportClaims`         | `messenger_scheduled_report_claims`                                                                                                                                          |
| Messenger-only                    | `1717747200005-CreateMessengerWebhookDeadLetterTable`        | `messenger_webhook_dead_letters`                                                                                                                                             |
| Messenger-only                    | `1717747200006-CreateReportSendJobs`                         | `report_send_jobs`                                                                                                                                                           |
| Messenger-only                    | `1717747200007-AddMessengerIndexes`                          | index-only, no new tables                                                                                                                                                    |
| Messenger-only                    | `1717747200008-CreateMessengerUsersCacheTable`               | `users` (+ view `"Users"`)                                                                                                                                                   |
| Messenger-only                    | `1717747200009-DropMessengerChatWebhookSeenTable`            | drop `messenger_chat_webhook_seen`                                                                                                                                           |
| Messenger-only                    | `1717747200010-DropMessengerChatQueueBufferAndHistoryTables` | drop `messenger_chat_queue_buffer`, `messenger_chat_history`                                                                                                                 |
| Messenger-only                    | `1717747200011-TrimUsersCacheToMessengerMappings`            | alter `users` (index-only)                                                                                                                                                   |
| Messenger-only                    | `1717747200012-AddUniqueActiveMessengerMappingIndexes`       | index-only on `user_messenger_mappings`                                                                                                                                      |
| Shared (`packages/chat-metering`) | `1717747200013-CreateC2QuotaAndLlmUsageTables`               | `messenger_chat_events` (predecessor of `chat_quota_events`), `llm_usage_events`                                                                                             |
| Shared (`packages/chat-metering`) | `1751029200000-CreateLlmSafetyEventsTable`                   | `llm_safety_events`                                                                                                                                                          |
| Shared (`packages/chat-metering`) | `1751029200003-AddLlmUsageEventsCachedTokens`                | alter `llm_usage_events`                                                                                                                                                     |
| Cross-platform (generalized)      | `1751029200001-GeneralizePlatformIdentifiers`                | alter `user_messenger_mappings` → `user_platform_mappings`, rename chat-metering tables to generic (`chat_daily_usage`, `chat_idempotency`, `chat_quota_events`)             |
| Discord                           | `1751029200002-CreateDiscordAccountLinksTable`               | `discord_account_links`                                                                                                                                                      |
| Shared (cleanup/ops hot queries)  | `1751029200010-AddCleanupAndClaimIndexes`                    | index-only on `chat_idempotency` (`platform, status, reserved_at`), `scheduled_report_claims` (`user_id, report_date, status` + `created_at`), `message_logs` (`created_at`) |
| Shared (durable webhook inbox)    | `1751029200014-CreateWebhookInboundEvents`                   | `webhook_inbound_events` — authenticated inbound payloads, retry state, unique `(platform, event_id)`                                                                        |
| Shared (durable webhook inbox)    | `1751029200015-AddWebhookInboundCleanupIndex`                | cleanup index on `webhook_inbound_events` (`platform, status, created_at`)                                                                                                   |
| Zalo OAuth cleanup                | `1751029200016-AddZaloOauthStateCleanupIndex`                | cleanup index on `zalo_oauth_states` (`created_at`)                                                                                                                          |

## Notes

- `data-source.ts` is used by TypeORM CLI (`dist/infrastructure/database/data-source.js`).
- App uses `typeorm.options.ts` via `DatabaseModule`.
- `DB_MIGRATIONS_RUN=true` → auto migrate on start.
- ORM entities are **not** placed in `modules/*/domain/` — domain is for pure types only.
- `raw_payload` is intentionally kept intact for replay; logs and persisted error strings must mask external IDs. Ops scripts may read recovery payloads but must print only masked identifiers and sanitized errors.
- A stale `processing` webhook inbox lease is terminalized instead of replayed automatically; replaying after an uncertain side effect could send a duplicate outbound message.
