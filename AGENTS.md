# AGENTS.md

Instructions for AI coding agents working in the **wispace-bots** repo — Turborepo monorepo for WISPACE student bots (AI reports + study reminders + rate-limited AI chat). Currently includes `apps/messenger-bot` (fully functional), `apps/discord-bot` (fully functional: chat + quota/usage/safety + account-linking OAuth2 + 7/7 real tool handlers + 08:00 report cron + leader-election + retry dispatch + study reminders + dead letter + message log cleanup + CI/CD workflow), `apps/zalo-bot` (fully functional: chat + quota + account-linking OAuth2 + 7/7 real tool handlers + LLM report enrichment + 08:00 report cron + study reminders + dead letter + message log + stuck recovery + ops endpoints + CI/CD + shared health endpoints + Redis queue/history options + chat queue; production env sync uses the manual workflow and the legacy Doppler webhook is disabled), and 18 shared packages in `packages/`: `llm-agent` (LLM function-calling + provider abstraction), `chat-metering` (quota/rate-limit + LLM usage/safety event tracking), `chat-agent` (platform-parameterized agent/tools/queue/history services for Discord & Zalo), `wispace-client` (Wispace API HTTP client for goals/scores/calendar), `chat-history` (memory + Redis chat history stores with TTL + turn cap), `student-report` (student capability report generation), `chat-queue-core` (per-user debounce/merge state machine), `chat-pipeline` (platform-agnostic chat pipeline: rate-limit → history → agent → outbound), `learner-profile` (compact per-learner facts — band target, exam date — sourced only from server-derived tool results, injected into chat prompts with 24h freshness rules; `get_user_goals` is the v1 facts source), `study-reminder-shared` (study reminder schedule + dispatch/sync/worker services), `scheduler-core` (report cron scheduling + leader election), `bot-metrics` (Prometheus metrics), `cleanup-cron` (advisory-lock cleanup cron), `ops-health` (ops health snapshot + alerts), `reschedule-confirm` (generic reschedule confirmation service), `bot-common` (shared NestJS infrastructure: ops API guard, advisory locks), `database` (shared DB entities + migrations), `doppler-sync` (Doppler runtime secret sync helpers), `date-utils` (timezone-aware date helpers).LM).

Read this file before modifying code. In-depth details are in `docs/` — only read when relevant to the task. Full monorepo roadmap (Discord/Zalo, cross-platform DB, independent CI/CD): [docs/turborepo-migration-plan.md](docs/turborepo-migration-plan.md).

**Path note:** most of the content below (modules, `npm run ...` commands, `src/...` paths) describes `apps/messenger-bot/` — run those commands **inside `apps/messenger-bot/`**, or use `npx turbo run <script> --filter=@wispace/messenger-bot...` from root.

---

## Project overview

Deploy hardening updates for #271/#284 must keep `vps-deploy.sh` fail-closed on image-pull failure, missing validated migration command, failed/empty pre-migration dump, and unsafe `SKIP_NGINX_CHECK=true` use with an active container. Migration deploys must also verify the release image has no pending migrations before cutover (#275); self-pull deploys Messenger first and gate Discord/Zalo on that migration barrier (#283). Update both deploy regression scripts when changing this flow.

|                |                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Stack**      | NestJS 11, TypeScript, TypeORM, PostgreSQL, LLM Provider Abstraction (adapter pattern)                                               |
| **Goal**       | Link IELTS students `m.me` ↔ WISPACE, deliver progress reports and study session reminders via Messenger                             |
| **Scope**      | Small backend service — **not** full-stack, **not** a standalone microservice                                                        |
| **DB**         | PostgreSQL **`ai_chat_bot_db`** (dedicated database); Wispace data via **HTTP API**; user name cache: `users` table + `"Users"` view |
| **Principles** | Small diffs, reuse existing modules, config via `.env`; Redis optional (R0–R4) for scale / VPS                                       |

---

## Dev environment tips

