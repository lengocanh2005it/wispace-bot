# General conventions — wispace-bots (Turborepo monorepo)

Turborepo monorepo: `apps/messenger-bot` (NestJS, full-featured) + `apps/discord-bot`/`apps/zalo-bot` (fully functional) + `packages/llm-agent` (shared LLM function-calling). Messenger webhook + AI reports + study reminders + **rate-limited AI chat** for WISPACE.

**Read more:** `.claude/rules/clean-architecture.md` — mandatory when adding/modifying code in `apps/*/src/modules/` or `packages/llm-agent/`.

## Principles

- Small diffs; correct Clean Architecture layer (domain / application / infrastructure / presentation) within each app.
- Config via `.env` + `ConfigService` — no hardcoded tokens/time values. A
  conservative operational default is allowed only when the value is exposed
  as an environment override and documented in the relevant `.env.example`.
  Security invariants (for example, the OAuth state future-clock skew bound)
  may remain fixed when an override could weaken the trust boundary; document
  the rationale beside the constant.
- User-facing messages: **Vietnamese**. Logs/comments: English or short Vietnamese.
- Do not add Redis/Bull/SQS unless the user requests it — outbox = `study_reminder_jobs`; shared chat queue = PostgreSQL (H7).
- `packages/llm-agent` has no NestJS dependency — only port interfaces + `openai`. Business logic (Wispace API, DB) stays in the app.

## Module boundaries (in `apps/messenger-bot`)

| Module                     | Responsibilities only                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `modules/messenger/`       | Webhook, Send API (outbound), menu, chat queue/agent (adapter uses `@wispace/llm-agent`), mapping/logs |
| `modules/chat-rate-limit/` | FREE_FORM quota: reserve/refund/burst, DB idempotency                                                  |
| `modules/student-report/`  | Study reports, Wispace API goals/scores                                                                |
| `modules/study-reminder/`  | Sync/dispatch/cleanup jobs, UserCalendar API                                                           |
| `modules/scheduler/`       | Report cron + HTTP ops trigger                                                                         |

**Do not** put study reminder logic in `MessengerService`. **Do not** reserve quota in webhook — only in `MessengerChatProcessorService` flush.

## Auth & API

- Wispace API: send `x-psid` (Messenger), `x-discordid` (Discord), or `x-zaloid` (Zalo) plus `X-Internal-Key` (`WISPACE_INTERNAL_KEY`).
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

1. **Update agent docs** if behavior/API/env/runbook changes — see table in `AGENTS.md` section _Docs & skills when changing code_.
2. **Update skills** in `.claude/skills/` if debug/verify/migration/prompt workflows are affected.
3. **Run quality gate** before reporting task complete (requires full `npm install` at root with dev deps):

**Full repository gate** (same definition used for trusted pushes and scheduled CI):

```bash
npm run verify
```

The pull-request lane runs the same root checks and narrows only workspace typecheck/test/build to changed packages:

```bash
npm run verify:affected
```

The scheduled lane runs the full gate without Turbo cache reuse: `npm run verify -- --force`. All three entry points delegate to `scripts/verify.mjs`.

**Note:** test = Jest unit specs (`**/*.spec.ts` in each app/package). `'jest' is not recognized` or `'turbo' is not recognized` errors → run `npm install` at root again (don't use `npm ci --omit=dev` before testing).

## Quick ops (chat quota, run in `apps/messenger-bot/`)

```bash
npm run chat-quota:status
npm run chat-quota:recover-stuck
npm run chat-quota:cleanup
```
