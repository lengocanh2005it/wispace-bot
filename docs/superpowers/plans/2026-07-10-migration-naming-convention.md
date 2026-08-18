# Migration Naming & Ownership Convention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update `.claude/rules/database.md` to (a) document the naming convention for new TypeORM migrations (Discord/Zalo/shared) going forward, and (b) add an ownership lookup table for the 18 migrations in the historical baseline, without modifying any existing migration files.

> **Historical-plan status (2026-08-13):** This plan records the 2026-07-10 documentation change. The shared migration source is now `packages/database/src/migrations/` (27 files at audit time); `apps/messenger-bot` still owns the only `migration:run` pipeline. The 18-row lookup requested here remains a dated baseline, not a complete current migration inventory.

**Architecture:** This is a documentation-only change (1 `.md` file), no runnable code, no automated tests. "Test" here = re-reading the file to ensure it doesn't contradict existing content and the ownership table matches the actual migration content (verified via `grep` during brainstorming).

**Tech Stack:** Markdown, no build/test step.

## Global Constraints

- Do not rename/modify the historical migration files enumerated in this plan — TypeORM tracks executed migrations by class name in the `migrations` table in the prod DB (`ai_chat_bot_db`); renaming would cause production to re-run old migrations.
- Do not create a new package (`@wispace/migrations` or similar).
- Do not create physical subfolders in `migrations/`.
- Do not change the pipeline mechanism — only `messenger-bot` runs `migration:run` for all bots.
- Target file: `E:\wispace-bot\.claude\rules\database.md` — keep all existing content (lines 1–47) intact, only **add** 2 new sections.

---

### Task 1: Add "New Migration Naming Convention" and ownership table to `database.md`

**Files:**

- Modify: `E:\wispace-bot\.claude\rules\database.md` (insert 2 new sections after the `## Thêm migration` section, before the `## Lưu ý` section, i.e., after line 40, before line 42)

**Interfaces:**

- None — independent documentation change, no code or task dependencies.

- [ ] **Step 1: Insert new content into `database.md`**

Use Edit tool to find the following text (verbatim from current line 40):

