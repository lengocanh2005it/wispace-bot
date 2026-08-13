# Zalo Bot MVP — Design Spec

Date: 2026-07-20
Phase: Turborepo migration plan — Phase 4 (`apps/zalo-bot`)
Reference: `docs/turborepo-migration-plan.md`, `apps/discord-bot` (Phase 3, used as the adapter-into-shared-package template).

> **Status note (2026-08-13):** This is a historical design snapshot from 2026-07-20. The current `apps/zalo-bot` implementation has since added `@wispace/chat-metering` quota/rate limiting, the shared `@wispace/chat-agent` queue/history/agent services (with Redis support when enabled), real WISPACE goals/calendar/reschedule handlers, scheduled reports and study reminders, durable webhook ingestion, dead-letter/cleanup recovery, OAuth/ops modules, shared health/metrics wiring, and env-driven LLM failover. The MVP scope and future-work decisions below are preserved as dated design context, not as a complete description of current capabilities.

## 1. MVP Goals & Scope

Implement `apps/zalo-bot` (new NestJS app in the monorepo) with MVP scope:

- Webhook receiving messages from Zalo Official Account (OA), verify signature, reply via shared LLM agent (`@wispace/llm-agent`).
- Account-linking: Zalo Login OAuth (PKCE) ↔ WISPACE `userId`, reusing `WISPACE_API_VERIFY_TOKEN_URL` like Messenger/Discord.
- OA access token lifecycle: automatic token refresh (access_token 1h, refresh_token 30 days, single-use).

**Out of this MVP scope** (technical debt, to be done in a later phase when there is real demand):

- Quota/rate-limit (`packages/chat-metering`) — not applicable to Zalo in MVP.
- Real WISPACE tools (goals/calendar/reschedule) — MVP only stubs `available: false` like Discord in its initial phase.
- ZNS (Zalo Notification Service) for messages outside the 48h window / periodic reports — equivalent to `register_exam_report_notifications`, requires budget + template approval, deferred to a later phase.
- Debounce/merge consecutive messages (`packages/chat-queue-core`) — processes each message immediately, no batching.
- Persistent chat history / multi-pod — uses `@wispace/chat-history` in-memory (like Discord), no Redis.

## 2. Overall Architecture

`apps/zalo-bot` is a NestJS HTTP app (`NestFactory.create`, not `createApplicationContext`, because it needs to expose both webhook and OAuth callback via HTTP). 4 modules, following the 4-layer Clean Architecture convention (`domain/application/infrastructure/presentation`) as per repo conventions:

```
apps/zalo-bot/src/modules/
├── zalo-webhook/    # receive + verify + dispatch webhook events
├── zalo-chat/        # LLM agent adapter + outbound messages
├── zalo-oauth/       # OA token lifecycle + Zalo Login account-linking
└── wispace/          # stub tool handlers (ToolExecutorPort)
```

No cross-importing `MessengerModule`/`DiscordModule` from other apps — everything shared goes through `packages/*` (`@wispace/llm-agent`, `@wispace/chat-history`, `@wispace/wispace-client` with the `x-zaloid` header already supported).

## 3. `modules/zalo-webhook/`

**Responsibility:** receive HTTP POST from Zalo, verify integrity, dispatch by event type.

