# Design: TypeORM Migration Naming Convention & Ownership (multi-bot)

**Date:** 2026-07-10
**Scope:** `packages/database/src/migrations/`, `.claude/rules/database.md`

## Context

At design time (2026-07-10), the repo had 18 migration files in `apps/messenger-bot/src/infrastructure/database/migrations/`, running through a single pipeline (`messenger-bot` — `docs/turborepo-migration-plan.md` Phase 5 specifies discord-bot does **not** run `migration:run` independently to avoid race conditions). Entities shared across bots (chat-metering: `chat_daily_usage`, `chat_idempotency`, `llm_usage_events`, `llm_safety_events`) had already been moved to `packages/chat-metering/src/entities/` — no duplication.

> **Current status (2026-08-13):** Shared migrations now live in `packages/database/src/migrations/`; that directory contains 27 migration files, including the later Zalo, idempotency, cleanup, dead-letter, reschedule, leader-lease, and durable-inbox migrations. The centralized `apps/messenger-bot` migration pipeline remains current. The 18-file ownership table below is intentionally preserved as the historical design baseline.

Pain point: migration file/class names do not consistently reflect platform ownership. Most have a `Messenger...` prefix even though some later migrations (`CreateC2QuotaAndLlmUsageTables`, `GeneralizePlatformIdentifiers`) are cross-platform tables; `CreateDiscordAccountLinksTable` has a `Discord` prefix but lives in the same flat folder with no visual distinction. When the Zalo bot is deployed (Phase 4) and the team adds new migrations, this will become harder to trace.

## Key Constraints

TypeORM stores executed migrations in the `migrations` table in the prod DB (`ai_chat_bot_db`) by **class name**, not by file path. Renaming a migration class that has already run in production will cause TypeORM to not recognize it as executed → attempt to re-run → error or schema duplication. Therefore **do not rename/modify any of the 18 existing migrations**.

## Decisions Made (via discussion)

- Keep the centralized pipeline — only `messenger-bot` runs `migration:run` for all bots.
- Do not create a `@wispace/migrations` package or any new package — the issue is naming/organization, not architecture.
- Do not create physical subfolders (`migrations/shared/`, `migrations/discord/`...) — keep the `data-source.ts` glob simple, avoid unnecessary risk/complexity for minimal benefit.

## Design

### 1. Naming Convention for New Migrations (applied from now, not retroactively)

When adding a new migration (Discord, Zalo, or new shared table):

- **Platform-specific table** → platform prefix in class/file name: `Create<Platform><Feature>Table`, e.g. `CreateZaloAccountLinksTable` (consistent with existing `CreateDiscordAccountLinksTable`).
- **Truly cross-platform table** (entity lives in `packages/*`, following the `chat-metering` pattern) → name reflects the domain, **no** misleading platform prefix (do not name `CreateMessenger...` for a shared table). Example: a functionally descriptive name like `CreateXyzTable`.
- Do not rename/migrate old files to match convention — only applies to new files.

### 2. Ownership Lookup Table for 18 Existing Migrations

Add a short table to `.claude/rules/database.md` (new section, under "Adding migrations"), listing which of the 18 current files belong to which group: **Messenger-only** / **Discord** / **Shared (packages/chat-metering)** / **Cross-platform (generalize)**. This is a static reference document, no code changes.

Classification verified (read actual `CREATE TABLE`/`ALTER TABLE`/`DROP TABLE` in each file):

| Group | File | Tables Affected |
|-------|------|-----------------|
| Messenger-only | `1717747200000-CreateMessengerTables` | `user_messenger_mappings`, `messenger_message_logs` |
| Messenger-only | `1717747200001-CreateStudyReminderJobs` | `study_reminder_jobs` |
| Messenger-only | `1717747200002-CreateMessengerChatRateLimitTables` | `messenger_chat_daily_usage`, `messenger_chat_idempotency` (predecessors before generic rename in `chat-metering`) |
| Messenger-only | `1717747200003-CreateMessengerChatSharedQueueTables` | `messenger_chat_queue_buffer`, `messenger_chat_history`, `messenger_chat_webhook_seen` |
| Messenger-only | `1717747200004-CreateMessengerScheduledReportClaims` | `messenger_scheduled_report_claims` |
| Messenger-only | `1717747200005-CreateMessengerWebhookDeadLetterTable` | `messenger_webhook_dead_letters` |
| Messenger-only | `1717747200006-CreateReportSendJobs` | `report_send_jobs` |
| Messenger-only | `1717747200007-AddMessengerIndexes` | index-only, no new tables |
| Messenger-only | `1717747200008-CreateMessengerUsersCacheTable` | `users` (+ view `"Users"`) |
| Messenger-only | `1717747200009-DropMessengerChatWebhookSeenTable` | drop `messenger_chat_webhook_seen` |
| Messenger-only | `1717747200010-DropMessengerChatQueueBufferAndHistoryTables` | drop `messenger_chat_queue_buffer`, `messenger_chat_history` |
| Messenger-only | `1717747200011-TrimUsersCacheToMessengerMappings` | alter `users` (index-only, no new table) |
| Messenger-only | `1717747200012-AddUniqueActiveMessengerMappingIndexes` | index-only on `user_messenger_mappings` |
| Shared (packages/chat-metering) | `1717747200013-CreateC2QuotaAndLlmUsageTables` | `messenger_chat_events` (predecessor `chat_quota_events`), `llm_usage_events` |
| Shared (packages/chat-metering) | `1751029200000-CreateLlmSafetyEventsTable` | `llm_safety_events` |
| Shared (packages/chat-metering) | `1751029200003-AddLlmUsageEventsCachedTokens` | alter `llm_usage_events` |
| Cross-platform (generalize) | `1751029200001-GeneralizePlatformIdentifiers` | alter `user_messenger_mappings` → `user_platform_mappings`, rename chat-metering tables to generic (`chat_daily_usage`, `chat_idempotency`, `chat_quota_events`) |
| Discord | `1751029200002-CreateDiscordAccountLinksTable` | `discord_account_links` |

### 3. Additional Note in `database.md`

Add a short sentence explaining why old migrations are not renamed (TypeORM tracking constraint by class name) to prevent future agents/developers from spontaneously renaming when "cleaning up".

## Out of Scope

- No new migration package.
- No physical subfolders in `migrations/`.
- No pipeline mechanism changes (still a single app running migrations).
- No re-migration of 18 old files.

## Testing / Verification

This is a documentation + convention change (no runtime code changes), so no tests need to be run. Verify by:
- Re-reading `.claude/rules/database.md` after modification — ensure no contradictions with existing content.
- Confirming the 18-migration classification table matches actual file contents (read the files, do not guess) before writing to the doc.
