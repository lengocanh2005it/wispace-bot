# wispace-bots

Turborepo monorepo — WISPACE student bots across multiple messaging platforms. Currently features **Facebook Messenger** (fully functional), **Discord** (fully functional), and **Zalo** (fully functional), sharing 18 common packages.

## Structure

```
apps/messenger-bot/    NestJS — AI reports, study reminders, AI chat via Messenger
apps/discord-bot/      NestJS — AI chat, OAuth2 account linking, report cron, study reminders
apps/zalo-bot/         NestJS — AI chat, OAuth2 account linking, report cron, study reminders

packages/llm-agent/             LLM function-calling + provider abstraction (OpenAI, OpenRouter, MiniMax)
packages/chat-metering/         Quota/rate-limit + LLM usage/safety event tracking
packages/chat-agent/            Platform-parameterized agent, queue, history services (Discord, Zalo)
packages/wispace-client/        Wispace API HTTP clients (goals, scores, calendar, token verify, next-exercise precreate)
packages/chat-history/          In-memory chat history store with TTL + turn cap
packages/student-report/        Student capacity report generation (LLM + fallback)
packages/chat-queue-core/       Per-user debounce/merge state machine
packages/chat-pipeline/         Platform-agnostic chat pipeline (reserve → history → agent → send)
packages/study-reminder-shared/ Study reminder dispatch/sync/worker services
packages/scheduler-core/        Report cron scheduling + leader election
packages/bot-metrics/           Prometheus metrics (prom-client)
packages/cleanup-cron/          Advisory-lock cleanup cron service
packages/ops-health/            Ops health snapshot + alerts
packages/reschedule-confirm/    Generic reschedule confirmation service
packages/bot-common/            Shared NestJS infrastructure: ops API guard, advisory locks, Vault bootstrap
packages/database/              Shared TypeORM entities + migrations
packages/doppler-sync/          Doppler runtime secret sync helpers
packages/date-utils/            Timezone-aware date helpers (date-fns)
```

## Features

**All bots:**

- Free-form AI chat with rate limit (daily quota, burst, H1–H7 hardening)
- AI progress reports (cron 08:00 + menu)
- Study session reminders (outbox jobs + LLM + cron)
- Multi-LLM provider failover (OpenAI → OpenRouter → MiniMax)
- Next roadmap exercise creation via chat (`precreate_next_exercise` tool → WISPACE `roadmap/precreate-exercise` API)

**Messenger:** Webhook routing, Get Started referral, persistent menu, `m.me` linking, daily report cache (no nested LLM calls)
**Discord:** DMs and `@mentions`, OAuth2 account linking (committed at callback), link-status endpoint, report/study quick actions
**Zalo:** OA account linking, OAuth2 (PKCE), webhook signature verification, OA token at-rest encryption, reports/reminders

## Documentation

| File                                                                                                   | Description                                                |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| [docs/turborepo-migration-plan.md](docs/turborepo-migration-plan.md)                                   | Monorepo roadmap: cross-platform DB, independent CI/CD     |
| [docs/project-overview.md](docs/project-overview.md)                                                   | Architecture, code structure, DB, API, cron, quota runbook |
| [docs/vault-secrets.md](docs/vault-secrets.md)                                                         | Vault runtime secret contract and bootstrap runbook         |
| [apps/messenger-bot/docs/chat-rate-limit-quota.md](apps/messenger-bot/docs/chat-rate-limit-quota.md)   | Chat rate limit V1 + H1–H7                                 |
| [docs/edge-cases-roadmap.md](docs/edge-cases-roadmap.md)                                               | Project-wide gaps + QA checklist + remediation phases      |
| [apps/messenger-bot/docs/study-session-reminder.md](apps/messenger-bot/docs/study-session-reminder.md) | Study session reminders (detailed)                         |
| [AGENTS.md](AGENTS.md)                                                                                 | AI agent / Cursor instructions                             |

## Quick start (Messenger bot)

```bash
npm install                          # at root — npm workspaces resolve apps/* + packages/*
cp apps/messenger-bot/.env.example apps/messenger-bot/.env   # fill in PAGE_ACCESS_TOKEN, DB, OPENAI_API_KEY, ...
npx turbo run build --filter=@wispace/messenger-bot...
cd apps/messenger-bot
npm run migration:run
npm run start:dev
```

Meta webhook: `GET/POST /v1/webhook`
Bot menu configuration: `POST /v1/messenger/profile/setup`
Wispace schedule sync: `POST /v1/messenger/study-calendar/sync` + header `X-Internal-Api-Key` (see `apps/messenger-bot/.env` `INTERNAL_API_KEY`)

Production binds each bot to localhost only: Messenger `5007`/`5008`, Discord `3001`/`3004`, and Zalo `3002`/`3003` for blue-green deploys. Nginx exposes the public HTTPS endpoints; direct container ports are not internet-facing. `GET /health` is public liveness, `GET /health/ready` is public status-only readiness, and `GET /health/detail` plus `/metrics` require `X-Internal-Api-Key`.

Normal deploys build and push a shared `deploy/Dockerfile.bot` image to GHCR; the VPS self-pull cron deploys the commit image. Production environment changes use the manual `sync-env.yml` workflow with Doppler. Containers do not mount the host Docker socket.

## Useful scripts (run in `apps/messenger-bot/`)

```bash
npm run study-reminder:sync      # Bootstrap + sync study reminder jobs
npm run study-reminder:jobs      # View study_reminder_jobs (--failed, --stuck)
npm run ops:health               # I1+S1 ops snapshot
npm run chat-quota:status        # Query chat quota (--ops = fleet summary)
npm run chat-quota:recover-stuck # H2: refund stuck reserved
npm run chat-quota:cleanup       # H6: cleanup old idempotency records
npm run db:inspect
```

## Verify entire monorepo

```bash
npx turbo run format:check lint typecheck test build
```

## Stack

Turborepo + npm workspaces · NestJS 11 · TypeORM · PostgreSQL (shared across bots) · Redis (optional) · OpenAI + OpenRouter + MiniMax · Facebook Graph API · Discord.js · Zalo OA API