```
DB dùng chung giữa các bot (Messenger, Discord nay, Zalo sau) — khóa đã generalize thành `(platform, external_user_id)` ở Phase 2, xem `docs/turborepo-migration-plan.md`. Entity của 4 bảng chat-metering (`chat_daily_usage`, `chat_idempotency`, `llm_usage_events`, `llm_safety_events`) sống trong `packages/chat-metering`, **không** thêm entity trùng trong `apps/*/infrastructure/database/entities/` — chỉ migration (do messenger-bot chạy) mới sửa schema các bảng này.

## Lưu ý
```

Replace with (keep the original text, insert 2 new sections in between):

```
DB dùng chung giữa các bot (Messenger, Discord nay, Zalo sau) — khóa đã generalize thành `(platform, external_user_id)` ở Phase 2, xem `docs/turborepo-migration-plan.md`. Entity của 4 bảng chat-metering (`chat_daily_usage`, `chat_idempotency`, `llm_usage_events`, `llm_safety_events`) sống trong `packages/chat-metering`, **không** thêm entity trùng trong `apps/*/infrastructure/database/entities/` — chỉ migration (do messenger-bot chạy) mới sửa schema các bảng này.

## New Migration Naming Convention (applied from now, non-retroactive)

When adding new migrations (Discord, Zalo, or new shared tables):

- **Single-platform table** → platform prefix in class/file name: `Create<Platform><Feature>Table`, e.g. `CreateZaloAccountLinksTable` (consistent with existing `CreateDiscordAccountLinksTable`).
- **Truly cross-platform table** (entity lives in `packages/*`, following the `chat-metering` pattern) → domain-reflecting name, **no** misleading platform prefix (do not use `CreateMessenger...` for shared tables).
- **Do not rename old migration files** to match this convention — TypeORM stores executed migrations by **class name** in the `migrations` table in the prod DB (`ai_chat_bot_db`); renaming the class = production thinks it's a new migration → re-runs/fails. This convention only applies to new files.

## Ownership of 18 Existing Migrations (static lookup, non-retroactive)

| Group | File | Tables Touched |
|-------|------|----------------|
| Messenger-only | `1717747200000-CreateMessengerTables` | `user_messenger_mappings`, `messenger_message_logs` |
| Messenger-only | `1717747200001-CreateStudyReminderJobs` | `study_reminder_jobs` |
| Messenger-only | `1717747200002-CreateMessengerChatRateLimitTables` | `messenger_chat_daily_usage`, `messenger_chat_idempotency` (predecessor before generic rename) |
| Messenger-only | `1717747200003-CreateMessengerChatSharedQueueTables` | `messenger_chat_queue_buffer`, `messenger_chat_history`, `messenger_chat_webhook_seen` |
| Messenger-only | `1717747200004-CreateMessengerScheduledReportClaims` | `messenger_scheduled_report_claims` |
| Messenger-only | `1717747200005-CreateMessengerWebhookDeadLetterTable` | `messenger_webhook_dead_letters` |
| Messenger-only | `1717747200006-CreateReportSendJobs` | `report_send_jobs` |
| Messenger-only | `1717747200007-AddMessengerIndexes` | index-only, no new table created |
| Messenger-only | `1717747200008-CreateMessengerUsersCacheTable` | `users` (+ view `"Users"`) |
| Messenger-only | `1717747200009-DropMessengerChatWebhookSeenTable` | drop `messenger_chat_webhook_seen` |
| Messenger-only | `1717747200010-DropMessengerChatQueueBufferAndHistoryTables` | drop `messenger_chat_queue_buffer`, `messenger_chat_history` |
| Messenger-only | `1717747200011-TrimUsersCacheToMessengerMappings` | alter `users` (index-only) |
| Messenger-only | `1717747200012-AddUniqueActiveMessengerMappingIndexes` | index-only on `user_messenger_mappings` |
| Shared (`packages/chat-metering`) | `1717747200013-CreateC2QuotaAndLlmUsageTables` | `messenger_chat_events` (predecessor `chat_quota_events`), `llm_usage_events` |
| Shared (`packages/chat-metering`) | `1751029200000-CreateLlmSafetyEventsTable` | `llm_safety_events` |
| Shared (`packages/chat-metering`) | `1751029200003-AddLlmUsageEventsCachedTokens` | alter `llm_usage_events` |
| Cross-platform (generalize) | `1751029200001-GeneralizePlatformIdentifiers` | alter `user_messenger_mappings` → `user_platform_mappings`, rename chat-metering tables to generic (`chat_daily_usage`, `chat_idempotency`, `chat_quota_events`) |
| Discord | `1751029200002-CreateDiscordAccountLinksTable` | `discord_account_links` |

## Lưu ý
```

- [ ] **Step 2: Re-read the entire file to verify no contradictions**

Read `E:\wispace-bot\.claude\rules\database.md` from start to finish. Confirm:

- Content on lines 1–40 and 42–47 (the `## Lưu ý` section) remains exactly as the original.
- The 2 new sections are in the correct position (after `## Thêm migration`, before `## Lưu ý`).
- The historical ownership table has exactly 18 rows; current `packages/database/src/migrations/` contains additional migrations and must not be inferred from this table.
- No misaligned Markdown table columns (each row has exactly 3 columns `| Group | File | Tables Touched |`).

If there are discrepancies, fix them with Edit tool before proceeding to the next step.

- [ ] **Step 3: Verify the migrations folder was not touched**

Run:

```bash
cd "E:/wispace-bot" && git status packages/database/src/migrations/
```

Expected: no output (working tree clean, no files in `migrations/` were changed).

- [ ] **Step 4: Commit**

```bash
cd "E:/wispace-bot" && git add .claude/rules/database.md && git commit -m "$(cat <<'EOF'
docs(database): add migration naming convention + ownership lookup

Lock down naming convention for new migrations (platform-prefixed vs shared)
and add ownership lookup table for 18 existing migrations. Do not rename
old files to avoid breaking TypeORM migration tracking in production.
EOF
)"
```

Expected: commit succeeds, `git status` after shows no uncommitted changes on `database.md`.
