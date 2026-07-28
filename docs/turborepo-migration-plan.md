# Turborepo Migration Plan — Messenger + Discord + Zalo Bots

End goal: 3 bots (Messenger, Discord, Zalo) in one Turborepo monorepo, **independent** CI/CD deploy per bot, sharing one Postgres DB, and sharing **function-calling + OpenAI API calls** via `packages/llm-agent`, **quota/rate-limit + LLM usage/safety tracking** via `packages/chat-metering`, and **Wispace API HTTP client** (goals/scores/calendar) via `packages/wispace-client`. Quota/rate-limit is calculated **separately per bot** (not combined by student) — shared engine, counters split by `platform`.

This document describes the migration phases — which phases are complete and which remain.

---

## Phase 0 — Pre-migration state (completed, reference)

Single NestJS repo, `src/` at root, single app (Messenger bot), one Postgres DB (`ai_chat_bot_db`), user key = `psid` (Facebook PSID) across all chat/quota/mapping entities.

## Phase 1 — Turborepo scaffold + extract `packages/llm-agent` (COMPLETED)

**Goal:** Migrate to monorepo structure, extract LLM orchestration + function-calling schema + safety utils into a framework-agnostic shared package, without changing current Messenger bot behavior.

**Done:**
- `turbo.json` + root `package.json` (`workspaces: ["apps/*", "packages/*"]`).
- Moved all existing code into `apps/messenger-bot/` (package `@wispace/messenger-bot`) — kept DB, entities, migrations, all business modules.
- Created `packages/llm-agent/` (`@wispace/llm-agent`) containing:
  - `LlmAgentService` — OpenAI tool-call loop, generic over `TToolContext`, no NestJS dependency.
  - `AGENT_TOOLS` / `AGENT_TOOL_NAMES` — function-calling schema (renamed from `MESSENGER_AGENT_TOOLS`).
  - Ports (`ports.ts`): `LlmExecutionPort`, `LlmUsageRecorderPort`, `LlmSafetyEventPort`, `AgentMetricsPort`, `ToolExecutorPort<T>` — apps implement these ports with existing NestJS services.
  - Safety utils: `prompt-injection.utils.ts`, `llm-grounding.utils.ts`, `openai-error.utils.ts` (unchanged from `src/shared/utils/`).
  - `scope.utils.ts` (`isObviouslyOffTopic`), `messages.ts` (redirect/injection blocked notifications), `text.utils.ts` (`sanitizeReplyText`) — shared WISPACE domain logic, not platform-specific.
  - `utils/load-system-prompt.ts` — generic `.txt` loader (cached by path); each app still keeps its own prompt file (`apps/messenger-bot/src/shared/prompts/messenger-chat.system.txt` — content references "Facebook Messenger" so it is **not** extracted, kept in app).
- `apps/messenger-bot/src/modules/messenger/application/agent/messenger-agent.service.ts` becomes a **thin adapter**: builds system prompt (base + linkage), implements ports with real NestJS services (`LlmExecutionService`, `LlmUsageRecorderService`, `LlmSafetyEventService`, `MetricsService`), calls `LlmAgentService.reply()`, then assembles `richFollowUps` (tool handlers still accumulate via `toolContext` — the package is unaware of this concept).
- `messenger-agent-tools.service.ts` (tool handlers calling Wispace API, business logic) **remains in the app**, implements `ToolExecutorPort`.
- Updated `Dockerfile`, `.github/workflows/deploy.yml` (path filter + `turbo run ... --filter=@wispace/messenger-bot...`).
- Created empty placeholders `apps/discord-bot/`, `apps/zalo-bot/` (only `package.json` + README pointing to phase 3/4 below).

**Known risks / not yet handled in this phase:**
- `packages/llm-agent` builds with raw `tsc` (not NestJS CLI) — requires `npm install` at root so workspaces resolve before building.
- No real end-to-end testing done (only verified via `turbo run build/lint/typecheck/test`) — see Verification section in original plan.