- Copy `.env.example` → `.env` and fill in real tokens before running sync/cron — or use [Doppler](apps/messenger-bot/docs/doppler-secrets.md): `doppler setup` + `npm run start:dev:doppler`.
- **Prod DB:** `DB_NAME=ai_chat_bot_db` (no longer `writing_ai_hub_db`).
- **DB TLS is enforced independent of `NODE_ENV`** (`packages/database/src/typeorm-options.ts`): startup + migration fail when `DB_SSL != true` for any host that is not localhost/a private IPv4. Non-IP hostnames (e.g. Docker-internal `postgres`) need `DB_ALLOW_INSECURE_HOSTS=postgres,db.internal` — the only plaintext exception. TLS always verifies the peer; supply the CA via `DB_SSL_CA`. CI test job uses `DB_ALLOW_INSECURE_HOSTS=postgres`.
- **PgBouncer (production, optional):** `deploy/docker-compose.pgbouncer.yml` uses the pinned `edoburu/pgbouncer` image and generates auth files from `PGBOUNCER_DB_USER`/`PGBOUNCER_DB_PASSWORD`; it joins both `app_n8n_db_network` and `monitoring`. Bots use `DB_HOST=pgbouncer`, `DB_PORT=5432`, and `DB_ALLOW_INSECURE_HOSTS=pgbouncer`; `vps-deploy.sh` attaches bot containers to `app_n8n_db_network` as well as `monitoring`. Keep `pool_mode=session` because advisory locks require one backend connection per client session; do not add unsupported `auth_password` to `pgbouncer.ini`.
- **WISPACE upstream URLs fail closed** (`packages/wispace-client/src/utils/upstream-url.utils.ts`): HTTPS required (dev-only `http://localhost` when `NODE_ENV != production`), credentials/fragments rejected, private targets rejected in production, optional `WISPACE_ALLOWED_HOSTS` allowlist. Applied to every WISPACE client config + verify-token URL at startup — do not bypass with a raw URL.
- **Zalo OA tokens are encrypted at rest** (AES-256-GCM, per-row IV, `v1.<iv>.<tag>.<cipher>` in `zalo_oa_tokens`): `ZALO_TOKEN_ENCRYPTION_KEY` (32-byte base64, Doppler) is required; legacy plaintext rows fail closed — re-bootstrap via `apps/zalo-bot/docs/zalo-oa-token-bootstrap.md`. Zalo refresh is serialized (transaction + `FOR UPDATE`, re-read after lock) — single-use refresh tokens are never submitted twice.
- **Zalo linking is recoverable** (#147, mirror of Discord #137): `ZaloLinkCompletionService` verifies the WISPACE token, persists a durable verify intent (`zalo_link_verify_records`, migration `1786890667352`) BEFORE the local `upsertLink` (retried — the single-use token is already consumed), consumes the intent fire-and-forget, and sends the welcome only after the mapping is committed. Cron `zalo-link-reconcile` (5 min, advisory lock `884_200_937`, env `ZALO_LINK_RECONCILE_AGE_MS`/`ZALO_LINK_RECONCILE_MAX_AGE_MS`) re-commits pending intents idempotently.
- **Discord linking commits at OAuth callback, independent of guild membership**: toàn bộ flow nằm trong `DiscordLinkCompletionService` (application — controller chỉ redirect, clean-arch): verify token → persist verify-intent (`discord_link_verify_records`, durable outbox #137) → `upsertLink` (retry — token đã bị WISPACE consume) → consume intent (fire-and-forget) → relink notice → đã trong guild? `DiscordWelcomeService.welcomeIfDue` (dedupe qua `discord_welcome_records` + `DISCORD_REWELCOME_WINDOW_MS`, default 24h) : redirect thẳng `DISCORD_INVITE_URL` (FE không có trang callback, không đọc param nào). `guildMemberAdd` gửi welcome qua cùng `welcomeIfDue` cho user đã link; user chưa link nhận DM chào organic qua `sendOrganicWelcomeIfDue` (cùng dedupe state, #231) **trừ khi** có pending verify intent tươi (`DISCORD_LINK_PENDING_ORGANIC_SKIP_MS`, default 120s — callback đang chạy sẽ welcome). Crash giữa verify và upsert được reconcile bởi cron `discord-link-reconcile` (5 phút, advisory lock `DISCORD_LINK_RECONCILE` 884_200_934; `DISCORD_LINK_RECONCILE_AGE_MS`/`DISCORD_LINK_RECONCILE_MAX_AGE_MS`) — sau khi re-commit, nếu user đã trong guild thì `welcomeIfDue` (không mất welcome ở crash case). **Welcome dedupe (#231/#232/#233/#159)**: một bảng `discord_welcome_records` (PK `discord_user_id`, `last_welcomed_at`, `source` organic|linked, `claim_expires_at`) là dedupe state duy nhất cho cả 2 path — organic join rồi link trong window → chỉ 1 DM; `sendMenuButtons` trả `boolean` và welcome chỉ `markWelcomed` khi send thành công (fail → không mark, event sau retry); `tryClaimWelcome` là **claim atomic** (1 conditional upsert: win khi chưa từng welcome / quá window / claim cũ hết hạn) — OAuth callback vs `guildMemberAdd` chạy đồng thời chỉ 1 bên thắng claim và gửi (#159), lease `DISCORD_WELCOME_CLAIM_MS` (default 60s) làm van an toàn cho sender crash/fail; `DISCORD_GUILD_ID` unset → `isMember` fail-closed trả `false` (callback defer welcome cho `guildMemberAdd`). `onGuildMemberAdd` bao try/catch (nested cho channel welcome) + summary log luôn chạy (#234); counter `discord_welcome_attempts_total{outcome=success|error|skipped}`. Relink (cùng Discord ID sang WISPACE user khác) → `DiscordRelinkNotifier` DM thông báo + warn log (user cũ bị thay mapping — by design). DM bị chặn (privacy) → counter `discord_dm_delivery_failures_total{reason}` (Prometheus). Redirect luôn kèm `Referrer-Policy: no-referrer`; landing là `DISCORD_LINK_LANDING_URL`. Portal UI phân biệt "linked + chưa join" qua `GET /v1/discord/link-status?userId=` (guard `X-Internal-Api-Key`, trả `{linked, inGuild}` — xem `DiscordLinkStatusController`).
- **CI secret scanning:** Gitleaks runs on push + PR (failing policy). Exposed-local-`.env` recovery procedure: `docs/project-overview.md` §13.
- Meta webhook needs a public URL (ngrok/tunnel) pointing to `POST /v1/webhook`.
- After first deploy: call `POST /v1/messenger/profile/setup` (header `X-Internal-Api-Key`) — prod menu only has **Register Report** (bot sends reports/reminders automatically).
- **VPS self-pull deploy** (#144/#172/#275/#283/#278): `.github/scripts/vps-self-pull-deploy.sh` runs `git fetch`/`reset` **inside** the deploy lock (cron line is just `bash .github/scripts/vps-self-pull-deploy.sh` — fetch/reset must NOT move back into the crontab line). Fetch/reset/stale-checkout failures fail closed: timestamped `ERROR` in `~/vps-self-pull-deploy.log`, stall marker in `~/.vps-deploy-state/stall`, and a Telegram alert via the local Alertmanager (`vps_self_pull_stall`, default route) — resolved alert posted on the next healthy tick. **Per-app deploy failures** (#202) alert once per `(app, sha)` via `~/.vps-deploy-state/<app>.failed` (`vps_self_pull_app_failed`), cleared+resolved on a later success. **Deploy hardening** (#199/#201/#203/#204/#275/#278): `vps-deploy.sh` fails closed on missing `.env` / migration DB / upstream conf (`SKIP_NGINX_CHECK=true` = first-deploy escape); the release image's `migration:show` must report an applied migration set with no pending entries before nginx cutover; live container detected by nginx-routed port (interrupted blue-green adopts `${APP}-new` as `-old`, never deletes it); `DOCKER_STOP_TIMEOUT` (60s) covers the 45s drain; migration advisory lock held on the **same psql session** as the migration (`\!` + `/tmp/mig.exit` marker, image ships `postgresql-client`); post-switch monitor verifies the public nginx route (`/health[/discord|/zalo]/ready` via `curl --resolve`); uploads exclude `.env` from `rsync --delete`; env files `mktemp`+`chmod 600`+EXIT trap; `postgres-backup.sh` umask 077 + 700/600. **Metrics recovery (#278):** bare blue-green containers join the external `monitoring` network, Prometheus uses stable `<app>-metrics` aliases on fixed internal ports, and deploy verifies protected `/metrics` before/after alias handoff with rollback on failure. **Migration barrier** (#283): self-pull deploys Messenger first; Discord/Zalo are skipped until Messenger's migration-owner deploy succeeds or is already at the target SHA. **Supply chain** (#193/#196): Turbo secrets (`TURBO_TOKEN`/`TURBO_TEAM`) are scoped to the `Verify` step only (not exposed during `npm ci`); deploy scripts pin images by immutable digest extracted from `docker manifest inspect` — `docker pull/run` use `@sha256:<digest>` when available, fail closed if digest can't be verified. Recovery + setup: `docs/project-overview.md` §12. Script behavior is regression-tested by `.github/scripts/tests/vps-self-pull-deploy.test.sh` + `.github/scripts/tests/vps-deploy.test.sh` (CI job `deploy-scripts-test`) — update them when touching the scripts.
- Editing files in `apps/*/src/shared/prompts/*.system.txt` → **requires** `npm run build` (Nest copies assets to `dist/shared/prompts/`). The free-form **chat** prompt is composed of a shared core (`packages/llm-agent/src/chat-system-prompt.ts`, `CHAT_SYSTEM_PROMPT_CORE` — universal rules, TS module because packages do not ship `.txt` assets) + a per-bot overlay (`*-chat.system.txt` — platform-specific rules only) in `PlatformAgentService.buildSystemPrompt` (`packages/chat-agent`). Edit the core for universal rules (once), the overlay for platform behavior — never duplicate core rules into overlays.
- **Adding a new tool** (#206 convention, full doc: `.claude/rules/prompts.md`): the tool schema in `packages/llm-agent/src/agent.tools.ts` (name + `description` + parameters) is injected into every LLM request — it is the **primary guidance surface**. Checklist: (1) put "when to use / when not to use" (trigger phrases, exclusions) in the schema `description` — simple tools need **no prompt edit**; (2) touch `CHAT_SYSTEM_PROMPT_CORE` only for cross-cutting rules (result phrasing, cross-tool coordination, general no-tool rules); (3) platform-specific tool behavior → the platform overlay; (4) a new core rule must be reflected in `chat-system-prompt.spec.ts` section guards + the eval fixtures' core hash must be re-validated.
- Study reminder: `STUDY_REMINDER_*` variables are **required** — use `readRequiredPositiveNumber`, do not hardcode fallbacks in code.
- Wispace API auth: platform identity header **`x-psid`** (Messenger), **`x-discordid`** (Discord), or **`x-zaloid`** (Zalo) + **`X-Internal-Key`** (`WISPACE_INTERNAL_KEY`); mapping linkage **requires** token verification via **`POST WISPACE_API_VERIFY_TOKEN_URL`** (shared across 3 bots, body `{token, value, platform}`; `MESSENGER_LINK_MODE=token`; startup fails if config is missing).
- Next roadmap exercise chat tool: `POST WISPACE_API_PRECREATE_EXERCISE_URL` with an empty body, timeout `WISPACE_API_PRECREATE_EXERCISE_TIMEOUT_MS=30000`, no automatic retry, and `X-Internal-Key`; identity header is `x-psid` (Messenger), `x-discordid` (Discord), or `x-zaloid` (Zalo). It requires a linked account and creates only the next roadmap exercise. **Intent gate (#163)**: the create endpoint is only called when the learner's own message (`PlatformAgentToolContext.userText`, injected by the agent loop) passes `checkPrecreateIntent` — explicit request phrases, no injection patterns, no selection words (taskType/exerciseTopic/topic/difficulty); anything else returns `intent_unclear` and the model re-asks.
- Ops HTTP (`/messenger/study-calendar/sync`, `send-reports`, …) require header **`X-Internal-Api-Key`** or `Authorization: Bearer …` matching `INTERNAL_API_KEY`.
- Internal cron (30-minute sync, adaptive S2 dispatch) runs in-process — no API key required.
- Debug study reminder jobs: `npm run study-reminder:jobs` (`--failed`, `--stuck`, `--summary`).
- Query chat quota: `npm run chat-quota:status` (`--psid`, `--user-id`, `--date`, `--ops`); rebuild counter: `chat-quota:rebuild` (`--dry-run`).
- Query LLM tokens: `npm run llm-usage:status` (`--psid`, `--feature`, `--ops`); HTTP ops `GET /v1/messenger/ops/llm-usage/summary` (`psid` \| `userId`, `from`, `to`) and `GET /v1/messenger/ops/llm-usage/fleet` (`date`); USD: `LLM_COST_USD_PER_1M_*_GPT_5_4` = `2.50` / `15.00` (OpenAI Standard gpt-5.4); persisted via fire-and-forget inline insert (BullMQ queue removed — add when throughput justifies).
- Cap concurrent LLM calls: `LLM_EXECUTION_ENABLED=true`, `LLM_MAX_CONCURRENT` (default `3`) — **one contract for all 3 bots and all features** (chat, reports, reminders). Messenger chat/reports/reminders go through `LlmExecutionService` (`LlmExecutionModule`); Discord/Zalo chat + reports use the shared env port `createEnvLlmExecutionPort` (`packages/llm-agent`) with the same `LLM_EXECUTION_*` keys. Quick disable: `LLM_EXECUTION_ENABLED=false`. Multi-pod aggregate budget: `LLM_GLOBAL_CONCURRENCY_ENABLED=true` + Redis → one shared `llm:concurrency:global` slot across pods/bots.
- AbortSignal propagation: LLM + WISPACE calls accept an `AbortSignal` — timeouts/cancellation abort the underlying request (`isAbortError`/`sleep` shared in `packages/bot-common/src/abort.utils.ts`; WISPACE per-attempt `mergeWithTimeout`, circuit timeout = total budget `computeCircuitBreakerTimeout`). `LlmExecutionService` / `createEnvLlmExecutionPort` pass the caller signal **composed with the per-request deadline into the provider request itself** — a deadline aborts the in-flight HTTP call, not just the wrapper promise; study reminders carry the deadline too; chat callers can cancel end-to-end via `PlatformAgentInput.signal`. Abort/deadline errors are never retried. Details: `docs/project-overview.md` §7.1.
- LLM safety: free-form chat blocks prompt injection before calling LLM, sanitizes history/tool results; external data for reminders/reports must go through `prompt-injection.utils` / validate JSON output (`llm-json-output.utils`) before formatting/sending. **Safety telemetry never stores raw text** — `LlmSafetyCore.recordGroundingWarning` persists sanitized excerpt (control chars stripped, credential patterns → `[REDACTED]`) + SHA-256 hash + length only. **Reminder time** always renders the server-derived `scheduledTimeLabel` (model value ignored, mismatch logged). **Student-report facts** (streak, task statuses, dates, counts, bands) are generated deterministically from source data — the LLM only writes prose.
- Ops health I1+S1: `npm run ops:health` (cron 09:00 ICT in-app when `OPS_HEALTH_ALERT_ENABLED=true`).
- Production env sync: use the manual `sync-env.yml` workflow; the in-container Doppler webhook is disabled because bot containers do not receive the host Docker socket.
- Audit log cleanup: cron `messenger-message-log-cleanup` — 03:00 ICT every Monday; `MESSENGER_MESSAGE_LOG_RETENTION_DAYS=90` (disable: `MESSENGER_MESSAGE_LOG_CLEANUP_ENABLED=false`).
- Health endpoints (shared `HealthController` in `packages/bot-common`, same semantics on all 3 bots): `GET /health` = **public liveness** (generic `{status:"ok"}`, never leaks dependency details); `GET /health/ready` = **public readiness** (200 only when DB + configured Redis reachable; 503 body is status-only); `GET /health/detail` = **internal** (`X-Internal-Api-Key`) full DB/Redis detail. Deploy gates and `vps-self-pull-deploy.sh` use `/health/ready`; Nginx rate-limits public readiness probes.
- Redis R0: `REDIS_ENABLED=true` + `REDIS_*` → startup logs PING; non-local Redis requires TLS, or explicit `REDIS_PRIVATE_NETWORK=true` on a private Docker/VPC network; readiness via `GET /health/ready` (503 when enabled but unreachable).
- Redis R5: `USER_DISPLAY_NAME_CACHE_*` — caches `cache:user:display:{userId}` before querying `users` table / `"Users"` view.
- Chat history R1: `CHAT_HISTORY_STORE=redis` (requires `REDIS_ENABLED=true`) \| `memory` (postgres table removed). **Fail-closed**: nếu redis được cấu hình mà client unavailable lúc startup → cả 3 bot throw (không còn silent fallback về memory; runtime blip sau khi boot OK vẫn fallback nhưng log ERROR mỗi lần). Redis appends are **atomic per user** (#148): `RedisChatHistoryStore` writes via one Lua script (`eval` — read + append + trim + `SET EX` sliding TTL in a single server-side step), so concurrent requests for the same user can never lose a turn. Memory backend is bounded: a 60s sweep timer enforces TTL expiry + global user cap (`CHAT_HISTORY_MAX_USERS` / `ZALO_CHAT_HISTORY_MAX_USERS`, default 10_000, oldest-updated evicted) + pending tool-summary TTL/cap (10/user); reads/writes never scan the full map (#132).
- **Webhook ingestion is durable** (R2): every authenticated Messenger/Zalo event is persisted to `webhook_inbound_events` **before** the endpoint acks (200); downstream handlers run from the advisory-locked retry cron. Duplicate deliveries are idempotent via unique `(platform, event_id)` (Messenger mid / Zalo msg_id; postbacks/follows use `{type}:{userId}:{ts}`) — replaces the removed `CHAT_DEDUPE_STORE` memory/redis stores. Handler failures → `failed` + bounded backoff; retry cron every 30s (advisory-locked: `MESSENGER_WEBHOOK_INBOUND_RETRY` 884_200_905 / `ZALO_WEBHOOK_INBOUND_RETRY` 884_200_932) claims then replays `pending`/`failed` rows **with bounded parallelism** (`WEBHOOK_INBOUND_RETRY_CONCURRENCY`, default 5) → `abandoned` (terminal) after `WEBHOOK_INBOUND_MAX_RETRIES`; per-tick stats hook feeds the `messenger_webhook_inbound_backlog` gauge. Claims assign a **`lease_token`** and `markCompleted`/`markFailed`/`markProcessingAbandoned` require it (migration `1786869155627`) — a stale worker whose lease was recovered no-ops instead of overwriting the terminal state (#149). A stale `processing` lease is terminalized, not replayed, because its side effects may already have completed (indexed by `(platform, status, updated_at)`, migration `1751029200017`). Persistence failure → non-2xx → platform redelivers.
- **Raw-payload retention** (R2): cron `webhook-inbound-cleanup` — 03:15 ICT daily, advisory-locked (`MESSENGER_WEBHOOK_INBOUND_CLEANUP` 884_200_910 / `ZALO_WEBHOOK_INBOUND_CLEANUP` 884_200_933) — deletes terminal (`completed`/`abandoned`) `webhook_inbound_events` rows older than `WEBHOOK_INBOUND_RETENTION_DAYS=30` (disable: `WEBHOOK_INBOUND_CLEANUP_ENABLED=false`); non-terminal rows are never deleted (retry/recovery intact).
- **Learner profile** (#207 item 3): `@wispace/learner-profile` persists compact per-learner facts (band target `target_score`, exam date `exam_date`) in the shared `learner_profiles` table — written ONLY from server-derived tool results (`get_user_goals` is the v1 source; `extractFactsFromToolResult` whitelists fields + validates types, never guesses). Wired via `PlatformAgentOptions.onToolResult` (fire-and-forget recorder, built by `createLearnerProfileRecorder`) + `systemPromptSuffix` (`createLearnerProfileSuffix`, TTL `DEFAULT_LEARNER_PROFILE_TTL_MS`=24h — stale facts are omitted, never injected). Messenger composes it with its display-name suffix; Discord/Zalo inject it as their suffix. All 3 bots register `LEARNER_PROFILE_STORE` (TypeORM store over `LearnerProfileEntity`).
- **Pinned facts** (#207 item 6): `pinFactsToReply` in `packages/chat-agent/src/agent/pinned-facts.ts` deterministically appends server-derived facts to the final reply when the model omits them — tools push `PlatformAgentToolContext.pinnedFacts` (e.g. the precreate-exercise URL via `buildExerciseUrlFact`); replaces the old per-feature `ensurePrecreatedExerciseUrl`.
- **Log redaction** (consistent masking): never log raw external IDs (Messenger PSID, Discord ID, Zalo ID, WISPACE userId) — use `maskExternalId(id)` from `@wispace/bot-common` (first 4 + `…` + last 4; `???` for missing) in every log line, thrown error message and persisted error string (`last_error`, `error_message`). Composite inbox event ids (`pb:<psid>:<payload>:<ts>`) are masked in logs via `maskEventId(eventId, externalUserId)` — dedupe keys in DB are never changed. **Never log link-token material, including prefixes** (`token=…` is banned — verify-success logs only the masked userId; externally sourced usernames/API body text go through `sanitizeLogValue` (strip control chars + cap) before masking). Not masked (documented): structured ops API responses, DB correlation keys (`mid`, `correlationId`, idempotency keys), trace span attributes, raw payloads stored for recovery (bounded by the retention crons above).
- **Greeting copy is shared** (#145): greeting/self-intro/welcome templates for all 3 bots live in `packages/bot-common/src/bot-messages.ts` (`buildGreetingMessage` rotates through `GREETING_VARIANTS` and `buildSelfIntroMessage` through `SELF_INTRO_VARIANTS` for variety, plus `buildLinkSuccessMessage` / `FALLBACK_DISPLAY_NAME`). Intent-detection replies (greeting/self_intro) and Get Started / link / follow / join welcomes use these builders — do not hardcode new copies per bot. The canonical capability list stays in the LLM chat prompt (core `packages/llm-agent/src/chat-system-prompt.ts` + per-bot overlay), not in the greeting.
- Burst counter R3: `CHAT_BURST_STORE=redis` \| `memory` \| `postgres` (default `postgres`).
- Chat queue R4/#174: `CHAT_QUEUE_STORE=redis` \| `memory` — debounce buffer; `CHAT_QUEUE_SHARED=true` maps to `redis` (H7 legacy). Production requires Redis on all three bots; Messenger keeps the legacy `chat:queue:*` keys while Discord/Zalo use `chat:queue:<platform>:*`. A common 2s poller uses bounded due-time ZSET reads and per-user locks; legacy Messenger active members are rehydrated once behind a short Redis lock after deploy (#126). `CHAT_MAX_PENDING_MESSAGES` (0 = no cap) limits messages queued while bot is processing (Discord/Zalo). Vượt cap → drop tin cũ nhất + gửi **1 thông báo** _"Bạn gửi hơi nhiều tin quá..."_ mỗi vòng xử lý (`onPendingDropped` / `droppedNoticePending` trên Redis) — cả 3 bot. Messenger/Zalo durable inbox completion waits for the Redis enqueue write; delivery remains at-least-once after a worker crash.
- Auto-recovery crons: `chat-quota-stuck-recovery` (5 min, advisory-locked) refunds quota slots stuck `reserved` past `CHAT_IDEMPOTENCY_STUCK_RESERVED_MS` (refunds decrement by `(platform, external_user_id, usage_date)` — one refund never touches another user's counter); `report-claims-stale-reset` (30 min, advisory-locked on each platform, `REPORT_CLAIM_STALE_RESET_MS`=2h) releases expired `scheduled_report_claims` leases on Messenger/Discord/Zalo. Claims receive a UUID `lease_token` + `lease_expires_at`; mark-sent/release require the current token, so stale workers no-op. Existing claimed rows with null lease fields use `updated_at` as the recovery cutoff. Released claims are **reclaimable** on the next claim (ON CONFLICT DO UPDATE `WHERE status='released'`), `sent` claims stay non-reclaimable.
- Reminder/report outbox lease ownership: `claimJob` assigns `lease_token` + `lease_expires_at` (env `STUDY_REMINDER_LEASE_MS` / `REPORT_SEND_LEASE_MS`, default 10 min); `markSent`/`markFailed`/`markCancelled` require the token (stale workers no-op); stuck-processing recovery reopens only **expired leases** (migration `1751029200018` backfills in-flight rows).
- Dead-letter retry replays **outbound** failures only (`webhook_dead_letters.direction`, migration `1751029200011`) — Messenger's inbound dead-letter flow was replaced by the durable inbox. Dead-letter persistence retries bounded (3x) and returns `false` on failure — callers log "no durable recovery record" instead of treating the send as handled.
- Outbound retry policy (#156): Discord/Zalo sends retry only rate limits/5xx and explicit network failures; known 4xx/auth/validation errors fail fast. Discord retries reuse a stable `nonce` with `enforceNonce=true`; Zalo has no equivalent idempotency field in the current send payload. Timeout/ambiguous delivery outcomes are not retried and increment the `dm_send_ambiguous` metric. Zalo details + metrics guidance: `apps/zalo-bot/docs/zalo-outbound-delivery.md` (#244).
- Graceful shutdown: `drain()` waits for in-flight debounce flushes (promoted pending messages are delivered, not lost), enqueues arriving after shutdown are rejected with a notice, and all 3 bots use `GRACEFUL_SHUTDOWN_TIMEOUT_MS=45s` (covers 35s LLM tool execution + drain).
- Webhook-action `send_text` is **awaited** before the durable inbox marks the event completed — a Meta delivery failure propagates and the inbound retry cron replays the event (no more fire-and-forget completion).
- Study reminder sync requires an authoritative `getSessions` provider at every entry point (worker, ops controllers, relink, calendar-command) — missing provider fails closed with an error, never cancels jobs from an assumed-empty calendar. Full sync is **keyset-paged** (100 mappings/page, cursor by id) and processed with bounded concurrency (5) — memory and duration no longer grow with one serial upstream fetch per user (#130). Dispatch is **platform-scoped** (#180): `findDueJobs`/`claimJob`/`resetStuckProcessingJobs` take the worker's `platform` — a bot can never claim or reset another bot's jobs (the dispatch service binds its platform in the providers factory).
- Reschedule is **create-before-delete**: the replacement slot is created first (idempotent — an existing target slot is reused on retry), then the source is deleted with bounded retries; a failure never leaves the user without a session.
- Zalo interactive tools send the **inbound Zalo OA id** in `x-zaloid` (`wispaceExternalId: (ctx) => ctx.externalUserId`); the internal WISPACE userId stays local.
- Bootstrap jobs on first run: `npm run study-reminder:sync`.
- **Prod hardening** (see `deploy/`): nightly `pg_dump` backup cron on VPS (`deploy/postgres-backup.sh`, 02:00, giữ 14 ngày) **encrypted at rest** with GPG AES-256 (`BACKUP_ENCRYPTION_PASSPHRASE`); hourly `deploy/backup-monitor.sh` checks backup age and fires Alertmanager alert if >25h stale; deploy tự chạy migrations (advisory-locked, `MIGRATION_CMD`) + health check (`health_path`) + tự rollback về image cũ nếu không healthy; Prometheus scrape cả 3 bot + Alertmanager → Telegram (`deploy/monitoring/`, keys trong `monitoring/.env`: `INTERNAL_API_KEY_*`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`). Prometheus and bare blue-green bots share the external `monitoring` network; stable `<app>-metrics` aliases point to fixed internal ports while Nginx owns host-port switching.

---

## Build commands

From root (Turborepo, builds `packages/llm-agent` first via dependsOn `^build`):

```bash
npm install
npx turbo run build --filter=@wispace/messenger-bot...
npx turbo run test --filter=@wispace/messenger-bot...
```

From `apps/messenger-bot/` (same as pre-migration commands):

```bash
npm run start:dev          # dev server (watch)
npm run build              # compile + copy prompts → dist/
npm run start:prod         # node dist/main
npm run migration:run      # build + run TypeORM migrations
npm run migration:revert   # revert last migration
npm run migration:show     # view migration status
npm run lint               # oxlint --fix
npm run format             # oxfmt
npm run format:check       # oxfmt --check (CI / verify)
npm run typecheck          # tsc --noEmit
npm run verify             # format:check + lint + typecheck + test + build
```

### Utility scripts (require `.env` + DB)

```bash
npm run db:inspect
npm run db:explore-study-schedule
npm run study-reminder:sync-only    # sync jobs, no migration
npm run study-reminder:sync         # build + migrate + sync + dispatch
npm run study-reminder:jobs         # print jobs in DB (--failed, --stuck, --summary)
npm run ops:health                  # I1+S1 combined ops snapshot
npm run chat-quota:status           # query chat quota (psid / userId / date / --ops)
npm run chat-quota:rebuild            # rebuild counter from chat_quota_events (--dry-run)
npm run llm-usage:status              # query LLM tokens by feature/psid (--ops)
npm run chat-quota:recover-stuck    # H2: refund stuck reserved (optional --dry-run)
npm run chat-quota:cleanup          # H6: delete old completed/refunded idempotency records (optional --dry-run)
```

---

## Testing instructions

```bash
npm run test                # Jest, specs in src/**/*.spec.ts
npm run test:watch
npm run test:cov
npm run test:e2e            # test/app.e2e-spec.ts
```

**When to add/update tests:**

- Changing `remind_at` calculation logic → update `study-reminder-schedule.service.spec.ts`
- Changing job upsert when schedule changes → `study-reminder-job.repository.spec.ts`
- Changing ops API guard → `internal-api-key.guard.spec.ts`
- Changing `ref` parsing / `m.me` link → `poc.constants.spec.ts`
- Changing webhook event routing → `messenger-webhook.router.spec.ts`

Before finishing a task (code changes): **required** to update related agent docs/skills (see _Docs & skills when changing code_) and run tests/build.

**Required after every code change — matches CI deploy (in exact order):**

```bash
npm ci                     # required if you just ran npm ci --omit=dev
npm run format:check       # oxfmt --check — CI fails on format errors
npm run lint               # oxlint --fix
npm run typecheck          # tsc --noEmit
npm run test               # Jest — run npm run test
npm run build              # nest build + copy assets → dist/
```

> Missing any step may cause CI failure. The order above matches the `quality` jobs in `.github/workflows/pull-request.yml` (`npm run verify`).

**Full local verification (recommended):** `npm run format` then `npm run verify`.

Fix lint/test/build errors until they pass. `npm run test:e2e` requires a real PostgreSQL instance — not included in the CI gate.

### Common CI Pitfalls

| Symptom                                                   | Cause                                                              | Fix                                                                                                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jest passes locally but CI hangs then fails after ~30s    | Service has `setInterval` / `setTimeout` not cleared → open handle | Add `OnModuleDestroy` + `clearInterval`; `npm run test` runs `jest --forceExit --maxWorkers=50%` (workers for speed, `forceExit` guards open handles) |
| `oxfmt --check` fails even though local reports no errors | File has CRLF (Windows) but Oxfmt config expects LF                | Run `npm run format` before committing                                                                                                                |
| `oxlint` reports `no-useless-escape`                      | Regex uses `\/` or `\-` in character class                         | Remove backslash: `[/-]` instead of `[\/\-]`                                                                                                          |
| Tests pass locally but fail CI due to date/time           | CI runs UTC, local runs UTC+7                                      | Do not hardcode dates — use `new Date()` or mock `Date.now`                                                                                           |

**Rule for adding new services with timer/interval:**

- `collectDefaultMetrics()` from `prom-client`, `setInterval`, long `setTimeout` → **required** to implement `OnModuleDestroy` and clear in `onModuleDestroy()`
- `prom-client` Registry: call `this.registry.clear()` on destroy to clean up collectors

Existing specs (key files, not exhaustive — `apps/*/src/**/*.spec.ts` + `packages/*/src/**/*.spec.ts`):

**Messenger bot:**

- `apps/messenger-bot/src/modules/messenger/application/messenger-webhook.router.spec.ts` (37 tests — pure function router)
- `apps/messenger-bot/src/modules/chat-rate-limit/application/services/chat-rate-limit.service.spec.ts`
- `apps/messenger-bot/src/modules/chat-rate-limit/infrastructure/persistence/chat-rate-limit.repository.spec.ts`
- `apps/messenger-bot/src/modules/messenger/application/services/messenger-chat-queue.service.spec.ts`
- `apps/messenger-bot/src/modules/messenger/application/services/messenger-chat-queue.service.shared.spec.ts`
- `apps/messenger-bot/src/modules/messenger/application/services/messenger-message-log-cleanup.service.spec.ts`
- `apps/messenger-bot/src/modules/messenger/application/agent/messenger-agent.service.spec.ts`
- `apps/messenger-bot/src/modules/study-reminder/application/services/study-reminder-schedule.service.spec.ts`
- `apps/messenger-bot/src/modules/study-reminder/application/services/study-reminder.service.spec.ts`
- `apps/messenger-bot/src/modules/study-reminder/application/services/study-reminder-cleanup.service.spec.ts`
- `apps/messenger-bot/src/modules/student-report/application/services/student-report.service.spec.ts`
- `apps/messenger-bot/src/shared/common/guards/internal-api-key.guard.spec.ts`
- `apps/messenger-bot/src/shared/config/poc.constants.spec.ts`
- `apps/messenger-bot/src/shared/utils/prompt-injection.utils.spec.ts`

**Discord bot:**

- `apps/discord-bot/src/modules/discord-chat/application/services/discord-chat-queue.service.spec.ts`
- `apps/discord-bot/src/modules/discord-chat/application/services/discord-chat-history.service.spec.ts`
- `apps/discord-bot/src/modules/discord-chat/application/services/discord-outbound.service.spec.ts`
- `apps/discord-bot/src/modules/discord-chat/application/services/discord-student-report.service.spec.ts`
- `apps/discord-bot/src/modules/discord-chat/application/services/discord-study-reminder-message-sender.service.spec.ts`
- `apps/discord-bot/src/modules/discord-chat/application/agent/discord-agent-tools.service.spec.ts`
- `apps/discord-bot/src/modules/discord-chat/discord-chat-factory.spec.ts`
- `apps/discord-bot/src/modules/account-link/` (3 specs)

**Zalo bot:**

- `apps/zalo-bot/src/modules/zalo-chat/application/services/zalo-chat-queue.service.spec.ts`
- `apps/zalo-bot/src/modules/zalo-chat/application/services/zalo-chat-history.service.spec.ts`
- `apps/zalo-bot/src/modules/zalo-chat/application/services/zalo-outbound.service.spec.ts`
- `apps/zalo-bot/src/modules/zalo-chat/application/services/zalo-student-report.service.spec.ts`
- `apps/zalo-bot/src/modules/zalo-chat/application/services/zalo-chat.service.spec.ts`
- `apps/zalo-bot/src/modules/zalo-chat/application/agent/zalo-agent-tools.service.spec.ts`
- `apps/zalo-bot/src/modules/zalo-webhook/` (2 specs)
- `apps/zalo-bot/src/modules/zalo-oauth/` (5 specs)

**Shared packages:** spec files across `packages/*/src/` — run `npm run test`

**LLM agent eval harness (`packages/llm-agent`)** — deterministic offline orchestration regression for `LlmAgentService` tool-call decisions (issues #207, #227). The LLM is a frozen scripted adapter — this proves the _loop_ honors a fixture's expectations; it is **not** a live model/tool-selection evaluation and never calls a provider (live eval stays out of CI).

- Spec-style JSON fixtures in `packages/llm-agent/fixtures/*.json` — each declares input (`userText`, `promptFiles` (path + sha256 per real prompt file — chat core `chat-system-prompt.ts` + platform overlay, LF-normalized), optional `history`/`systemPromptSuffix`) + a per-round LLM script (tool calls with args + tool results — optional `content` = the model's plan line on multi-intent tool rounds — or final text) + `expected` (tool order, `toolSummary`/`exhausted` flags, `replyTextContains`/`replyTextNotContains` fabrication guard, `groundingWarnings`, `planRemainder`, `requestContracts`). The multi-tool fixture (`multi-tool-calendar-then-exercise.json`) is the plan-step baseline for #207 item 2: its plan `content` must survive into the next round's messages (asserted by the harness).
- Assertions (#227 hardening): exact ordered tool sequence; the **actual serialized tool args** handed to the executor compared with the scripted args (key-order independent); **unexpected tool attempts always fail**; the scripted tool plan must be **fully consumed** unless `expected.planRemainder` declares intentional leftovers (call-cap, duplicate side effects); `requestContracts` assert the system prompt fragments, latest user message, tool definitions and `toolChoice` per round (or every round when `round` is omitted); leak (`toolResultsNotContain`) and plan-line checks run across **every** provider request (`ScriptedAdapter.allRequests`), not just the last. Scripted args are still validated against the `AGENT_TOOLS` schema; no-tool-on-greeting (empty sequence); grounding/fabrication guard; adapter never called for injection early returns (#161 leak guard: raw tool-error text must never reach the model context).
- Overlay coverage: `discord-overlay-user-goals.json` + `zalo-overlay-reschedule-confirm.json` add request-contract coverage for the Discord/Zalo chat overlays (same hash-gated prompt files as the Messenger fixtures).
- **Prompt changes fail the eval**: fixtures reference the real chat system prompts (core + overlay) by path + sha256 (LF-normalized, so Windows CRLF checkouts match CI) — any prompt edit breaks the hash until the fixture behavior is re-validated and the hash is updated deliberately (no auto-approve).
- `npm run eval:chat` (in `packages/llm-agent`) runs just the harness; the regular `npm run test` covers it in CI. Privacy guard spec rejects real-looking IDs (`eval-` prefix required; no 15+ digit runs in fixture content). The exhaustion fixture also asserts the partial answer (#207 item 4): grounded data labels (`buildExhaustionPartialAnswer` in `messages.ts`) replace the generic failure text. Loop trimming (#207 item 5) drops oldest assistant frames together with their tool results — never an orphaned `tool` message — so the newest tool data survives longest. Tool-call cap + dedupe fixtures (#162): `tool-call-cap.json` (5 distinct calls → fail-closed `buildToolCallCapMessage`, nothing executes, `planRemainder: 5`) and `duplicate-side-effect.json` (identical `precreate_next_exercise` calls execute once, result broadcast to both ids, `planRemainder: 1`).
- Core: `packages/llm-agent/src/eval/eval-harness.ts` + `eval-harness.spec.ts` (auto-discovery) + `eval-harness.negative.spec.ts` (harness self-checks) + `privacy-guard.spec.ts`.

---

## Docs & skills when changing code

Same PR/task as code — update **agent-facing** docs (not just lengthy `docs/`) so the AI does not make mistakes next time.

| Change                                          | Minimum update                                                                                                                                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ops API / webhook / Messenger menu              | `docs/project-overview.md`, `AGENTS.md` (API/cron), `application/messenger-webhook.router.ts` if changing event routing, `messenger-chat.md` rule if chat queue                                                                       |
| Persistent menu / `profile/setup`               | `docs/project-overview.md`, menu section in `AGENTS.md` dev tips                                                                                                                                                                      |
| Rate limit / quota / idempotency                | `apps/messenger-bot/docs/chat-rate-limit-quota.md`, `.claude/rules/chat-rate-limit.md`, `/verify` skill if adding ops steps                                                                                                           |
| Study reminder / sync / dispatch                | `apps/messenger-bot/docs/study-session-reminder.md`, `.claude/rules/study-reminder.md`, `/study-reminder-debug` skill                                                                                                                 |
| Entity / migration / DB split                   | `.claude/rules/database.md`, `/typeorm-migration` skill, `.env.example` if adding variables                                                                                                                                           |
| Remove DB UserCalendars fallback (I3)           | `user-calendar-schedule.service.ts`, `apps/messenger-bot/docs/study-session-reminder.md`, `docs/edge-cases-roadmap.md`                                                                                                                |
| LLM system prompt                               | chat: `packages/llm-agent/src/chat-system-prompt.ts` (core) + `apps/*/src/shared/prompts/*-chat.system.txt` (overlay); report/reminder: `apps/messenger-bot/src/shared/prompts/*.system.txt`, `/edit-llm-prompt` skill                |
| Deploy / CI / VPS path                          | `.github/workflows/deploy-bots.yml` + `deploy-bot-reusable.yml` + `deploy/Dockerfile.bot` (shared, `ARG APP_NAME`), `apps/messenger-bot/docs/doppler-secrets.md`, `apps/messenger-bot/docs/scale-phase-b-runbook.md`, `deploy/nginx/` |
| New env variable                                | `.env.example` + corresponding line in `docs/project-overview.md` or `AGENTS.md`                                                                                                                                                      |
| Meta webhook signature / `MESSENGER_APP_SECRET` | `docs/project-overview.md`, `docs/edge-cases-roadmap.md` §1, `AGENTS.md` Security                                                                                                                                                     |
| Closed gaps / roadmap                           | `docs/edge-cases-roadmap.md`, Integration gaps table in `AGENTS.md`                                                                                                                                                                   |

`/verify` skill — run at the end of every task involving code changes.

---

## Clean Architecture

Repo uses **feature modules + 4 layers** (presentation → application → domain ← infrastructure). Details: `.claude/rules/clean-architecture.md`.

### Dependency flow

- **Domain** — pure types, repository interfaces (no NestJS/TypeORM).
- **Application** — services / use cases, cross-module ports (`Symbol` + `@Inject`).
- **Infrastructure** — TypeORM repo implementations, Wispace/Meta HTTP, LLM provider adapters.
- **Presentation** — controllers (thin, delegate down to application).

### Cross-module ports

| Token                  | Used for                                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MESSENGER_REPOSITORY` | Read/write mapping, logs                                                                                                                             |
| `MESSAGE_SENDER`       | Send Messenger messages — provided by `@wispace/study-reminder-shared`, wrapped via `wrapMessageSender` (dispatch, do not import `MessengerService`) |
| `GOALS_DATA_PORT`      | Fetch goals data from WISPACE API (replaces `UserGoalsApiService`)                                                                                   |
| `REPORT_PORT`          | Generate study reports via LLM (replaces `StudentReportService`)                                                                                     |
| `STUDY_DATA_PORT`      | Retrieve study schedule/reminder data (replaces 4 study-reminder services)                                                                           |

Tool execution: `PlatformAgentService` consumes `PlatformToolExecutorPort` (`packages/chat-agent`) — the shared `PlatformAgentToolsService` implements the Discord/Zalo tool sets; Messenger owns its executor (`MessengerAgentToolsService` implements the same port, wired via `useExisting` — no `toolOverrides` conditional dispatcher). Study-reminder worker wiring is a named typed seam (`createStudyReminderWorker(deps, config)` — no positional `deps[6]`/`unknown`; `createStudyReminderProviders` options take typed `ClassOf<T>` constructors). App-layer ports restored: `USER_CALENDAR_DATA_PORT` + `REMINDER_STUDENT_DATA_PORT` (messenger study-reminder), `DISCORD_ACCOUNT_LINK_REPOSITORY` (discord account-link), `DISCORD_REPORT_ACCOUNT_READER` (discord report cron), `WEBHOOK_INBOUND_EVENTS_PORT` (messenger durable inbox) — concrete TypeORM/WISPACE implementations bound in module wiring.

`StudyReminderModule` imports `MessengerOutboundModule` — **no** `forwardRef` with `MessengerModule`.

`ChatPipelineModule` and `UserLinkingModule` are split from `MessengerModule` — each module is self-contained, importing the modules it needs directly.

---

## Project structure

```
src/
├── main.ts, app.module.ts, app.controller.ts
├── shared/
│   ├── config/              # poc.constants (m.me, parse ref)
│   ├── common/              # InternalApiKeyGuard
│   └── prompts/             # *.system.txt, load-system-prompt.ts
├── infrastructure/
│   └── database/            # TypeORM entities, migrations, DatabaseModule
└── modules/
    ├── messenger/           # domain | application | infrastructure | presentation
    │   ├── domain/ports/    # GoalsDataPort, ReportPort, StudyDataPort
    │   ├── infrastructure/adapters/  # GoalsDataAdapter, ReportAdapter, StudyDataAdapter
    │   └── messenger-outbound.module.ts   # Send API + mapping (breaks cycle)
    ├── chat-rate-limit/    # daily quota + idempotency (H2–H7)
    ├── student-report/
    ├── study-reminder/
    └── scheduler/           # cron + ops HTTP /messenger/*
docs/                        # Detailed documentation — read per task
scripts/                     # CLI debug scripts (not run in app runtime)
```

Each feature in `modules/<name>/`:

```
domain/entities|repositories/ → application/services|ports/ → infrastructure/ → presentation/controllers/
```

### Module → responsibility

| Module                    | Responsibility                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `ChatRateLimitModule`     | FREE_FORM quota: reserve/refund/burst, hard cap H3, ops recover H2                     |
| `ChatPipelineModule`      | Chat queue debounce + agent LLM + tools + store resolvers (split from MessengerModule) |
| `UserLinkingModule`       | Link flow + mapping + token verify (split from MessengerModule)                        |
| `MessengerModule`         | Webhook routing, profile menu, report/reminder delivery, dead letter, cleanup          |
| `MessengerOutboundModule` | Send API, `MessengerRepository`, ports                                                 |
| `StudentReportModule`     | Wispace goals/scores → LLM report                                                      |
| `StudyReminderModule`     | Sync/dispatch/cleanup jobs, LLM study reminders                                        |
| `SchedulerModule`         | `ReportCronService` + HTTP ops endpoints                                               |
| `DatabaseModule`          | TypeORM + PostgreSQL                                                                   |

`AppModule` imports `StudyReminderModule` directly (not just transitively).

---

## Code style & conventions

- **Language:** TypeScript, NestJS 11, TypeORM.
- **User-facing messages:** Vietnamese.
- **Logs / comments:** English or short Vietnamese — only when logic is not self-evident.
- **Config:** `ConfigService` + `.env`; add new variable → update `.env.example`.
- **Migrations:** `apps/messenger-bot/src/infrastructure/database/migrations/`, entities in `apps/messenger-bot/src/infrastructure/database/entities/`.
- **Prompts:** `apps/messenger-bot/src/shared/prompts/` — do not inline long system prompts in services.
- **Cross-module:** inject port (`@Inject(TOKEN)`), `import type` for interfaces.

### Anti-patterns (avoid)

| Don't                                                 | Instead                                           |
| ----------------------------------------------------- | ------------------------------------------------- |
| Stuffing study reminder logic into `MessengerService` | `StudyReminderService` / worker                   |
| `StudyReminderModule` importing `MessengerModule`     | `MessengerOutboundModule` + ports                 |
| `@Entity()` in `domain/`                              | ORM entity in `infrastructure/database/entities/` |
| Hardcoding study reminder lead time                   | `StudyReminderScheduleService` + `.env`           |
| Adding Bull/SQS/Redis queue                           | `study_reminder_jobs` table (outbox pattern)      |
| Hardcoding tokens/API keys                            | `.env` + `ConfigService`                          |
| Committing `.env`                                     | Only `.env.example`                               |

---

## Task → file (quick routing)

| Task                                   | Primary file                                                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Add menu postback                      | `infrastructure/meta/messenger-profile.service.ts`, `application/messenger-webhook.router.ts` (postback routing), `application/services/messenger.service.ts` (executor) |
| Change AI report content               | `shared/prompts/student-report.system.txt`, `student-report/.../student-report.service.ts`                                                                               |
| Change study reminder content          | `shared/prompts/study-reminder.system.txt`, `study-reminder/.../study-reminder.service.ts`                                                                               |
| Change lead time / horizon / retention | `.env`, `study-reminder-schedule.service.ts`                                                                                                                             |
| Add table migration                    | `infrastructure/database/migrations/`, `entities/`                                                                                                                       |
| Wispace schedule change → sync         | `scheduler/.../scheduler.controller.ts` → `StudyReminderSyncService`                                                                                                     |
| UserCalendar API client                | `study-reminder/infrastructure/wispace/user-calendar-api.service.ts`                                                                                                     |
| Create next roadmap exercise           | `@wispace/wispace-client` `WispaceExerciseService` + `precreate_next_exercise` agent tool; no taskType/exerciseTopic/topic/difficulty selection yet                      |
| Send message from another module       | Inject `MESSAGE_SENDER`, not `MessengerService`                                                                                                                          |
| Full sync (ops)                        | `POST /messenger/sync-study-reminders`, `scripts/sync-study-reminder-jobs.mjs`                                                                                           |
| Chat rate limit                        | `ChatRateLimitService`, `MessengerChatEnqueueService`, `MessengerChatProcessorService`, [chat-rate-limit-quota.md](apps/messenger-bot/docs/chat-rate-limit-quota.md)     |
| Shared queue multi-pod (H7/R4)         | `CHAT_QUEUE_STORE` / `CHAT_QUEUE_SHARED`, `CHAT_QUEUE_STORE` port, `MessengerChatQueueWorkerService`                                                                     |
| Ops quota scripts                      | `scripts/chat-quota-status.mjs`, `chat-quota-recover-stuck.mjs`, `chat-quota-cleanup-idempotency.mjs`                                                                    |
| Agent tools / cross-module ports       | `domain/ports/goals-data.port.ts`, `domain/ports/report.port.ts`, `domain/ports/study-data.port.ts`, `infrastructure/adapters/*.adapter.ts`                              |

---

## Data flows (summary)

### User linking

`ref` query param = opaque WISPACE linking token → verified via `WISPACE_API_VERIFY_TOKEN_URL`, then saved to `user_platform_mappings` (`external_user_id` + `platform` + `user_id`).

### Study reports

```
UserGoalsApiService + TaskScoreAverageApiService
  → StudentReportService (LLM)
  → MessengerService.sendTextViaPsid
```

Trigger: 08:00 cron, menu postback, or `POST /messenger/send-reports`.

### Study reminders

```
Wispace schedule change → POST /messenger/study-calendar/sync { userId }
  → StudyReminderSyncService (GET UserCalendar, x-psid)
  → study_reminder_jobs
  → StudyReminderDispatchService (adaptive poll S2)
  → StudyReminderService (LLM) + MESSAGE_SENDER (MessengerOutbound)
```

### Free-form chat (FREE_FORM)

```
Webhook text → persist to `webhook_inbound_events` (idempotent event_id; failure → 500 → Meta redelivers)
  → ACK 200 → retry cron claims and dispatches
  → MessengerChatEnqueueService.enqueue → debounce flush
  → MessengerChatProcessorService.processChatBatch
  → ChatRateLimitService.reserve (DB idempotency + daily usage, hard cap H3)
  → MessengerAgentService (LLM) → Send API
  → markCompleted; error before bubble → refund (H4)
```

Menu postback and proactive messages do **not** go through `ChatRateLimitService`. Enforcement: `CHAT_RATE_LIMIT_ENABLED=true`.

Clear requests to create a new exercise may call `precreate_next_exercise`; it has no arguments, uses the linked platform external ID, requires an HTTPS URL for created/existing exercises, and returns a generic Vietnamese failure on API/network errors. If WISPACE later exposes selection parameters, taskType/exerciseTopic support can be added as a separate extension.

Wispace **must** call the sync API after POST/DELETE `/api/UserCalendar`. The 30-minute cron is only a fallback — it does not replace the webhook/event bus.

---

## Security

- **Never** commit secrets: `.env`, Meta/OpenAI/LLM provider tokens, `INTERNAL_API_KEY`, DB password.
- CI runs Gitleaks on push + PR — a new secret fails the build; local env files are excluded from Docker/backup/deploy. Exposed-env recovery: `docs/project-overview.md` §13.
- Fail-closed config (do not loosen): PostgreSQL TLS for public hosts (`DB_ALLOW_INSECURE_HOSTS` is the only exception, for non-IP hostnames), WISPACE upstream URL validation (`WISPACE_ALLOWED_HOSTS` optional allowlist), Zalo OA token at-rest encryption (`ZALO_TOKEN_ENCRYPTION_KEY`).
- Ops endpoints are protected by `InternalApiKeyGuard` — do not remove the guard when adding operational endpoints.
- Wispace API: send the platform identity header (`x-psid` for Messenger, `x-discordid` for Discord, or `x-zaloid` for Zalo) plus `X-Internal-Key`; do not store/log the user's full access token.
- Meta webhook: verified via `VERIFY_TOKEN` (GET `/v1/webhook`); POST `/v1/webhook` verifies `X-Hub-Signature-256` with `MESSENGER_APP_SECRET` (disable: `MESSENGER_WEBHOOK_SIGNATURE_VERIFY=false`). `ENFORCE_PROD_CHAT_QUOTA=true` or `NODE_ENV=production` → startup fails if secret is missing / verify is disabled / `CHAT_RATE_LIMIT_ENABLED=false`.
- LLM prompt injection: do not pass user/Wispace strings directly into prompts or tool results. Use `sanitizeUntrustedTextForLlm` / `sanitizeToolResultContent`; JSON output from LLM providers must be parsed + shape-validated, with template fallback on error.

## Privacy erasure (GDPR Art. 17)

`PrivacyDataService` (`packages/database/src/services/privacy-data.service.ts`) handles user data erasure. All operations are idempotent — safe to call multiple times.

**Erasure scope** (atomic via `dataSource.transaction()`):

| Table | Erased by | Method |
|-------|-----------|--------|
| `user_platform_mappings` / `discord_account_links` / `zalo_account_links` | `unlink()` | `repo.remove()` |
| `learner_profiles` | `delete()` by userId | `repo.delete()` |
| `study_reminder_jobs` | `delete()` by userId | `repo.delete()` |
| `scheduled_report_claims` | `delete()` by userId | `repo.delete()` |
| `report_send_jobs` | `delete()` by userId | `repo.delete()` |
| `chat_daily_usage` | `delete()` by userId | `repo.delete()` |
| `llm_usage_events` | `delete()` by userId | `repo.delete()` |
| `chat_idempotency` | `delete()` by userId | `repo.delete()` |
| Redis chat history | `delete()` via `ChatHistoryClearer` | `redis.del()` |

**Preserved** (audit trail, auto-cleaned by retention cron):
- `message_logs` — 90-day retention
- `webhook_inbound_events` — 30-day retention (terminal rows)
- `webhook_dead_letters` — 30-day retention
- `discord/zalo_link_verify_records` — cleaned by reconcile cron
- `discord_welcome_records` — dedupe state, no PII

**Not erasable** (no per-user identifier):
- `chat_quota_events` — uses `aggregate_id`, not `external_user_id`

**Cross-platform**: delete uses WISPACE `user_id` (root identifier), so deleting via Messenger also cleans Discord/Zalo records.

**Redis cleanup**: `ChatHistoryClearer` (optional constructor param) — `RedisChatHistoryStore.clear()` or `MemoryChatHistoryStore.clear()`. Best-effort, outside transaction.

---

## Documentation index (read per task)

| Priority | File                                                                                                   | When to read                                                |
| -------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| 1        | [docs/project-overview.md](docs/project-overview.md)                                                   | First time in the repo — architecture, API, cron            |
| 2        | [apps/messenger-bot/docs/study-session-reminder.md](apps/messenger-bot/docs/study-session-reminder.md) | Editing reminders, jobs, sync, dispatch, rollover           |
| 3        | [apps/messenger-bot/docs/chat-rate-limit-quota.md](apps/messenger-bot/docs/chat-rate-limit-quota.md)   | Two-way chatbot, rate limit, quota                          |
| 4        | [docs/edge-cases-roadmap.md](docs/edge-cases-roadmap.md)                                               | Project-wide gaps & remediation phases (beyond chat H1–H7)  |
| 5        | `.env.example`                                                                                         | Required environment variables                              |
| 6        | `apps/messenger-bot/src/shared/config/poc.constants.ts`                                                | `m.me` links, parse `userId` from `ref`                     |
| —        | `.claude/rules/clean-architecture.md`                                                                  | Editing/adding code in `apps/messenger-bot/src/modules/`    |
| —        | `.claude/rules/chat-rate-limit.md`                                                                     | Editing `apps/messenger-bot/src/modules/chat-rate-limit/**` |
| —        | `.claude/rules/messenger-chat.md`                                                                      | Editing chat queue/history/worker                           |

### Claude Code (`.claude/`)

| Path                    | Purpose                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE.md`             | Context loaded each session                                                                                               |
| `.claude/settings.json` | Permissions (npm/git allow; `.env` deny)                                                                                  |
| `.claude/rules/`        | `project-conventions`, `clean-architecture`, `chat-rate-limit`, `messenger-chat`, `study-reminder`, `database`, `prompts` |
| `.claude/skills/`       | `/study-reminder-debug`, `/typeorm-migration`, `/edit-llm-prompt`, `/verify`                                              |

Cursor uses `AGENTS.md` + `.cursor/rules/` (rule `change-workflow`) + global skills `~/.cursor/skills-cursor/` + `.claude/skills/`.

---

## Integration gaps (do not assume these are done)

| Gap                                                                                 | Status                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /messenger/study-calendar/sync`                                               | ✓ Endpoint + sync by `userId`                                                                                                                                                                                                                                                                                   |
| Auth ops (`INTERNAL_API_KEY`)                                                       | ✓ Header `X-Internal-Api-Key` or Bearer                                                                                                                                                                                                                                                                         |
| Wispace wire sync after schedule change                                             | ✓ Calls `POST /messenger/study-calendar/sync` + `X-Internal-Api-Key`                                                                                                                                                                                                                                            |
| Student name for LLM                                                                | ✓ `users` table + `"Users"` view on `ai_chat_bot_db` (`DisplayName` → `'Chào bạn nha'`)                                                                                                                                                                                                                         |
| DB separated from `writing_ai_hub_db`                                               | ✓ `ai_chat_bot_db` — one-time migration from the old hub completed; migrate/drop scripts removed                                                                                                                                                                                                                |
| Upsert `sent` job when rescheduling same `session_key`                              | ✓ `StudyReminderJobRepository.upsertPendingJob` reopens → `pending`                                                                                                                                                                                                                                             |
| Mapping changes `user_id` for same PSID (L3)                                        | ✓ Webhook blocked; ops `POST /messenger/mapping/relink` + `allowRelink`                                                                                                                                                                                                                                         |
| 1:1 `userId` ↔ `psid` mapping (L4)                                                  | ✓ Token-only link + relink webhook blocked; ACTIVE unique index on DB                                                                                                                                                                                                                                           |
| Multi-pod 08:00 report cron (R4)                                                    | ✓ Claim table + advisory lock + `CRON_LEADER_ENABLED`                                                                                                                                                                                                                                                           |
| Two-way chat + rate limit V1                                                        | ✓ Reserve/refund/burst/whitelist/hint                                                                                                                                                                                                                                                                           |
| Rate limit hardening H1–H7                                                          | ✓ H2–H7 code; H1 = enable `CHAT_RATE_LIMIT_ENABLED` on prod env                                                                                                                                                                                                                                                 |
| LLM Provider Abstraction                                                            | ✓ Adapter pattern (`LlmProviderAdapter`), OpenAI adapter, OpenAI-compatible adapter, factory — PR #32                                                                                                                                                                                                           |
| Tier / event store (Phase 7–8)                                                      | ✓ MVP — `chat_quota_events` + `llm_usage_events` tables; full §5.8 [chat-rate-limit-quota.md](apps/messenger-bot/docs/chat-rate-limit-quota.md)                                                                                                                                                                 |
| Discord 08:00 report cron + retry dispatch                                          | ✓ Full leader-election, claim locks, LLM report generation, retry dispatch `*/15`                                                                                                                                                                                                                               |
| Zalo 08:00 report cron                                                              | ✓ Raw format (goals+scores), cross-platform dedup, concurrency 3                                                                                                                                                                                                                                                |
| Zalo study reminders                                                                | ✓ Sync fixed — `getSessions` callback wired via `ZaloWispaceCalendarService`                                                                                                                                                                                                                                    |
| Zalo ops HTTP endpoints                                                             | ✓ `POST /zalo/send-reports`, `/zalo/study-calendar/sync`, `/zalo/sync-study-reminders` + `InternalApiKeyGuard`                                                                                                                                                                                                  |
| Zalo CI/CD                                                                          | ✓ `deploy-bots.yml` (3 jobs: messenger/discord/zalo) + shared `deploy/Dockerfile.bot` + `.github/scripts/vps-deploy.sh`                                                                                                                                                                                         |
| Zalo chat queue / debounce                                                          | ✓ DebounceChatQueue wrapping `@wispace/chat-queue-core` — same as Messenger                                                                                                                                                                                                                                     |
| Zalo Redis burst counter                                                            | ✓ `PostgresBurstCounter` (was `MemoryBurstCounter`)                                                                                                                                                                                                                                                             |
| Zalo LLM report enrichment                                                          | ✓ Report cron uses `ZaloStudentReportService` (LLM); tool still raw                                                                                                                                                                                                                                             |
| Discord/Zalo chat queue (H7/#174)                                                   | ✓ `DebounceChatQueue` + `ChatPipeline` + pending cap (`CHAT_MAX_PENDING_MESSAGES`) + typing indicator + user feedback + one direct fallback for pre-delivery failures; Redis enqueue is restart-safe with platform namespaces, per-user locks, and a common worker. Production memory mode → **startup reject** |
| LLM cost: double retry trên Discord/Zalo                                            | ✓ `maxLlmRetries: 0` (1 retry layer: `retryWithBackoff` ngoài); `0` giờ disable inner retry thật sự (`llm-agent` `getMaxLlmRetries` sửa `>0` → `>=0`)                                                                                                                                                           |
| LLM cost: cap output token report/reminder                                          | ✓ `maxOutputTokens: 500` cho JSON report + reminder (shape cố định)                                                                                                                                                                                                                                             |
| LLM cost: Messenger tool `get_learning_progress_report` không còn gọi LLM lồng nhau | ✓ Cache report theo ngày (`psid:YYYY-MM-DD`, in-memory, 5k entries) → cron 08:00 pre-warm; tool dùng cache, miss → static report (`generateReportStatic`, không LLM); menu postback reuse cache                                                                                                                 |
| DB: missing indexes                                                                 | ✓ migration `1751029200010` — `chat_idempotency(platform,status,reserved_at)`, `scheduled_report_claims(user_id,report_date,status)+created_at`, `message_logs(created_at)`                                                                                                                                     |
| DB: report claims retention                                                         | ✓ `${platform}-report-claims-cleanup` (Discord/Zalo, 03:45 ICT, advisory-lock, 90 ngày) — AGENTS.md dev tip đã spec sẵn                                                                                                                                                                                         |
| DB: batch study-reminder sync                                                       | ✓ `upsertPendingJobs` — 1 SELECT cho cả user thay vì findOne+save per session                                                                                                                                                                                                                                   |
| DB: Zalo report cron pre-query                                                      | ✓ `listUserIdsWithSentReportToday` → 1 query thay N query per user                                                                                                                                                                                                                                              |
| Discord/Zalo multi-pod chat history                                                 | ✓ `CHAT_HISTORY_STORE=redis` via shared `PlatformChatHistoryService` (`chat-history:discord:` / `chat-history:zalo:` keys) — memory default, Redis optional (same as Messenger)                                                                                                                                 |
| Learner profile (#207 item 3)                                                       | ✓ `learner_profiles` table (target_score, exam_date + per-field fetched_at) — v1 source `get_user_goals`, injected via `systemPromptSuffix` with 24h freshness; weakAreas deferred (no server-derived source yet)                                                                                               |
| Project-wide gaps (link, reports, reminders, ops)                                   | Roadmap — [edge-cases-roadmap.md](docs/edge-cases-roadmap.md)                                                                                                                                                                                                                                                   |

When closing a gap: update `apps/messenger-bot/docs/study-session-reminder.md` and the table above.

---

## Boundaries — do not do unless explicitly requested by user

- Commit / push git
- Create markdown files outside `docs/` or write unnecessary lengthy READMEs
- Add message queues (Bull, SQS, Redis)
- Force push, modify git config

---

## PR / commit guidelines

- Only commit when explicitly requested by user.
- Do not commit `.env` or files containing secrets.
- Commit messages: short, describe **why** more than **what**.
- Before PR: run all 5 CI commands in order `format:check → lint → typecheck → test → build`; local verification recommended: `npm run verify`.

HTTP throttling: `WEBHOOK_RATE_LIMIT_PER_MINUTE` / `WEBHOOK_RATE_LIMIT_TTL_MS` configure authenticated Messenger/Zalo webhook bursts; `THROTTLE_DEFAULT_LIMIT` / `THROTTLE_DEFAULT_TTL_MS` configure other throttled routes. Redis provides the shared atomic window when enabled; configured-but-unavailable Redis fails closed.
