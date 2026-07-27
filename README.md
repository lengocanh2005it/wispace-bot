# wispace-bots

Turborepo monorepo — WISPACE student bots across multiple messaging platforms. Currently features **Facebook Messenger** (fully functional), **Discord** and **Zalo** (placeholder, not yet implemented), sharing a single LLM function-calling package.

## Structure

```
apps/messenger-bot/    NestJS — AI reports, study reminders, AI chat with rate limit via Messenger (fully functional)
apps/discord-bot/      Placeholder — not yet implemented (see docs/turborepo-migration-plan.md Phase 3)
apps/zalo-bot/         Placeholder — not yet implemented (see docs/turborepo-migration-plan.md Phase 4)
packages/llm-agent/    OpenAI function-calling orchestration shared across all bots (framework-agnostic)
```

## Features (Messenger bot)

- Link WISPACE students to Messenger (`m.me` + webhook)
- AI progress reports before exam day (cron + menu)
- Upcoming study session reminders (outbox jobs + LLM + cron)
- Free-form chat with **rate limit** (daily quota, burst, H1–H7 hardening)
- Wispace calls `POST /messenger/study-calendar/sync` after modifying `UserCalendar` schedule

## Documentation

| File | Description |
|------|-------------|
| [docs/turborepo-migration-plan.md](docs/turborepo-migration-plan.md) | Monorepo roadmap: Discord/Zalo bots, cross-platform DB, independent CI/CD |
| [docs/project-overview.md](docs/project-overview.md) | Architecture, code structure, DB, API, cron, quota runbook |
| [apps/messenger-bot/docs/chat-rate-limit-quota.md](apps/messenger-bot/docs/chat-rate-limit-quota.md) | Chat rate limit V1 + H1–H7 |
| [docs/edge-cases-roadmap.md](docs/edge-cases-roadmap.md) | POC-wide gaps + QA checklist + remediation phases |
| [apps/messenger-bot/docs/study-session-reminder.md](apps/messenger-bot/docs/study-session-reminder.md) | Study session reminders (detailed) |
| [AGENTS.md](AGENTS.md) | AI agent / Cursor instructions |

## Quick start (Messenger bot)

```bash
npm install                          # at root — npm workspaces resolve apps/* + packages/*
cp apps/messenger-bot/.env.example apps/messenger-bot/.env   # fill in PAGE_ACCESS_TOKEN, DB, OPENAI_API_KEY, ...
npx turbo run build --filter=@wispace/messenger-bot...
cd apps/messenger-bot
npm run migration:run
npm run start:dev
```

Meta webhook: `GET/POST /webhook`
Bot menu configuration: `POST /messenger/profile/setup`
Wispace schedule sync: `POST /messenger/study-calendar/sync` + header `X-Internal-Api-Key` (see `apps/messenger-bot/.env` `INTERNAL_API_KEY`)

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

Turborepo + npm workspaces · NestJS 11 · TypeORM · PostgreSQL (shared across bots) · OpenAI · Facebook Graph API
