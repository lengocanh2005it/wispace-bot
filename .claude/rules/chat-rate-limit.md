---
alwaysApply: false
paths: apps/messenger-bot/src/modules/chat-rate-limit/**
---

# Chat rate limit module

FREE_FORM quota for bidirectional AI chat. V1 + hardening **H1–H7 ✓**.

**Core reserve/refund/daily-limit** (SQL atomic, `chat_daily_usage`/`chat_idempotency`) has been moved to `packages/chat-metering` (`ChatRateLimitCore` + `ChatRateLimitRepository`), shared with `apps/discord-bot` (platform='discord'). Files in this module (`ChatRateLimitRepository` infra) are now a **thin wrapper** around the core package (platform='messenger') — whitelist, quota-event audit (`chat_quota_events`), burst Redis, ops recovery/CLI **remain in messenger-bot**, not present in Discord. See `.claude/rules/clean-architecture.md` section `packages/chat-metering`.

Raw TypeORM `UPDATE`/`DELETE` results are `[rows, affected]`; repository code that reads `RETURNING` rows must unwrap that tuple before indexing or iterating.

## Flow (hook reserve)

```
Webhook text → MessengerChatEnqueueService.enqueue → debounce flush
  → ChatRateLimitService.reserveFreeFormSlot (DB idempotency + daily usage, hard cap H3)
  → MessengerAgentService → Send API
  → markCompleted; error before first bubble → refund (H4)
```

Reserve is **not** called from webhook — only from `MessengerChatProcessorService` on flush.

Menu postback, reminder cron, proactive reports do **not** go through this module.

## Config (`.env`)

| Group          | Main variables                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| Enable/disable | `CHAT_RATE_LIMIT_ENABLED`, `CHAT_RATE_LIMIT_WHITELIST_PSIDS`                                          |
| Limit          | `CHAT_FREE_FORM_DAILY_LIMIT`, `CHAT_BURST_PER_MINUTE`, `CHAT_BURST_STORE` (R3), `CHAT_USAGE_TIMEZONE` |
| H2 stuck       | `CHAT_IDEMPOTENCY_STUCK_RESERVED_MS`                                                                  |
| H5 abuse       | `CHAT_MERGED_TEXT_MAX_CHARS`, `CHAT_BURST_COUNT_REFUNDED`                                             |
| H6 ops         | `CHAT_IDEMPOTENCY_RETENTION_DAYS`                                                                     |
| C2 Q0          | `CHAT_QUOTA_EVENTS_ENABLED`, `CHAT_QUOTA_EVENTS_RETENTION_DAYS`, `chat-quota:rebuild`                 |
| UX             | `CHAT_QUOTA_REMAINING_HINT_THRESHOLD`                                                                 |

Adding a new variable → update `.env.example`.

## Main files (Clean Architecture)

| File                                                       | Layer          | Role                                                      |
| ---------------------------------------------------------- | -------------- | --------------------------------------------------------- |
| `application/services/chat-rate-limit.service.ts`          | application    | checkQuota, reserve, refund, markCompleted, recover stuck |
| `application/services/chat-rate-limit-config.service.ts`   | application    | Read env, whitelist                                       |
| `infrastructure/persistence/chat-rate-limit.repository.ts` | infrastructure | Transaction idempotency + UPSERT count (H3 hard cap)      |
| `infrastructure/persistence/*-chat-burst-counter.ts`       | infrastructure | Burst counter memory/postgres/redis (R3)                  |
| `domain/repositories/chat-rate-limit.repository.port.ts`   | domain         | Port + token `CHAT_RATE_LIMIT_REPOSITORY`                 |

**Consumer:** `MessengerChatProcessorService` injects `ChatRateLimitService` (imports `ChatRateLimitModule`).

## Existing hardening (do not regress)

| Phase | Behavior                                                                 |
| ----- | ------------------------------------------------------------------------ |
| H2    | `mid` conflict → `recoverIdempotencyForRetry`; stuck `reserved` → refund |
| H3    | `reserveFreeFormSlotInTransaction` — `WHERE free_form_count < limit`     |
| H4    | Quota policy at queue service (partial send does not refund)             |
| H5    | Cap merge text; burst does not count `refunded` by default               |
| H6    | Log `CHAT_QUOTA_DENY` / `REFUND` / `RECOVERED`; cleanup script           |

## Ops scripts

```bash
npm run chat-quota:status
npm run chat-quota:recover-stuck -- --dry-run
npm run chat-quota:cleanup -- --dry-run
```

## Tests

- `application/services/chat-rate-limit.service.spec.ts`
- `infrastructure/persistence/chat-rate-limit.repository.spec.ts`
- Modify reserve/refund/hard cap → update corresponding spec

## Documentation

`apps/messenger-bot/docs/chat-rate-limit-quota.md` — architecture, §5.10 H1–H7, runbook.
