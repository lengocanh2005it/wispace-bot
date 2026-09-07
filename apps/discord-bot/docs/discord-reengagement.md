# Discord re-engagement (D11 inactive-learner DM)

Runbook for the re-engagement feature (#850, sub-issues #851–#855): the bot
DMs learners inactive ≥ 11 days a backend-rendered report (embeds + CTA
buttons). **All learner-facing content is rendered by the WISPACE backend** —
this repo authors no message text.

## Components

| Piece                            | Where                         | Role                                                                                                                           |
| -------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `ReengagementApiClient`          | `@wispace/wispace-client`     | `GET /candidates`, `GET /payload/{userId}`, `POST /mark-sent` (`X-Internal-Key` only; GETs retry 5xx, mark-sent never retries) |
| `sendProactivePayload`           | `discord-outbound.service.ts` | Proactive embed+components DM; never throws; payload pass-through with `allowedMentions` locked empty                          |
| `DiscordReengagementService`     | `discord-reengagement/`       | Orchestration for one learner: mapping → payload → DM → mark-sent                                                              |
| `DiscordReengagementCronService` | `discord-reengagement/`       | Daily D11 scan + batch dispatch                                                                                                |

## Semantics that must not regress

- **Dormancy gate carve-out (#595):** this path NEVER consults
  `WebActivityService.filterDormant` — every candidate is dormant by
  definition. A regression test pins the exemption.
- **Consent (#596):** scheduled reports are opt-in (`report_enabled`, NULL =
  off). The batch filters candidates bot-side via
  `NotificationPreferenceService.findReportOptedInUserIds` (the preference
  table lives in the bot DB, so the backend cannot filter it). The manual
  run-once trigger does not check consent (explicit operator action, like
  `forceSend`).
- **Suppression:** the backend owns the suppression rule (mark-sent arms it);
  the bot keeps no local sent-state.
- **Privacy:** re-engagement owns zero state beyond the existing
  `report_enabled` preference row, which `PrivacyDataService` erasure already
  covers (#596/#850). No new erasable state was introduced.
- **Ambiguous sends mark SUCCESS** (anti-duplicate bias): marking FAILED
  would leave suppression unarmed and risk a duplicate DM next cycle. The
  worst case of SUCCESS is the learner missing one re-engagement touch.

## Delivery outcome → mark-sent mapping

| DM outcome                                   | mark-sent status                      | Metric (`discord_reengagement_send_total`) |
| -------------------------------------------- | ------------------------------------- | ------------------------------------------ |
| `sent`                                       | SUCCESS + messageId                   | `sent`                                     |
| `ambiguous`                                  | SUCCESS (no id)                       | `ambiguous`                                |
| `not_sent` (incl. blocked DM 50007)          | FAILED                                | `failed`                                   |
| `rate_limited` (outbound cap)                | FAILED                                | `rate_limited`                             |
| mark-sent call itself failed after a sent DM | retried next cycle by suppression lag | `mark_sent_error`                          |
| payload 401/404/5xx/malformed, not linked    | no mark-sent call                     | `failed`                                   |

## Env vars (`apps/discord-bot/.env.example`)

`REENGAGEMENT_ENABLED` (**default off**), `REENGAGEMENT_CRON`
(default `0 9 * * *`), `REENGAGEMENT_TIMEZONE` (default
`Asia/Ho_Chi_Minh`), `REENGAGEMENT_DAYS` (11), `REENGAGEMENT_LIMIT` (50;
endpoint caps at 200), `REENGAGEMENT_MAX_PER_BATCH` (100 — ceiling, the
endpoint has no cursor), `REENGAGEMENT_SEND_GAP_MS` (500 — pacing between
sequential sends), `REENGAGEMENT_DRY_RUN` (false).

## Operations

- **Dry-run first:** set `REENGAGEMENT_DRY_RUN=true`, enable
  `REENGAGEMENT_ENABLED=true`, deploy — the batch scans and logs
  `[DRY-RUN] would send …` per candidate without DMing anyone.
- **Manual single-user test (no 11-day wait):**
  `POST /v1/discord/reengagement/run-once` with header
  `X-Internal-Api-Key: $INTERNAL_API_KEY` and body `{"userId": 42}` →
  `{ outcome, reason?, messageId?, markSent? }`. Consent is NOT checked on
  this trigger.
- **Prod enablement:** `REENGAGEMENT_DRY_RUN=false` +
  `REENGAGEMENT_ENABLED=true` in Vault (per-bot discord path), deploy, then
  check the batch log line `Re-engagement batch done: …`.
- **Observability:** `discord_reengagement_send_total{outcome}` (+ batch
  gauges), heartbeat `discord-reengagement-batch` feeds the existing
  `CronExecutionStale` alert (24h interval). Per the repo's alert contract,
  delivery failures here are a deliberate no-alert family — watch the
  counters, don't page on them.
- **Batch behavior:** advisory lock `DISCORD_REENGAGEMENT` (884_200_950) —
  contention logs and skips; one candidate failure never aborts the batch;
  over-ceiling candidates are warned and left for the next day (backend
  suppression dedupes).
