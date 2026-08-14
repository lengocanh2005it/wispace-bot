# AGENTS.md

Instructions for AI coding agents working in the **wispace-bots** repo — Turborepo monorepo for WISPACE student bots (AI reports + study reminders + rate-limited AI chat). Currently includes `apps/messenger-bot` (fully functional), `apps/discord-bot` (fully functional: chat + quota/usage/safety + account-linking OAuth2 + 7/7 real tool handlers + 08:00 report cron + leader-election + retry dispatch + study reminders + dead letter + message log cleanup + CI/CD workflow), `apps/zalo-bot` (fully functional: chat + quota + account-linking OAuth2 + 7/7 real tool handlers + LLM report enrichment + 08:00 report cron + study reminders + dead letter + message log + stuck recovery + ops endpoints + CI/CD + shared health endpoints + Redis queue/history options + chat queue; production env sync uses the manual workflow and the legacy Doppler webhook is disabled), and 18 shared packages in `packages/`: `llm-agent` (LLM function-calling + provider abstraction), `chat-metering` (quota/rate-limit + LLM usage/safety event tracking), `chat-agent` (platform-parameterized agent/tools/queue/history services for Discord & Zalo), `wispace-client` (Wispace API HTTP client for goals/scores/calendar), `chat-history` (memory + Redis chat history stores with TTL + turn cap), `student-report` (student capability report generation), `chat-queue-core` (per-user debounce/merge state machine), `chat-pipeline` (platform-agnostic chat pipeline: rate-limit → history → agent → outbound), `study-reminder-shared` (study reminder schedule + dispatch/sync/worker services), `scheduler-core` (report cron scheduling + leader election), `bot-metrics` (Prometheus metrics), `cleanup-cron` (advisory-lock cleanup cron), `ops-health` (ops health snapshot + alerts), `reschedule-confirm` (generic reschedule confirmation service), `bot-common` (shared NestJS infrastructure: ops API guard, advisory locks), `database` (shared DB entities + migrations), `doppler-sync` (Doppler runtime secret sync helpers), `date-utils` (timezone-aware date helpers).LM).

Read this file before modifying code. In-depth details are in `docs/` — only read when relevant to the task. Full monorepo roadmap (Discord/Zalo, cross-platform DB, independent CI/CD): [docs/turborepo-migration-plan.md](docs/turborepo-migration-plan.md).

**Path note:** most of the content below (modules, `npm run ...` commands, `src/...` paths) describes `apps/messenger-bot/` — run those commands **inside `apps/messenger-bot/`**, or use `npx turbo run <script> --filter=@wispace/messenger-bot...` from root.

---

## Project overview

| | |
|---|---|
| **Stack** | NestJS 11, TypeScript, TypeORM, PostgreSQL, LLM Provider Abstraction (adapter pattern) |
| **Goal** | Link IELTS students `m.me` ↔ WISPACE, deliver progress reports and study session reminders via Messenger |
| **Scope** | Small backend service — **not** full-stack, **not** a standalone microservice |
| **DB** | PostgreSQL **`ai_chat_bot_db`** (dedicated database); Wispace data via **HTTP API**; user name cache: `users` table + `"Users"` view |
| **Principles** | Small diffs, reuse existing modules, config via `.env`; Redis optional (R0–R4) for scale / VPS |

---

## Dev environment tips

