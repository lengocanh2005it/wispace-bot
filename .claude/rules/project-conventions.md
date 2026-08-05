# General conventions — wispace-bots (Turborepo monorepo)

Turborepo monorepo: `apps/messenger-bot` (NestJS, full-featured) + `apps/discord-bot`/`apps/zalo-bot` (placeholders) + `packages/llm-agent` (shared LLM function-calling). Messenger webhook + AI reports + study reminders + **rate-limited AI chat** for WISPACE.

**Read more:** `.claude/rules/clean-architecture.md` — mandatory when adding/modifying code in `apps/*/src/modules/` or `packages/llm-agent/`.

## Principles

- Small diffs; correct Clean Architecture layer (domain / application / infrastructure / presentation) within each app.
- Config via `.env` + `ConfigService` — no hardcoded tokens/time values.
- User-facing messages: **Vietnamese**. Logs/comments: English or short Vietnamese.
- Do not add Redis/Bull/SQS unless the user requests it — outbox = `study_reminder_jobs`; shared chat queue = PostgreSQL (H7).
- `packages/llm-agent` has no NestJS dependency — only port interfaces + `openai`. Business logic (Wispace API, DB) stays in the app.

## Module boundaries (in `apps/messenger-bot`)

| Module | Responsibilities only |
|--------|----------------------|
| `modules/messenger/` | Webhook, Send API (outbound), menu, chat queue/agent (adapter uses `@wispace/llm-agent`), mapping/logs |
| `modules/chat-rate-limit/` | FREE_FORM quota: reserve/refund/burst, DB idempotency |
| `modules/student-report/` | Study reports, Wispace API goals/scores |
| `modules/study-reminder/` | Sync/dispatch/cleanup jobs, UserCalendar API |
| `modules/scheduler/` | Report cron + HTTP ops trigger |

**Do not** put study reminder logic in `MessengerService`. **Do not** reserve quota in webhook — only in `MessengerChatQueueService` flush.

## Auth & API

- Wispace API: headers `x-psid` (Messenger PSID) + `X-Internal-Key` (`WISPACE_INTERNAL_KEY`).
- Ops HTTP: `X-Internal-Api-Key` or `Authorization: Bearer` = `INTERNAL_API_KEY`.
- Do not commit `.env`.

## Documentation

- Architecture: `.claude/rules/clean-architecture.md`
- Monorepo roadmap (Discord/Zalo, multi-platform DB, independent CI/CD): `docs/turborepo-migration-plan.md`
- Messenger bot overview: `docs/project-overview.md`
- Chat rate limit: `apps/messenger-bot/docs/chat-rate-limit-quota.md` — rule: `.claude/rules/chat-rate-limit.md`
- Study reminders: `apps/messenger-bot/docs/study-session-reminder.md`
- General agent docs: `AGENTS.md`

## When modifying code (mandatory)

1. **Update agent docs** if behavior/API/env/runbook changes — see table in `AGENTS.md` section *Docs & skills when changing code*.
2. **Update skills** in `.claude/skills/` if debug/verify/migration/prompt workflows are affected.
3. **Run quality gate** before reporting task complete (requires full `npm install` at root with dev deps):

**CI / deploy** (matches `.github/workflows/pull-request.yml` `npm run verify`, runs for all workspaces):

```bash
npx turbo run lint --filter=@wispace/messenger-bot...
npx turbo run test --filter=@wispace/messenger-bot...
npx turbo run build --filter=@wispace/messenger-bot...
```

**Full local** (entire workspace, adds format + typecheck):

```bash
npx turbo run format
npx turbo run verify          # format:check + lint + typecheck + test + build, all apps/packages
```

**Note:** test = Jest unit specs (`**/*.spec.ts` in each app/package). `'jest' is not recognized` or `'turbo' is not recognized` errors → run `npm install` at root again (don't use `npm ci --omit=dev` before testing).

## Quick ops (chat quota, run in `apps/messenger-bot/`)

```bash
npm run chat-quota:status
npm run chat-quota:recover-stuck
npm run chat-quota:cleanup
```