---

## Phase 2 — Generalize DB key: `psid` → `(platform, external_user_id)` (COMPLETED — migration ran on VPS production)

**Goal:** Allow Discord/Zalo bots to use the same DB without key conflicts with Messenger.

**Done:**
- Migration `1751029200001-GeneralizePlatformIdentifiers.ts` — across 11 tables: added `platform varchar(16) DEFAULT 'messenger'` column, renamed `psid` → `external_user_id`, updated all unique/partial indexes to include `platform`. Renamed 7 tables dropping `messenger_` prefix (now multi-platform): `user_messenger_mappings→user_platform_mappings`, `messenger_chat_daily_usage→chat_daily_usage`, `messenger_chat_idempotency→chat_idempotency`, `messenger_message_logs→message_logs`, `messenger_scheduled_report_claims→scheduled_report_claims`, `messenger_webhook_dead_letters→webhook_dead_letters`, `messenger_chat_events→chat_quota_events`. Kept original names for `study_reminder_jobs`, `report_send_jobs`, `llm_usage_events`, `llm_safety_events`, `users` (already generic enough).
- **No change to public port method signatures** (`MessengerRepositoryPort.findActiveMappingByPsid(psid)` unchanged) — because `apps/messenger-bot` is the only current implementation and always writes `platform='messenger'`. Discord/Zalo (Phase 3/4) will have their own repository implementations, not importing from `apps/messenger-bot`. Only 7 entity files + 10 repository implementation files (persistence layer) changed — application services/controllers/domain types completely unchanged.
- **Quota/rate-limit still calculated separately per bot** (decided earlier) — only need to add `platform` to index/query keys, no cross-platform mapping tables needed.

**Migration ran on VPS production** (via `DB_MIGRATIONS_RUN=true` when container starts, automatically triggered by deploy.yml) — verified via SSH: `\dt` on `ai_chat_bot_db` shows correct 13 tables with new names (`user_platform_mappings`, `chat_daily_usage`, `chat_idempotency`, `message_logs`, `scheduled_report_claims`, `webhook_dead_letters`, `chat_quota_events` + 5 tables keeping old names with added `platform`/`external_user_id` columns), old data backfilled with `platform='messenger'` correctly, `messenger-bot` container boots clean (`Nest application successfully started`, no errors).

**Incidents encountered and fixed during the run (reference for Phase 3/4 if migration changes are needed):**
- `uq_chat_daily_usage_psid_date` was an inline `CONSTRAINT` (created in original `CREATE TABLE`), not a `CREATE UNIQUE INDEX` like other unique keys — `DROP INDEX` threw error `cannot drop index ... because constraint ... requires it`. Had to use `ALTER TABLE ... DROP CONSTRAINT IF EXISTS`. TypeORM migration transaction rolled back cleanly on error, DB was not corrupted midway.
- Pre-existing bug in `.github/scripts/vps-deploy.sh` (`set_env_var`) — `sed -i "s/^${key}=.*/${key}=${value}/"` used `/` as delimiter but the value (`DEPLOY_DIR=/deploy`...) also contained `/`, breaking sed syntax. Changed delimiter to `#`.

**Verification done:** `npx turbo run format:check lint typecheck test build --filter=@wispace/messenger-bot...` passed all (321 tests, no runtime behavior changes — only persistence layer changes) + verified on VPS via SSH.

---

## Phase 3 — Implement `apps/discord-bot` (chat + quota/usage/safety + account-linking + 6/7 tool handlers COMPLETED; register_exam_report_notifications NOT YET DONE)

**Goal:** Real Discord bot using shared `packages/llm-agent` + `packages/chat-metering` + DB (generalized key from Phase 2).