- `presentation/controllers/zalo-webhook.controller.ts`: `POST /zalo/webhook`.
  - Verify header `X-ZEvent-Signature` = `sha256(appId + rawBody + timestamp + oaSecretKey)` before parsing JSON. Invalid signature → HTTP 401, log warning, no further processing.
  - Read `event_name` for dispatch:
    - `user_send_text` (and other `user_send_*` if needed later) → call `ZaloChatService.handleIncomingMessage(senderId, text)`.
    - `follow` → send welcome message + prompt to link WISPACE account (with `GET /zalo/oauth/authorize` link) via `ZaloOutboundService`.
    - `unfollow` → log only, no further action.
    - `oa_send_*` (echo from the OA itself, including OA Admin) → skip entirely to avoid self-message processing loops.
  - Always return HTTP 200 quickly after receiving (per Zalo's webhook semantics — no special response body).
- `domain/entities/zalo-webhook-event.entity.ts`: plain type for parsed payload (`sender.id`, `user_id_by_app`, `event_name`, `message.text`, `timestamp`, etc.). No ORM decorators.

**Not handled in MVP:** `user_send_image`/`user_send_sticker`/... — log and reply with a default "text messages only" response if received event type is not `user_send_text`.

## 4. `modules/zalo-chat/`

**Responsibility:** chat orchestration via LLM, send reply messages.

- `application/agent/zalo-agent.service.ts`: thin adapter around `LlmAgentService` (`@wispace/llm-agent`), following the `MessengerAgentService`/`DiscordAgentService` pattern:
  - Build system prompt from `apps/zalo-bot/src/shared/prompts/zalo-chat.system.txt` (loaded via `loadSystemPromptFile()`).
  - Implement ports: `LlmExecutionPort`, `LlmUsageRecorderPort` (logs usage but **not** tied to quota — only tracks usage for monitoring, no enforcement in MVP), `LlmSafetyEventPort`, `AgentMetricsPort`, `ToolExecutorPort` (points to `modules/wispace/` stub).
  - Retry transient errors from OpenAI/provider like other apps (`isOpenAiRetryableError`).
- `application/services/zalo-chat-history.service.ts`: uses `MemoryChatHistoryStore` from `@wispace/chat-history` directly (no complex NestJS wrapper, like `DiscordChatHistoryService`), reads TTL/maxMessages from app-specific env vars (`ZALO_CHAT_HISTORY_TTL_MS`, `ZALO_CHAT_HISTORY_MAX_MESSAGES`).
- **Processes each message immediately when webhook receives it** — no debounce/merge (unlike Messenger's `packages/chat-queue-core`).
- `infrastructure/zalo-outbound.service.ts` (`ZaloOutboundService`): implements equivalent `MessageSenderPort`, calls `POST https://openapi.zalo.me/v3.0/oa/message/cs` (header `access_token` obtained via `ZaloTokenService.getValidAccessToken()`).

**Unlinked user handling:** LLM agent still replies to free-form chat (cannot call WISPACE tools since stub returns `available: false`); tool stubs automatically insert account-linking prompt with OAuth link when detecting questions that need WISPACE data — same pattern as Discord.

## 5. `modules/zalo-oauth/`

Two independent sub-flows within the same module, since they share the Zalo app's `secret_key`/`app_id`.

### 5.1 OA Token Lifecycle (server-to-server, no specific user involved)

- **New entity** `zalo_oa_tokens` (migration in `apps/messenger-bot/src/infrastructure/database/` per shared DB conventions, or in `apps/zalo-bot` if the app has its own migrations — specific decision deferred to implementation plan): `id`, `access_token`, `refresh_token`, `access_token_expires_at`, `refresh_token_expires_at`, `updated_at`. Single row only (single OA), no `oa_id` locking needed in MVP since there is only one OA.
- `ZaloTokenService`:
  - `getValidAccessToken(): Promise<string>` — reads the row, returns `access_token` if still valid.
  - Cron (`@Cron`, every 45 minutes, `ZaloTokenRefreshService`): if `access_token_expires_at` has less than 10-minute buffer remaining → call `POST https://oauth.zaloapp.com/v4/access_token` (header `secret_key`, body `grant_type=refresh_token` + current `refresh_token` + `app_id`) → overwrite **both** `access_token` and `refresh_token` with new values (refresh_token is single-use — must save the new pair on every refresh, otherwise you lose the ability to refresh again).
  - If refresh fails (refresh_token expired for more than 30 days, e.g. long downtime) → log critical error (no automatic recovery, requires manual token re-issuance via bootstrap).
- **Initial bootstrap:** obtaining `access_token`/`refresh_token` for the first time is a one-time manual operation (run OAuth code flow via Zalo OA admin, or ad-hoc CLI script), written to the table via migration data or ops script — **not** automated since it only runs once during setup. Document in runbook (`apps/zalo-bot/docs/`).

### 5.2 Account-linking Zalo Login OAuth (PKCE, per specific user)

- **New entity** `zalo_oauth_states`: `state` (PK, random string), `code_verifier`, `created_at`. TTL 10 minutes — checked via `created_at < now() - interval '10 minutes'` condition when querying state at callback (expired rows treated as non-existent, can be periodically cleaned via a separate cron or left harmlessly — specific decision in implementation plan).
- **New entity** `zalo_account_links` (equivalent to `discord_account_links`): `zalo_user_id`, `wispace_user_id`, `linked_at`.
- `presentation/controllers/zalo-oauth.controller.ts`:
  - `GET /zalo/oauth/authorize`: generate `code_verifier` (random string) + `code_challenge` = `base64url(sha256(code_verifier))` (no padding), save `{state, code_verifier}` to `zalo_oauth_states`, redirect user to Zalo Login authorize URL with `code_challenge` + `state`.
  - `GET /zalo/oauth/callback`: receive `code` + `state` → look up `zalo_oauth_states` to get `code_verifier` (error if not found/expired) → `POST https://oauth.zaloapp.com/v4/access_token` (`grant_type=authorization_code`, `code`, `code_verifier`, header `secret_key`) to get user access_token → `GET https://graph.zalo.me/v2.0/me?fields=id,name` to get Zalo user `id` → call `WISPACE_API_VERIFY_TOKEN_URL` (header `X-Internal-Key`, body `{token: state (or self-generated WISPACE token, per the existing 3-bot contract), value: zaloUserId, platform: 'zalo'}`) to get `userId` → upsert `zalo_account_links` → delete used `zalo_oauth_states` row → send welcome message via `ZaloOutboundService`.

**Difference from Discord:** Zalo Login requires PKCE (Discord OAuth2 does not) — this is why a separate `zalo_oauth_states` table is needed instead of directly reusing Discord's OAuth controller pattern.

## 6. `modules/wispace/`

Stub `ZaloAgentToolsService` implementing `ToolExecutorPort` from `@wispace/llm-agent` — all tools in `AGENT_TOOLS` return `{ available: false, message: '<Vietnamese notification prompting account link with OAuth link>' }` when `ctx.userId` is not yet resolved (not linked), identical to `DiscordAgentToolsService` in its initial phase (before `modules/wispace/` was real). When `ctx.userId` is present (linked via `zalo_account_links`) — **still a stub** in this MVP (real tools are for a later phase), but the returned message should differ (e.g. "feature under development" instead of "not yet linked") to distinguish the two states.

## 7. Data Flow Summary

```
User sends message → Zalo → POST /zalo/webhook (verify signature)
  → event_name=user_send_text → ZaloChatService
    → ZaloAccountLinkService.findUserIdByZaloId(senderId) (may be null)
    → LlmAgentService.reply() (ToolExecutorPort = stub, returns available:false if not linked)
    → ZaloOutboundService.send() (uses ZaloTokenService.getValidAccessToken())

User clicks "Link Account" link → GET /zalo/oauth/authorize
  → redirect to Zalo Login → GET /zalo/oauth/callback
  → verify PKCE, exchange code, get zaloUserId, call WISPACE verify-token
  → upsert zalo_account_links → send DM welcome message

Cron (every 45 minutes) → ZaloTokenRefreshService
  → check zalo_oa_tokens.access_token_expires_at
  → if about to expire: refresh, overwrite access_token + refresh_token with new values
```

## 8. Testing

- Unit tests for: `ZaloWebhookController` (verify signature correct/incorrect, dispatch correct per `event_name`, skip `oa_send_*`), `ZaloTokenService`/`ZaloTokenRefreshService` (refresh success, refresh failure when refresh_token expired), `ZaloOauthController` (PKCE flow correct/incorrect state, verify-token called with correct payload), `ZaloAgentToolsService` (2 stub message states), `ZaloChatService` (calls LLM agent, uses chat history with correct TTL).
- No real end-to-end tests at this spec stage (requires real Zalo OA + public HTTPS webhook URL + real `WISPACE_API_VERIFY_TOKEN_URL` response) — deferred like Discord Phase 3.

## 9. Migration / DB

3 new tables (specific names, migration written per the `/typeorm-migration` skill during implementation):
- `zalo_oa_tokens`
- `zalo_oauth_states`
- `zalo_account_links`

No changes to existing tables (shared DB, the `(platform, external_user_id)` key was already generalized in Phase 2 — Zalo only needs `platform='zalo'` when `packages/chat-metering`/`packages/wispace-client` are needed in a later phase).

## 10. New Env Variables

`ZALO_APP_ID`, `ZALO_APP_SECRET_KEY`, `ZALO_OA_SECRET_KEY` (used to verify webhook signature, different from `APP_SECRET_KEY` used for OAuth token), `ZALO_CHAT_HISTORY_TTL_MS`, `ZALO_CHAT_HISTORY_MAX_MESSAGES`, `WISPACE_API_VERIFY_TOKEN_URL` (already exists, shared across 3 bots).

## 11. Historical Future Improvements (Out of the 2026-07-20 MVP Scope)

This list expands item 1 ("out of MVP scope") into a more concrete roadmap — each item should be a separate spec/plan when actually starting work, not bundled into the current MVP to avoid scope creep.

1. **Real WISPACE tools** (`modules/wispace/` from stub → real) — `get_user_goals`, `get_learning_progress_report`, `get_upcoming_study_sessions`, `list_study_calendar_entries`, `preview_next_study_reminder` calling `@wispace/wispace-client` with `idHeader='x-zaloid'` (supported since Phase 3). Implement right after MVP account-linking is stable — this is the highest value for users, top priority in this list.
2. **`reschedule_study_session`** — equivalent to Discord button confirm/cancel; Zalo OA supports list/template-style buttons in messages, requires researching Zalo's "message with button" API (not yet investigated in this spec) before detailed design.
3. **Quota/rate-limit** (`packages/chat-metering`, `platform='zalo'`) — apply when real chat volume increases, reuse `ChatRateLimitCore`/`LlmUsageRecorderCore`/`LlmSafetyCore` like Discord, start with `MemoryBurstCounter` + `DirectUsageWriter` (lightweight version, no BullMQ).
4. **ZNS (Zalo Notification Service)** — **Deferred** (post-product). Zalo 48h window already covers active users; 08:00 report cron works for users who recently interacted. ZNS only needed if users complain about missing reports. Requires template approval + per-message billing — not worth the complexity until real demand.
5. **Pre-exam periodic report cron** (port `ReportCronService` to Zalo) — already done ✓ (08:00 report cron active). Works for users within 48h window; ZNS (item 4) deferred.
6. **Debounce/merge messages** (`packages/chat-queue-core`) — if real users frequently send many consecutive messages (discrete sentences) causing disjointed reply experience, add `DebounceChatQueue` like Messenger.
7. **Persistent chat history / multi-pod** — if scaling to multiple `apps/zalo-bot` instances is needed, replace `MemoryChatHistoryStore` with Redis backend (the `ChatHistoryStoreResolver` pattern already exists in Messenger for reference).
8. **Clean up expired `zalo_oauth_states`** — currently MVP only filters by time condition on query; if the table grows over time (many abandoned authorize flows), add cron to delete rows past TTL, similar to stuck-reserved recovery in `packages/chat-metering`.
9. **Multi-OA support** — MVP assumes only one Official Account (the `zalo_oa_tokens` table has no `oa_id` key). If WISPACE needs to operate multiple OAs (e.g. by center/branch), must add `oa_id` as a key and refactor `ZaloTokenService` from single-row to per-OA lookup.
10. **Whitelist / audit table for quota events** — if item 3 is implemented, consider adding the Messenger-only equivalents (whitelist UX, `chat_quota_events` audit) if Zalo needs equivalent observability — not required, only implement when real operational need arises.
