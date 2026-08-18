# @wispace/discord-bot

Discord bot for WISPACE — uses [Necord](https://necord.org/) (NestJS wrapper around `discord.js`) + `@wispace/llm-agent` (shared LLM function-calling orchestration used by all bots).

See the full plan at [docs/turborepo-migration-plan.md](../../docs/turborepo-migration-plan.md) — Phase 3.

## Current status

**Already done:**

- Bot online via Necord, receives DMs + @mentions in server channels (replies via DM), prompt-injection protection, redirects out-of-scope WISPACE requests, and configurable memory/Redis conversation history.
- Quota/rate-limit + LLM usage/safety event persistence shared via `@wispace/chat-metering` (platform='discord') — see `modules/chat-metering/`.
- Account-linking Discord ↔ WISPACE userId via OAuth2 (`GET /v1/discord/oauth/callback`), committed at callback independent of guild membership; portal join hint via `GET /v1/discord/link-status?userId=` — see [docs/discord-account-linking.md](docs/discord-account-linking.md).
- 7/7 WISPACE tools call real Wispace API via `@wispace/wispace-client` (header `x-discordid`): `get_user_goals`, `get_learning_progress_report`, `get_upcoming_study_sessions`, `list_study_calendar_entries`, `preview_next_study_reminder`, `reschedule_study_session`, and `precreate_next_exercise` (confirm/cancel via Discord button where applicable).
- `GET /health/ready` for deploy readiness gate (public, status-only); `/health/detail` + `/metrics` guarded by `X-Internal-Api-Key`.
- Custom prompt: `src/shared/prompts/discord-chat.system.txt`.
- CI/CD deploy VPS — shared GHCR image + VPS self-pull blue-green workflow (`deploy-bots.yml` + `deploy/Dockerfile.bot`), exercised in production.
- 08:00 report cron + `*/15` retry dispatch (lease-based leader election), study reminders (shared `@wispace/study-reminder-shared`), outbound dead-letter retry, message-log cleanup, idempotency stuck recovery/cleanup, report-claims retention — all advisory-locked.
- Queued chat failure fallback + pending-message cap (`CHAT_MAX_PENDING_MESSAGES`) + typing indicator + user feedback ("Đang xử lý tin nhắn trước...").

**Not yet done / TODO:**

- `register_exam_report_notifications` — intentionally not implemented; Discord has no 24h messaging limit so the 08:00 report cron works without opt-in.
- Whitelist (`CHAT_RATE_LIMIT_WHITELIST_PSIDS`) and quota-event audit table remain Messenger-only.

## Run dev

```bash
cp .env.example .env   # fill in DISCORD_BOT_TOKEN + OPENAI_API_KEY
npx turbo run build --filter=@wispace/discord-bot...   # build first (llm-agent is a dependency)
npm run start:dev --workspace=apps/discord-bot
```

The bot needs the following intents enabled in the Discord Developer Portal (Bot settings):

- `MESSAGE CONTENT INTENT` — read DM content and messages with @mentions ✅
- `SERVER MEMBERS INTENT` — receive `guildMemberAdd` event for auto-complete account link ✅

The app runs as an HTTP server (`PORT`, default `3001`) to expose `GET /v1/discord/oauth/callback` for account-linking.

## Common commands (in `apps/discord-bot/`)

```bash
npm run start:dev
npm run build
npm run test
npm run verify   # format:check + lint + typecheck + test + build
```