**Stack:** [Necord](https://necord.org/) — NestJS wrapper around `discord.js`, provides decorators (`@Once`, `@On`, `@Context()`...) and module/DI integration following the NestJS style used throughout the repo (instead of writing a raw gateway with bare `discord.js`). `NecordModule.forRootAsync()` registers the Discord client as a normal NestJS module (`@Global`, exposes `Client` from `discord.js` as an injection token).

**Done (MVP):**
- `apps/discord-bot` full NestJS scaffold (package.json, nest-cli.json, tsconfig, eslint sharing root config) — `NestFactory.createApplicationContext` (no HTTP server needed, bot only maintains gateway connection).
- `NecordModule.forRootAsync()` in `AppModule`, token from `DISCORD_BOT_TOKEN` (.env), intents `Guilds` + `DirectMessages` + `MessageContent`, `partials: [Channel]` (required to receive DMs before channel is cached).
- `DiscordChatGateway` (`modules/discord-chat/presentation/gateways/`) — `@Once('ready')` logs bot online, `@On('messageCreate')` is the chat entrypoint (only processes DMs, ignores bots/non-DMs).
- `DiscordOutboundService` — equivalent to `MessageSenderPort`, sends DMs via `client.users.fetch(id).send(text)` (extracted from gateway for reuse in proactive sends later).
- `DiscordAgentService` (`application/agent/`) — thin adapter around `LlmAgentService` from `@wispace/llm-agent`, similar to `MessengerAgentService`: retries transient OpenAI errors (`isOpenAiRetryableError`), usage/safety events persisted via `@wispace/chat-metering` (platform='discord').
- `DiscordAgentToolsService` — **stub**: returns `{ available: false, message: '...' }` for all tools in `AGENT_TOOLS` (no Discord ↔ WISPACE userId account-linking yet, so no real Wispace API calls).
- `DiscordChatHistoryService` — **in-memory only** conversation history (Map in process, lost on restart, no multi-pod) — different from Messenger's `CHAT_HISTORY_STORE` (which has Redis mode).
- Dedicated prompt `apps/discord-bot/src/shared/prompts/discord-chat.system.txt` (not shared with Messenger's file).
- **`packages/chat-metering`** (new framework-agnostic package, second after `llm-agent`) — extracted core quota/rate-limit (`ChatRateLimitCore`, atomic reserve/refund/daily-limit via `chat_daily_usage`/`chat_idempotency`) + LLM usage/safety event recorder (`LlmUsageRecorderCore`, `LlmSafetyCore`) shared by Messenger + Discord, `platform` passed via constructor. `apps/messenger-bot`'s existing repositories (`ChatRateLimitRepository`, `LlmUsageRepository`, `LlmSafetyEventRepository`) refactored into thin wrappers around the package — **no behavior change** (321 → 308 tests because SQL tests moved to 18 dedicated package tests, combined coverage is complete). Boundary details: `.claude/rules/clean-architecture.md`.
- `apps/discord-bot`'s `DiscordChatRateLimitService`/`DiscordLlmUsageRecorderService`/`DiscordLlmSafetyEventService` (`modules/chat-metering/`) — uses `MemoryBurstCounter` + `DirectUsageWriter` (no BullMQ, no quota-event audit table, no whitelist — different from Messenger, see rules). `DiscordChatGateway` reserves before calling agent, refunds on error, completes after sending; denial sends Vietnamese quota/burst message.
- **Account-linking Discord ↔ WISPACE userId via OAuth2 + shared WISPACE verify-token API used by all 3 bots** (`modules/account-link/`) — Discord lacks deep-link with payload like Messenger's `m.me/<page>?ref=`, so uses OAuth2 `identify` scope to get Discord user id, combined with **`WISPACE_API_VERIFY_TOKEN_URL`** (same URL for Messenger/Discord/Zalo, body `{token, value, platform}`) to resolve `userId` — no self-signing/verification needed, no new endpoint required on WISPACE side. WISPACE displays "Connect Discord" link pointing to Discord's authorize URL with `state` = self-generated WISPACE token (as-is, WISPACE manages expiry/one-time use). `apps/discord-bot` now runs as HTTP app (`NestFactory.create` instead of `createApplicationContext`) to expose `GET /discord/oauth/callback`: exchanges `code` for Discord user id (`/oauth2/token` + `/users/@me`) → calls `WISPACE_API_VERIFY_TOKEN_URL` (header `X-Internal-Key`, body `{token, value: discordUserId, platform: 'discord'}`) to get `userId` → upserts `discord_account_links` (new table, migration in `apps/messenger-bot`, only discord-bot reads/writes) → sends welcome DM. `DiscordChatGateway` resolves `userId` via `DiscordAccountLinkService.findUserIdByDiscordId` on every message, passes it into `DiscordAgentToolContext`. WISPACE backend contract details: [apps/discord-bot/docs/discord-account-linking.md](../apps/discord-bot/docs/discord-account-linking.md) (WISPACE only needs to display the link with its existing token, and the verify-token endpoint already exists).
- **`packages/wispace-client`** (new framework-agnostic package, third after `llm-agent`/`chat-metering`) — extracted Wispace HTTP client (`UserGoalsApiClient`, `TaskScoreAverageApiClient`, `UserCalendarApiClient`, `UserCalendarScheduleClient`) + retry/error handling (`withRetry`, `WispaceApiError`) + entire `study-calendar.utils.ts` (date/timezone math) shared by Messenger + Discord. Student identification header generalized to `buildWispaceHeaders(idHeader, externalId, internalKey)` with `idHeader` ∈ `x-psid` | `x-discordid` | `x-zaloid` (WISPACE API already supports all 3 — only send the header matching the platform, no changes needed on WISPACE side). `apps/messenger-bot`'s `UserGoalsApiService`/`TaskScoreAverageApiService`/`UserCalendarApiService`/`UserCalendarScheduleService` refactored into thin wrappers (platform=`x-psid`) — behavior unchanged, all 304 messenger-bot tests verified.
- **6/7 real WISPACE tools for Discord** (`modules/wispace/` — `WispaceGoalsService`, `WispaceCalendarService`, `DiscordStudyCalendarCommandService`) — `get_user_goals`, `get_learning_progress_report` (returns raw goals+scores, main LLM chat self-narrates — no separate port of `StudentReportService`'s LLM call), `get_upcoming_study_sessions`, `list_study_calendar_entries`, `preview_next_study_reminder` now call real Wispace API (`x-discordid`) when `ctx.userId` is resolved; not yet linked returns Vietnamese "not connected" notification.
- **`reschedule_study_session` (COMPLETED)** — Discord counterpart of Messenger postback confirm/cancel: `DiscordAgentToolsService` stages pending via `DiscordRescheduleConfirmationService` (Map keyed by `discordUserId` + TTL 10 minutes, same as Messenger's `MessengerRescheduleConfirmationService`), sends summary DM with 2 Discord button (`ActionRowBuilder`/`ButtonBuilder`, style Success/Danger) via `DiscordOutboundService.sendRescheduleConfirmation`. Button handling uses Necord `@Button(customId)` decorator in `DiscordChatGateway` (`onRescheduleConfirm`/`onRescheduleCancel`), routed by `interaction.user.id` — simpler than Messenger since no payload encoding into customId needed. Writes real calendar via `DiscordStudyCalendarCommandService.rescheduleSession` (delete + create calendar, reusing `resolveRescheduleSlot`/`resolveScheduledAtFromEventDate` from `@wispace/wispace-client` + `formatScheduledTimeLabel`/`getMinutesUntilSession` from `@wispace/study-reminder-core`) — no outbox sync after reschedule (Discord does not yet have its own job reminder system).
- **Still a stub: `register_exam_report_notifications`** — this tool exists in Messenger to work around Meta's 24h messaging limit (must opt-in to "Notification Messages"). Discord has no 24h limit, so registration is unnecessary. The 08:00 report cron (`DiscordReportCronService`) is fully implemented and sends to all linked accounts automatically.
- Unit tests for `DiscordChatHistoryService`, `DiscordAgentToolsService` (including linked/not-linked cases for all tools + valid/error reschedule cases), `DiscordOutboundService` (including button confirmation DMs), `WispaceDiscordTokenVerifyService`, `DiscordAccountLinkService`, `DiscordOauthController`, and `packages/wispace-client` (`UserGoalsApiClient`, `user-calendar-record.normalizer`, `buildWispaceHeaders`).

**Remaining / technical debt:**
- **CI/CD VPS deploy** — `deploy-discord-bot.yml`, `Dockerfile`, `docker-compose.prod.yml`, all 3 deploy shell scripts committed. Not yet run on VPS.
- **End-to-end testing not done** — needs real Discord Application OAuth2 client + public HTTPS redirect URI + WISPACE backend displaying "Connect Discord" link.
- Persistent / multi-pod chat history (Redis) + chat queue (debounce) if scaling to multiple instances.
- `apps/messenger-bot`'s local `study-reminder/application/utils/study-calendar.utils.ts` duplicates `packages/wispace-client` — not yet deduplicated.

**Verification done:** `npx turbo run format:check lint typecheck test build --filter=@wispace/messenger-bot... --filter=@wispace/discord-bot... --filter=@wispace/chat-metering... --filter=@wispace/wispace-client...` passed all (messenger-bot 304 tests + chat-metering 18 tests + wispace-client 10 tests + discord-bot 26 tests). Not yet tested with real Discord server (needs real `DISCORD_BOT_TOKEN` + `MESSAGE CONTENT INTENT` enabled in Developer Portal), not yet tested with real DB connection (`DB_*` env) or real Wispace API (`WISPACE_API_*_URL` + `x-discordid`) for Discord, and not yet tested with real OAuth flow (needs public redirect URI + WISPACE backend displaying "Connect Discord" link).

---

## Phase 4 — Implement `apps/zalo-bot` (FUNCTIONAL — see gaps below)

Zalo bot has chat + quota/usage/safety + account-linking OAuth2 + 6/7 real WISPACE tool handlers via `@wispace/wispace-client` (same as Discord), 08:00 report cron (raw format, no LLM enrichment), study reminders infrastructure (sync/dispatch/worker via shared packages), PostgreSQL-backed dead letter + delivery log + cleanup crons, and stuck idempotency recovery.

**Implemented:**
- Chat via Zalo webhook (`POST /zalo/webhook`), rate limit reserve/refund/markCompleted via `@wispace/chat-metering`
- Account linking via PKCE OAuth2 flow + `WISPACE_API_VERIFY_TOKEN_URL`
- 6/7 tool handlers calling real Wispace API (`x-zaloid`): `get_user_goals`, `get_learning_progress_report`, `get_upcoming_study_sessions`, `list_study_calendar_entries`, `preview_next_study_reminder`, `reschedule_study_session` (with Zalo-specific confirm/cancel via structured messages)
- `register_exam_report_notifications` — stub (same as Discord; Zalo has no 24h messaging limit)
- 08:00 report cron (`ZaloReportCronService`) — fetches goals + scores via Wispace API, uses `ScheduledReportClaimEntity` for cross-platform dedup, concurrency 3
- Study reminder: `StudyReminderWorkerService` with `platform='zalo'`, sync/dispatch/worker via shared `@wispace/study-reminder-shared`
- LLM provider failover (OpenAI → OpenRouter → MiniMax) via `@wispace/llm-agent`
- Redis user display name cache (same as Messenger/Discord)
- PostgreSQL dead letter (`WebhookDeadLetterEntity`, `ZaloDeadLetterCronService` 5-min retry)
- `ZaloMessageLogEntity` delivery logging + cleanup cron (daily 03:00)
- Idempotency stuck recovery cron (30 min) + cleanup cron (weekly)
- OAuth state cleanup cron (every 10s)
- Rate limit H2/H4/H6 hardening (stuck recovery, refund on error, idempotency cleanup)
- Multi-pod advisory locks for all cleanup crons

**Still missing vs Discord/Messenger:**
- **Chat queue** (debounce/merge) — Zalo handles each message immediately, no `CHAT_QUEUE_STORE` config
- **LLM report enrichment** — report cron uses `ZaloStudentReportService` (LLM); `get_learning_progress_report` tool still returns raw API data
- **Webhook dedupe** — in-memory only (no Redis option)
- **Chat history** — supports `CHAT_HISTORY_STORE=memory|redis` via `@wispace/chat-history` core
- **No health/redis endpoint** (`GET /health/redis`)
- **No Doppler webhook endpoint** (`POST /zalo/ops/doppler-sync`)

**Recently added (commits 9b9ff9a, 66352b7, ad8a196):**
- Study reminder sync fixed: `getSessions` callback wired via `ZaloWispaceCalendarService`
- Ops HTTP endpoints (`POST /zalo/send-reports`, `/zalo/study-calendar/sync`, `/zalo/sync-study-reminders`) with `InternalApiKeyGuard`
- CI/CD: `deploy-zalo-bot.yml` workflow + `vps-deploy-zalo.sh` + Dockerfile updated
- LLM report enrichment: `ZaloStudentReportService` using `@wispace/student-report` `StudentReportCore`
- Ops health: real queries on `chat_idempotency`, `chat_daily_usage`, `study_reminder_jobs`, `llm_safety_events`
- Burst counter: `PostgresBurstCounter` (was `MemoryBurstCounter`)
- Chat history: `CHAT_HISTORY_STORE=redis` support with fallback to memory

---

## Phase 5 — Fully independent CI/CD per bot (NOT YET DONE)

**Goal:** Each bot has its own build/test/deploy pipeline, independent of each other.

**Tasks:**
- 3 separate workflows: `deploy-messenger-bot.yml`, `deploy-discord-bot.yml`, `deploy-zalo-bot.yml` — each with path-filter on `apps/<bot>/**` + `packages/llm-agent/**` (changing `packages/llm-agent` must trigger rebuild+redeploy of all 3 bots, or use Turborepo remote caching to only rebuild bots that actually need it).
- **DB migration convention:** Only one pipeline (Messenger bot, since it has been running in production longest) is allowed to run `migration:run`; other bots only read schema, do not run migrations — prevents race conditions when 3 CI pipelines run in parallel on the same DB.
- Separate secrets/env per bot via Doppler (Discord bot token, Zalo OA token...).
- Separate Docker image + deploy target per bot on VPS (or separate hosts if independent scaling is needed).

**Verification:** Trigger independent deploy per bot (only modify 1 app, confirm only the corresponding pipeline runs — unless `packages/llm-agent` is modified, in which case all 3 rebuild).

---

## Summary by status

| Phase | Content | Status |
|-------|---------|--------|
| 0 | Initial state before migration | Reference |
| 1 | Turborepo scaffold + extract `packages/llm-agent` + discord/zalo placeholders | ✅ Completed |
| 2 | Generalize DB key `(platform, external_user_id)` | ✅ Completed — migration ran on VPS production, verified via SSH |
| 3 | Implement Discord bot | ✅ Features complete (chat + quota + account-linking OAuth2 + 6/7 real tools + reschedule + 08:00 report cron + leader-election + retry dispatch + study reminders + dead letter + message log + CI/CD workflow + deploy scripts) — no real end-to-end testing yet |
| 4 | Implement Zalo bot | 🟡 Functional (chat + quota + account-linking + 6/7 tools + 08:00 report cron + LLM report enrichment + study reminders + dead letter + stuck recovery + ops endpoints + CI/CD + real ops health + Postgres burst counter + Redis chat history) — missing: chat queue, Doppler webhook, health/redis endpoint |
| 5 | Fully independent CI/CD | 🟡 Discord + Zalo workflows committed (`deploy-discord-bot.yml`, `deploy-zalo-bot.yml`) — Messenger workflow not yet separated |