- Copy `.env.example` → `.env` and fill in real tokens before running sync/cron — or use [Doppler](apps/messenger-bot/docs/doppler-secrets.md): `doppler setup` + `npm run start:dev:doppler`.
- **Prod DB:** `DB_NAME=ai_chat_bot_db` (no longer `writing_ai_hub_db`).
- **DB TLS is enforced independent of `NODE_ENV`** (`packages/database/src/typeorm-options.ts`): startup + migration fail when `DB_SSL != true` for any host that is not localhost/a private IPv4. Non-IP hostnames (e.g. Docker-internal `postgres`) need `DB_ALLOW_INSECURE_HOSTS=postgres,db.internal` — the only plaintext exception. TLS always verifies the peer; supply the CA via `DB_SSL_CA`. CI test job uses `DB_ALLOW_INSECURE_HOSTS=postgres`.
- **WISPACE upstream URLs fail closed** (`packages/wispace-client/src/utils/upstream-url.utils.ts`): HTTPS required (dev-only `http://localhost` when `NODE_ENV != production`), credentials/fragments rejected, private targets rejected in production, optional `WISPACE_ALLOWED_HOSTS` allowlist. Applied to every WISPACE client config + verify-token URL at startup — do not bypass with a raw URL.
- **Zalo OA tokens are encrypted at rest** (AES-256-GCM, per-row IV, `v1.<iv>.<tag>.<cipher>` in `zalo_oa_tokens`): `ZALO_TOKEN_ENCRYPTION_KEY` (32-byte base64, Doppler) is required; legacy plaintext rows fail closed — re-bootstrap via `apps/zalo-bot/docs/zalo-oa-token-bootstrap.md`. Zalo refresh is serialized (transaction + `FOR UPDATE`, re-read after lock) — single-use refresh tokens are never submitted twice.
- **Discord pending-link capability is cookie-bound** (`pending_link` HttpOnly/Secure/SameSite=None, 15 min): never appears in URL query/fragment; `GET /discord/guild/join-status` + `POST /discord/guild/complete-link` read the cookie (frontend must use `credentials: 'include'`; CORS credentials enabled). `Referrer-Policy: no-referrer` on the linking flow.
- **CI secret scanning:** Gitleaks runs on push + PR (failing policy). Exposed-local-`.env` recovery procedure: `docs/project-overview.md` §13.
- Meta webhook needs a public URL (ngrok/tunnel) pointing to `POST /v1/webhook`.
- After first deploy: call `POST /v1/messenger/profile/setup` (header `X-Internal-Api-Key`) — prod menu only has **Register Report** (bot sends reports/reminders automatically).
- Editing files in `apps/messenger-bot/src/shared/prompts/*.system.txt` → **requires** `npm run build` (Nest copies assets to `dist/shared/prompts/`).
- Study reminder: `STUDY_REMINDER_*` variables are **required** — use `readRequiredPositiveNumber`, do not hardcode fallbacks in code.
- Wispace API auth: platform identity header **`x-psid`** (Messenger), **`x-discordid`** (Discord), or **`x-zaloid`** (Zalo) + **`X-Internal-Key`** (`WISPACE_INTERNAL_KEY`); mapping linkage **requires** token verification via **`POST WISPACE_API_VERIFY_TOKEN_URL`** (shared across 3 bots, body `{token, value, platform}`; `MESSENGER_LINK_MODE=token`; startup fails if config is missing).
- Next roadmap exercise chat tool: `POST WISPACE_API_PRECREATE_EXERCISE_URL` with an empty body, timeout `WISPACE_API_PRECREATE_EXERCISE_TIMEOUT_MS=30000`, no automatic retry, and `X-Internal-Key`; identity header is `x-psid` (Messenger), `x-discordid` (Discord), or `x-zaloid` (Zalo). It requires a linked account and creates only the next roadmap exercise.
- Ops HTTP (`/messenger/study-calendar/sync`, `send-reports`, …) require header **`X-Internal-Api-Key`** or `Authorization: Bearer …` matching `INTERNAL_API_KEY`.
- Internal cron (30-minute sync, adaptive S2 dispatch) runs in-process — no API key required.
- Debug study reminder jobs: `npm run study-reminder:jobs` (`--failed`, `--stuck`, `--summary`).
- Query chat quota: `npm run chat-quota:status` (`--psid`, `--user-id`, `--date`, `--ops`); rebuild counter: `chat-quota:rebuild` (`--dry-run`).
- Query LLM tokens: `npm run llm-usage:status` (`--psid`, `--feature`, `--ops`); HTTP ops `GET /v1/messenger/ops/llm-usage/summary` (`psid` \| `userId`, `from`, `to`) and `GET /v1/messenger/ops/llm-usage/fleet` (`date`); USD: `LLM_COST_USD_PER_1M_*_GPT_5_4` = `2.50` / `15.00` (OpenAI Standard gpt-5.4); persisted via fire-and-forget inline insert (BullMQ queue removed — add when throughput justifies).
- Cap concurrent LLM calls (single instance): `LLM_EXECUTION_ENABLED=true`, `LLM_MAX_CONCURRENT` (default `3`) — `LlmExecutionModule`; quick disable: `LLM_EXECUTION_ENABLED=false`.
- AbortSignal propagation: LLM + WISPACE calls accept an `AbortSignal` — timeouts/cancellation abort the underlying request (`isAbortError`/`sleep` shared in `packages/bot-common/src/abort.utils.ts`; WISPACE per-attempt `mergeWithTimeout`, circuit timeout = total budget `computeCircuitBreakerTimeout`; `LlmExecutionContext.signal`). Abort/deadline errors are never retried. Details: `docs/project-overview.md` §7.1.
- LLM safety: free-form chat blocks prompt injection before calling LLM, sanitizes history/tool results; external data for reminders/reports must go through `prompt-injection.utils` / validate JSON output (`llm-json-output.utils`) before formatting/sending.
- Ops health I1+S1: `npm run ops:health` (cron 09:00 ICT in-app when `OPS_HEALTH_ALERT_ENABLED=true`).
- Production env sync: use the manual `sync-env.yml` workflow; the in-container Doppler webhook is disabled because bot containers do not receive the host Docker socket.
- Audit log cleanup: cron `messenger-message-log-cleanup` — 03:00 ICT every Monday; `MESSENGER_MESSAGE_LOG_RETENTION_DAYS=90` (disable: `MESSENGER_MESSAGE_LOG_CLEANUP_ENABLED=false`).
- Health endpoints (shared `HealthController` in `packages/bot-common`, same semantics on all 3 bots): `GET /health` = **public liveness** (generic `{status:"ok"}`, never leaks dependency details); `GET /health/ready` = **public readiness** (200 only when DB + configured Redis reachable; 503 body is status-only); `GET /health/detail` = **internal** (`X-Internal-Api-Key`) full DB/Redis detail. Deploy gates and `vps-self-pull-deploy.sh` use `/health/ready`; Nginx rate-limits public readiness probes.
- Redis R0: `REDIS_ENABLED=true` + `REDIS_*` → startup logs PING; non-local Redis requires TLS, or explicit `REDIS_PRIVATE_NETWORK=true` on a private Docker/VPC network; readiness via `GET /health/ready` (503 when enabled but unreachable).
- Redis R5: `USER_DISPLAY_NAME_CACHE_*` — caches `cache:user:display:{userId}` before querying `users` table / `"Users"` view.
- Chat history R1: `CHAT_HISTORY_STORE=redis` (requires `REDIS_ENABLED=true`) \| `memory` (postgres table removed).
- **Webhook ingestion is durable** (R2): every authenticated Messenger/Zalo event is persisted to `webhook_inbound_events` **before** the endpoint acks (200); downstream handlers run from the advisory-locked retry cron. Duplicate deliveries are idempotent via unique `(platform, event_id)` (Messenger mid / Zalo msg_id; postbacks/follows use `{type}:{userId}:{ts}`) — replaces the removed `CHAT_DEDUPE_STORE` memory/redis stores. Handler failures → `failed` + bounded backoff; retry cron every 30s (advisory-locked: `MESSENGER_WEBHOOK_INBOUND_RETRY` 884_200_905 / `ZALO_WEBHOOK_INBOUND_RETRY` 884_200_932) replays `pending`/`failed` rows → `abandoned` (terminal) after `WEBHOOK_INBOUND_MAX_RETRIES`. A stale `processing` lease is terminalized, not replayed, because its side effects may already have completed. Persistence failure → non-2xx → platform redelivers.
- **Raw-payload retention** (R2): cron `webhook-inbound-cleanup` — 03:15 ICT daily, advisory-locked (`MESSENGER_WEBHOOK_INBOUND_CLEANUP` 884_200_910 / `ZALO_WEBHOOK_INBOUND_CLEANUP` 884_200_933) — deletes terminal (`completed`/`abandoned`) `webhook_inbound_events` rows older than `WEBHOOK_INBOUND_RETENTION_DAYS=30` (disable: `WEBHOOK_INBOUND_CLEANUP_ENABLED=false`); non-terminal rows are never deleted (retry/recovery intact).
- **Log redaction** (consistent masking): never log raw external IDs (Messenger PSID, Discord ID, Zalo ID, WISPACE userId) — use `maskExternalId(id)` from `@wispace/bot-common` (first 4 + `…` + last 4; `???` for missing) in every log line, thrown error message and persisted error string (`last_error`, `error_message`). Composite inbox event ids (`pb:<psid>:<payload>:<ts>`) are masked in logs via `maskEventId(eventId, externalUserId)` — dedupe keys in DB are never changed. Not masked (documented): structured ops API responses, DB correlation keys (`mid`, `correlationId`, idempotency keys), trace span attributes, raw payloads stored for recovery (bounded by the retention crons above).
- Burst counter R3: `CHAT_BURST_STORE=redis` \| `memory` \| `postgres` (default `postgres`).
- Chat queue R4: `CHAT_QUEUE_STORE=redis` \| `memory` — debounce buffer; `CHAT_QUEUE_SHARED=true` maps to `redis` (H7 legacy). `CHAT_MAX_PENDING_MESSAGES` (0 = no cap) limits messages queued while bot is processing (Discord/Zalo). Vượt cap → drop tin cũ nhất + gửi **1 thông báo** *"Bạn gửi hơi nhiều tin quá..."* mỗi vòng xử lý (`onPendingDropped` / `droppedNoticePending` trên Redis) — cả 3 bot.
- Auto-recovery crons: `chat-quota-stuck-recovery` (5 min, advisory-locked) refunds quota slots stuck `reserved` past `CHAT_IDEMPOTENCY_STUCK_RESERVED_MS`; `report-claims-stale-reset` (30 min, advisory-locked, `REPORT_CLAIM_STALE_RESET_MS`=2h) releases `scheduled_report_claims` stuck `claimed` (pod crash between claim and mark-sent).
- Dead-letter retry replays **outbound** failures only (`webhook_dead_letters.direction`, migration `1751029200011`) — Messenger's inbound dead-letter flow was replaced by the durable inbox.
- Graceful shutdown drains debounce buffers before clearing (no lost messages on restart); shutdown timeout 25s.
- Bootstrap jobs on first run: `npm run study-reminder:sync`.
- **Prod hardening** (see `deploy/`): nightly `pg_dump` backup cron on VPS (`deploy/postgres-backup.sh`, 02:00, giữ 14 ngày); deploy tự chạy migrations (advisory-locked, `MIGRATION_CMD`) + health check (`health_path`) + tự rollback về image cũ nếu không healthy; Prometheus scrape cả 3 bot + Alertmanager → Telegram (`deploy/monitoring/`, keys trong `monitoring/.env`: `INTERNAL_API_KEY_*`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`).

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
npm run lint               # eslint --fix
npm run format             # prettier --write
npm run format:check       # prettier --check (CI / verify)
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

Before finishing a task (code changes): **required** to update related agent docs/skills (see *Docs & skills when changing code*) and run tests/build.

**Required after every code change — matches CI deploy (in exact order):**

```bash
npm ci                     # required if you just ran npm ci --omit=dev
npm run format:check       # prettier --check — CI fails on format errors
npm run lint               # eslint --fix
npm run typecheck          # tsc --noEmit
npm run test               # Jest — run npm run test
npm run build              # nest build + copy assets → dist/
```

> Missing any step may cause CI failure. The order above matches the `quality` jobs in `.github/workflows/pull-request.yml` (`npm run verify`).

**Full local verification (recommended):** `npm run format` then `npm run verify`.

Fix lint/test/build errors until they pass. `npm run test:e2e` requires a real PostgreSQL instance — not included in the CI gate.

### Common CI Pitfalls

| Symptom | Cause | Fix |
|---------|-------|-----|
| Jest passes locally but CI hangs then fails after ~30s | Service has `setInterval` / `setTimeout` not cleared → open handle | Add `OnModuleDestroy` + `clearInterval`; `npm run test` runs `jest --forceExit --maxWorkers=50%` (workers for speed, `forceExit` guards open handles) |
| `prettier --check` fails even though local reports no errors | File has CRLF (Windows) but Prettier config expects LF | Run `npm run format` before committing |
| `eslint` reports `no-useless-escape` | Regex uses `\/` or `\-` in character class | Remove backslash: `[/-]` instead of `[\/\-]` |
| Tests pass locally but fail CI due to date/time | CI runs UTC, local runs UTC+7 | Do not hardcode dates — use `new Date()` or mock `Date.now` |

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

---

## Docs & skills when changing code

Same PR/task as code — update **agent-facing** docs (not just lengthy `docs/`) so the AI does not make mistakes next time.

| Change | Minimum update |
|--------|----------------|
| Ops API / webhook / Messenger menu | `docs/project-overview.md`, `AGENTS.md` (API/cron), `application/messenger-webhook.router.ts` if changing event routing, `messenger-chat.md` rule if chat queue |
| Persistent menu / `profile/setup` | `docs/project-overview.md`, menu section in `AGENTS.md` dev tips |
| Rate limit / quota / idempotency | `apps/messenger-bot/docs/chat-rate-limit-quota.md`, `.claude/rules/chat-rate-limit.md`, `/verify` skill if adding ops steps |
| Study reminder / sync / dispatch | `apps/messenger-bot/docs/study-session-reminder.md`, `.claude/rules/study-reminder.md`, `/study-reminder-debug` skill |
| Entity / migration / DB split | `.claude/rules/database.md`, `/typeorm-migration` skill, `.env.example` if adding variables |
| Remove DB UserCalendars fallback (I3) | `user-calendar-schedule.service.ts`, `apps/messenger-bot/docs/study-session-reminder.md`, `docs/edge-cases-roadmap.md` |
| LLM system prompt | `apps/messenger-bot/src/shared/prompts/*.system.txt`, `/edit-llm-prompt` skill |
| Deploy / CI / VPS path | `.github/workflows/deploy-bots.yml` + `deploy-bot-reusable.yml` + `deploy/Dockerfile.bot` (shared, `ARG APP_NAME`), `apps/messenger-bot/docs/doppler-secrets.md`, `apps/messenger-bot/docs/scale-phase-b-runbook.md`, `deploy/nginx/` |
| New env variable | `.env.example` + corresponding line in `docs/project-overview.md` or `AGENTS.md` |
| Meta webhook signature / `MESSENGER_APP_SECRET` | `docs/project-overview.md`, `docs/edge-cases-roadmap.md` §1, `AGENTS.md` Security |
| Closed gaps / roadmap | `docs/edge-cases-roadmap.md`, Integration gaps table in `AGENTS.md` |

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

| Token | Used for |
|-------|----------|
| `MESSENGER_REPOSITORY` | Read/write mapping, logs |
| `MESSAGE_SENDER` | Send Messenger messages — provided by `@wispace/study-reminder-shared`, wrapped via `wrapMessageSender` (dispatch, do not import `MessengerService`) |
| `GOALS_DATA_PORT` | Fetch goals data from WISPACE API (replaces `UserGoalsApiService`) |
| `REPORT_PORT` | Generate study reports via LLM (replaces `StudentReportService`) |
| `STUDY_DATA_PORT` | Retrieve study schedule/reminder data (replaces 4 study-reminder services) |

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

| Module | Responsibility |
|--------|---------------|
| `ChatRateLimitModule` | FREE_FORM quota: reserve/refund/burst, hard cap H3, ops recover H2 |
| `ChatPipelineModule` | Chat queue debounce + agent LLM + tools + store resolvers (split from MessengerModule) |
| `UserLinkingModule` | Link flow + mapping + token verify (split from MessengerModule) |
| `MessengerModule` | Webhook routing, profile menu, report/reminder delivery, dead letter, cleanup |
| `MessengerOutboundModule` | Send API, `MessengerRepository`, ports |
| `StudentReportModule` | Wispace goals/scores → LLM report |
| `StudyReminderModule` | Sync/dispatch/cleanup jobs, LLM study reminders |
| `SchedulerModule` | `ReportCronService` + HTTP ops endpoints |
| `DatabaseModule` | TypeORM + PostgreSQL |

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

| Don't | Instead |
|-------|---------|
| Stuffing study reminder logic into `MessengerService` | `StudyReminderService` / worker |
| `StudyReminderModule` importing `MessengerModule` | `MessengerOutboundModule` + ports |
| `@Entity()` in `domain/` | ORM entity in `infrastructure/database/entities/` |
| Hardcoding study reminder lead time | `StudyReminderScheduleService` + `.env` |
| Adding Bull/SQS/Redis queue | `study_reminder_jobs` table (outbox pattern) |
| Hardcoding tokens/API keys | `.env` + `ConfigService` |
| Committing `.env` | Only `.env.example` |

---

## Task → file (quick routing)

| Task | Primary file |
|------|-------------|
| Add menu postback | `infrastructure/meta/messenger-profile.service.ts`, `application/messenger-webhook.router.ts` (postback routing), `application/services/messenger.service.ts` (executor) |
| Change AI report content | `shared/prompts/student-report.system.txt`, `student-report/.../student-report.service.ts` |
| Change study reminder content | `shared/prompts/study-reminder.system.txt`, `study-reminder/.../study-reminder.service.ts` |
| Change lead time / horizon / retention | `.env`, `study-reminder-schedule.service.ts` |
| Add table migration | `infrastructure/database/migrations/`, `entities/` |
| Wispace schedule change → sync | `scheduler/.../scheduler.controller.ts` → `StudyReminderSyncService` |
| UserCalendar API client | `study-reminder/infrastructure/wispace/user-calendar-api.service.ts` |
| Create next roadmap exercise | `@wispace/wispace-client` `WispaceExerciseService` + `precreate_next_exercise` agent tool; no taskType/exerciseTopic/topic/difficulty selection yet |
| Send message from another module | Inject `MESSAGE_SENDER`, not `MessengerService` |
| Full sync (ops) | `POST /messenger/sync-study-reminders`, `scripts/sync-study-reminder-jobs.mjs` |
| Chat rate limit | `ChatRateLimitService`, `MessengerChatEnqueueService`, `MessengerChatProcessorService`, [chat-rate-limit-quota.md](apps/messenger-bot/docs/chat-rate-limit-quota.md) |
| Shared queue multi-pod (H7/R4) | `CHAT_QUEUE_STORE` / `CHAT_QUEUE_SHARED`, `CHAT_QUEUE_STORE` port, `MessengerChatQueueWorkerService` |
| Ops quota scripts | `scripts/chat-quota-status.mjs`, `chat-quota-recover-stuck.mjs`, `chat-quota-cleanup-idempotency.mjs` |
| Agent tools / cross-module ports | `domain/ports/goals-data.port.ts`, `domain/ports/report.port.ts`, `domain/ports/study-data.port.ts`, `infrastructure/adapters/*.adapter.ts` |

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

---

## Documentation index (read per task)

| Priority | File | When to read |
|----------|------|-------------|
| 1 | [docs/project-overview.md](docs/project-overview.md) | First time in the repo — architecture, API, cron |
| 2 | [apps/messenger-bot/docs/study-session-reminder.md](apps/messenger-bot/docs/study-session-reminder.md) | Editing reminders, jobs, sync, dispatch, rollover |
| 3 | [apps/messenger-bot/docs/chat-rate-limit-quota.md](apps/messenger-bot/docs/chat-rate-limit-quota.md) | Two-way chatbot, rate limit, quota |
| 4 | [docs/edge-cases-roadmap.md](docs/edge-cases-roadmap.md) | Project-wide gaps & remediation phases (beyond chat H1–H7) |
| 5 | `.env.example` | Required environment variables |
| 6 | `apps/messenger-bot/src/shared/config/poc.constants.ts` | `m.me` links, parse `userId` from `ref` |
| — | `.claude/rules/clean-architecture.md` | Editing/adding code in `apps/messenger-bot/src/modules/` |
| — | `.claude/rules/chat-rate-limit.md` | Editing `apps/messenger-bot/src/modules/chat-rate-limit/**` |
| — | `.claude/rules/messenger-chat.md` | Editing chat queue/history/worker |

### Claude Code (`.claude/`)

| Path | Purpose |
|------|---------|
| `CLAUDE.md` | Context loaded each session |
| `.claude/settings.json` | Permissions (npm/git allow; `.env` deny) |
| `.claude/rules/` | `project-conventions`, `clean-architecture`, `chat-rate-limit`, `messenger-chat`, `study-reminder`, `database`, `prompts` |
| `.claude/skills/` | `/study-reminder-debug`, `/typeorm-migration`, `/edit-llm-prompt`, `/verify` |

Cursor uses `AGENTS.md` + `.cursor/rules/` (rule `change-workflow`) + global skills `~/.cursor/skills-cursor/` + `.claude/skills/`.

---

## Integration gaps (do not assume these are done)

| Gap | Status |
|-----|------------|
| `POST /messenger/study-calendar/sync` | ✓ Endpoint + sync by `userId` |
| Auth ops (`INTERNAL_API_KEY`) | ✓ Header `X-Internal-Api-Key` or Bearer |
| Wispace wire sync after schedule change | ✓ Calls `POST /messenger/study-calendar/sync` + `X-Internal-Api-Key` |
| Student name for LLM | ✓ `users` table + `"Users"` view on `ai_chat_bot_db` (`DisplayName` → `'Chào bạn nha'`) |
| DB separated from `writing_ai_hub_db` | ✓ `ai_chat_bot_db` — one-time migration from the old hub completed; migrate/drop scripts removed |
| Upsert `sent` job when rescheduling same `session_key` | ✓ `StudyReminderJobRepository.upsertPendingJob` reopens → `pending` |
| Mapping changes `user_id` for same PSID (L3) | ✓ Webhook blocked; ops `POST /messenger/mapping/relink` + `allowRelink` |
| 1:1 `userId` ↔ `psid` mapping (L4) | ✓ Token-only link + relink webhook blocked; ACTIVE unique index on DB |
| Multi-pod 08:00 report cron (R4) | ✓ Claim table + advisory lock + `CRON_LEADER_ENABLED` |
| Two-way chat + rate limit V1 | ✓ Reserve/refund/burst/whitelist/hint |
| Rate limit hardening H1–H7 | ✓ H2–H7 code; H1 = enable `CHAT_RATE_LIMIT_ENABLED` on prod env |
| LLM Provider Abstraction | ✓ Adapter pattern (`LlmProviderAdapter`), OpenAI adapter, OpenAI-compatible adapter, factory — PR #32 |
| Tier / event store (Phase 7–8) | ✓ MVP — `chat_quota_events` + `llm_usage_events` tables; full §5.8 [chat-rate-limit-quota.md](apps/messenger-bot/docs/chat-rate-limit-quota.md) |
| Discord 08:00 report cron + retry dispatch | ✓ Full leader-election, claim locks, LLM report generation, retry dispatch `*/15` |
| Zalo 08:00 report cron | ✓ Raw format (goals+scores), cross-platform dedup, concurrency 3 |
| Zalo study reminders | ✓ Sync fixed — `getSessions` callback wired via `ZaloWispaceCalendarService` |
| Zalo ops HTTP endpoints | ✓ `POST /zalo/send-reports`, `/zalo/study-calendar/sync`, `/zalo/sync-study-reminders` + `InternalApiKeyGuard` |
| Zalo CI/CD | ✓ `deploy-bots.yml` (3 jobs: messenger/discord/zalo) + shared `deploy/Dockerfile.bot` + `.github/scripts/vps-deploy.sh` |
| Zalo chat queue / debounce | ✓ DebounceChatQueue wrapping `@wispace/chat-queue-core` — same as Messenger |
| Zalo Redis burst counter | ✓ `PostgresBurstCounter` (was `MemoryBurstCounter`) |
| Zalo LLM report enrichment | ✓ Report cron uses `ZaloStudentReportService` (LLM); tool still raw |
| Discord/Zalo chat queue (H7) | ✓ `DebounceChatQueue` + `ChatPipeline` + pending cap (`CHAT_MAX_PENDING_MESSAGES`) + typing indicator + user feedback + one direct fallback for pre-delivery failures; original/fallback delivery failures are logged separately |
| LLM cost: double retry trên Discord/Zalo | ✓ `maxLlmRetries: 0` (1 retry layer: `retryWithBackoff` ngoài); `0` giờ disable inner retry thật sự (`llm-agent` `getMaxLlmRetries` sửa `>0` → `>=0`) |
| LLM cost: cap output token report/reminder | ✓ `maxOutputTokens: 500` cho JSON report + reminder (shape cố định) |
| LLM cost: Messenger tool `get_learning_progress_report` không còn gọi LLM lồng nhau | ✓ Cache report theo ngày (`psid:YYYY-MM-DD`, in-memory, 5k entries) → cron 08:00 pre-warm; tool dùng cache, miss → static report (`generateReportStatic`, không LLM); menu postback reuse cache |
| DB: missing indexes | ✓ migration `1751029200010` — `chat_idempotency(platform,status,reserved_at)`, `scheduled_report_claims(user_id,report_date,status)+created_at`, `message_logs(created_at)` |
| DB: report claims retention | ✓ `${platform}-report-claims-cleanup` (Discord/Zalo, 03:45 ICT, advisory-lock, 90 ngày) — AGENTS.md dev tip đã spec sẵn |
| DB: batch study-reminder sync | ✓ `upsertPendingJobs` — 1 SELECT cho cả user thay vì findOne+save per session |
| DB: Zalo report cron pre-query | ✓ `listUserIdsWithSentReportToday` → 1 query thay N query per user |
| Discord/Zalo multi-pod chat history | ❌ In-memory only (Redis optional for Messenger) |
| Project-wide gaps (link, reports, reminders, ops) | Roadmap — [edge-cases-roadmap.md](docs/edge-cases-roadmap.md) |

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
