# @wispace/zalo-bot

Zalo Official Account bot — chat via `@wispace/llm-agent`, account-linking Zalo Login ↔ WISPACE userId (PKCE OAuth2), auto-refreshing OA token lifecycle with at-rest encryption.

See the full design at [docs/superpowers/specs/2026-07-20-zalo-bot-mvp-design.md](../../docs/superpowers/specs/2026-07-20-zalo-bot-mvp-design.md) and the implementation plan at [docs/superpowers/plans/2026-07-20-zalo-bot-mvp.md](../../docs/superpowers/plans/2026-07-20-zalo-bot-mvp.md).

## Current status

**Already done:**
- Chat via `POST /v1/zalo/webhook` (X-ZEvent-Signature verify + timestamp freshness), debounce queue, pending cap, user feedback, queued-failure fallback, and memory/Redis history.
- Quota/rate-limit + LLM usage/safety persistence via `@wispace/chat-metering` (platform='zalo'); stuck-reserved recovery + idempotency cleanup crons.
- 7/7 real WISPACE tools via `@wispace/wispace-client` (header `x-zaloid`): `get_user_goals`, `get_learning_progress_report`, `get_upcoming_study_sessions`, `list_study_calendar_entries`, `preview_next_study_reminder`, `reschedule_study_session`, `precreate_next_exercise`.
- Account linking via Zalo Login PKCE OAuth2 (`GET /v1/zalo/oauth/authorize` + `/callback`) → shared `WISPACE_API_VERIFY_TOKEN_URL`.
- OA access-token lifecycle: `zalo_oa_tokens` (AES-256-GCM encrypted at rest, `version` CAS), proactive refresh cron (default every 45 min).
- 08:00 report cron with LLM enrichment (`ZaloStudentReportService`), study reminders (shared `@wispace/study-reminder-shared`), durable webhook inbox + retry/cleanup, outbound dead-letter retry, message-log cleanup, report-claims retention — all advisory-locked.
- Ops endpoints `POST /v1/zalo/{send-reports, study-calendar/sync, sync-study-reminders, ops/doppler-sync}` + `GET /metrics` — `InternalApiKeyGuard`.
- Health endpoints (shared `HealthController`): `/health` public liveness, `/health/ready` public readiness, `/health/detail` internal.
- CI/CD: `deploy-bots.yml` job + shared `deploy/Dockerfile.bot` + VPS self-pull deploy.

**Not yet done / TODO:**
- `register_exam_report_notifications` — intentionally not implemented (Zalo 48h window covers active users; ZNS deferred to post-product).
- Whitelist (`CHAT_RATE_LIMIT_WHITELIST_PSIDS`) and quota-event audit table remain Messenger-only.

## Run dev

```bash
cp .env.example .env   # fill in ZALO_APP_ID, ZALO_APP_SECRET_KEY, OPENAI_API_KEY, DB_*
npx turbo run build --filter=@wispace/zalo-bot...   # build first (llm-agent is a dependency)
npm run start:dev --workspace=apps/zalo-bot
```

The app runs as an HTTP server (`PORT`, default `3002`) exposing the webhook + OAuth endpoints.

## Before first run (one-time)

Bootstrap `zalo_oa_tokens` manually (the table starts empty and the app fails closed without an encrypted pair) — see [docs/zalo-oa-token-bootstrap.md](./docs/zalo-oa-token-bootstrap.md) (`ZALO_TOKEN_ENCRYPTION_KEY` required).

## Common commands (in `apps/zalo-bot/`)

```bash
npm run start:dev
npm run build
npm run test
npm run verify   # format:check + lint + typecheck + test + build
node scripts/seed-oa-token.mjs --access-token=... --refresh-token=...   # one-time OA token bootstrap
```
